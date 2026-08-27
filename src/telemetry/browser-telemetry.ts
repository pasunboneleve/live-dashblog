import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { parseTraceparent } from "../domain/trace-context";
import { PublicOtlpHttpExporter } from "./browser-otlp-exporter";
import { installBrowserTelemetryHooks } from "./browser-telemetry-hooks";

const MAX_PUBLIC_INTERACTIONS = 4;
export const MAX_PARENTED_STREAM_CONNECTIONS = 2;

export function shouldParentStreamConnection(connectionCount: number): boolean {
  return connectionCount > 0 && connectionCount <= MAX_PARENTED_STREAM_CONNECTIONS;
}

/** Boots the observability article's explicit OpenTelemetry graph from its Worker parent. */
export function initializeBrowserTelemetry(): void {
  const remote = parseTraceparent(
    document.querySelector<HTMLMetaElement>('meta[name="traceparent"]')?.content ?? null,
  );
  const admissionToken = document.querySelector<HTMLMetaElement>(
    'meta[name="public-trace-admission"]',
  )?.content;
  if (!remote || !admissionToken) return;

  const exporter = new PublicOtlpHttpExporter(admissionToken);
  const provider = new WebTracerProvider({
    spanLimits: { attributeCountLimit: 4, attributeValueLengthLimit: 64 },
    spanProcessors: [new BatchSpanProcessor(exporter, {
      exportTimeoutMillis: 4_000,
      maxExportBatchSize: 16,
      maxQueueSize: 64,
      scheduledDelayMillis: 750,
    })],
  });
  const tracer = provider.getTracer("live-dashblog-browser", "1");
  const remoteContext = trace.setSpanContext(ROOT_CONTEXT, {
    isRemote: true,
    spanId: remote.parentSpanId!,
    traceFlags: Number.parseInt(remote.traceFlags, 16) & TraceFlags.SAMPLED,
    traceId: remote.traceId,
  });
  const documentSpan = tracer.startSpan("browser.document-load", {
    attributes: { "app.route_class": "article" },
    kind: SpanKind.INTERNAL,
    startTime: documentLoadStart(),
  }, remoteContext);
  documentSpan.setStatus({ code: SpanStatusCode.OK });
  documentSpan.end();
  const documentContext = trace.setSpan(ROOT_CONTEXT, documentSpan);
  const hydration = tracer.startSpan("browser.hydration", {
    attributes: { "app.route_class": "article" },
    kind: SpanKind.INTERNAL,
  }, documentContext);

  let interactionCount = 0;
  let streamConnectionCount = 0;
  let hydrationEnded = false;
  installBrowserTelemetryHooks({
    fetch: (input, init) => traceFetch(tracer, documentContext, input, init),
    recordFinalPaint: () => recordLocalSpan(tracer, documentContext, "browser.final-paint.local-only"),
    recordHydrationComplete: () => {
      if (hydrationEnded) return;
      hydrationEnded = true;
      hydration.setStatus({ code: SpanStatusCode.OK });
      hydration.end();
    },
    recordInteraction: (interactionClass) => {
      if (interactionCount >= MAX_PUBLIC_INTERACTIONS) return;
      interactionCount += 1;
      const span = tracer.startSpan("browser.article-interaction", {
        attributes: {
          "app.interaction_class": interactionClass,
          "app.route_class": "article",
        },
        kind: SpanKind.INTERNAL,
      }, documentContext);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    },
    recordReducerApplication: () => recordLocalSpan(
      tracer,
      documentContext,
      "browser.reducer-apply.local-only",
    ),
    webSocket: (url) => {
      streamConnectionCount += 1;
      return shouldParentStreamConnection(streamConnectionCount)
        ? traceWebSocket(tracer, documentContext, url)
        : new WebSocket(url);
    },
  });

  window.addEventListener("pagehide", () => {
    void provider.forceFlush();
  }, { once: true });
}

async function traceFetch(
  tracer: Tracer,
  parentContext: Context,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const span = tracer.startSpan("browser.snapshot-fetch", {
    attributes: { "app.route_class": "snapshot" },
    kind: SpanKind.CLIENT,
  }, parentContext);
  try {
    const headers = new Headers(init?.headers);
    headers.set("traceparent", traceparentFor(span));
    const response = await fetch(input, { ...init, headers });
    span.setStatus({ code: response.status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
    return response;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

function traceWebSocket(tracer: Tracer, parentContext: Context, url: URL): WebSocket {
  const span = tracer.startSpan("browser.stream-connect", {
    attributes: { "app.route_class": "stream" },
    kind: SpanKind.CLIENT,
  }, parentContext);
  url.searchParams.set("traceparent", traceparentFor(span));
  const socket = new WebSocket(url);
  let ended = false;
  const end = (status: SpanStatusCode) => {
    if (ended) return;
    ended = true;
    span.setStatus({ code: status });
    span.end();
  };
  socket.addEventListener("open", () => end(SpanStatusCode.OK), { once: true });
  socket.addEventListener("error", () => end(SpanStatusCode.ERROR), { once: true });
  socket.addEventListener("close", () => end(SpanStatusCode.ERROR), { once: true });
  return socket;
}

function recordLocalSpan(tracer: Tracer, parentContext: Context, name: string): void {
  const span = tracer.startSpan(name, { kind: SpanKind.INTERNAL }, parentContext);
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

function traceparentFor(span: Span): string {
  const context = span.spanContext();
  const flags = context.traceFlags.toString(16).padStart(2, "0");
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

function documentLoadStart(): number {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return performance.timeOrigin + (navigation?.responseEnd ?? 0);
}
