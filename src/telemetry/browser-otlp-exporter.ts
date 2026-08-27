import { SpanKind, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

const PUBLIC_BROWSER_SPAN_NAMES = new Set([
  "browser.document-load",
  "browser.hydration",
  "browser.snapshot-fetch",
  "browser.stream-connect",
  "browser.article-interaction",
]);
const PUBLIC_BROWSER_ATTRIBUTE_KEYS = new Set(["app.interaction_class", "app.route_class"]);

type ExportCallback = Parameters<SpanExporter["export"]>[1];
type Fetcher = typeof globalThis.fetch;

/** Emits the strict browser subset as OTLP/HTTP JSON to the same origin. */
export class PublicOtlpHttpExporter implements SpanExporter {
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly admissionToken: string,
    private readonly endpoint = "/api/observability/v1/traces",
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {}

  export(spans: ReadableSpan[], resultCallback: ExportCallback): void {
    if (this.stopped) {
      resultCallback({ code: 1, error: new Error("Public OTLP exporter is shut down") });
      return;
    }
    const payload = serializePublicOtlpJson(spans);
    if (payload === null) {
      resultCallback({ code: 0 });
      return;
    }
    const request = this.fetcher(this.endpoint, {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "x-live-dashblog-trace-admission": this.admissionToken,
      },
      keepalive: true,
      method: "POST",
    }).then((response) => {
      if (!response.ok) throw new Error(`Public OTLP intake returned ${response.status}`);
      resultCallback({ code: 0 });
    }).catch((error: unknown) => {
      resultCallback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) });
    }).finally(() => {
      this.pending.delete(request);
    });
    this.pending.add(request);
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.forceFlush();
  }
}

export function serializePublicOtlpJson(spans: readonly ReadableSpan[]): unknown | null {
  const publicSpans = spans
    .filter((span) => PUBLIC_BROWSER_SPAN_NAMES.has(span.name))
    .slice(0, 32)
    .map((span) => ({
      attributes: serializeAttributes(span.attributes),
      endTimeUnixNano: hrTimeToNanos(span.endTime),
      kind: otlpKind(span.kind),
      name: span.name,
      ...(span.parentSpanContext ? { parentSpanId: hexToBase64(span.parentSpanContext.spanId) } : {}),
      spanId: hexToBase64(span.spanContext().spanId),
      startTimeUnixNano: hrTimeToNanos(span.startTime),
      status: { code: otlpStatus(span.status.code) },
      traceId: hexToBase64(span.spanContext().traceId),
    }));
  if (publicSpans.length === 0) return null;
  return {
    resourceSpans: [{
      resource: { attributes: [otlpAttribute("service.name", "live-dashblog-browser")] },
      scopeSpans: [{
        scope: { name: "live-dashblog-browser", version: "1" },
        spans: publicSpans,
      }],
    }],
  };
}

function serializeAttributes(attributes: Attributes) {
  return Object.entries(attributes).flatMap(([key, value]) =>
    PUBLIC_BROWSER_ATTRIBUTE_KEYS.has(key) && typeof value === "string"
      ? [otlpAttribute(key, value)]
      : []
  );
}

function otlpAttribute(key: string, stringValue: string) {
  return { key, value: { stringValue } };
}

function hrTimeToNanos(time: readonly [number, number]): string {
  return (BigInt(time[0]) * 1_000_000_000n + BigInt(time[1])).toString();
}

function hexToBase64(value: string): string {
  const bytes = value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [];
  return btoa(String.fromCharCode(...bytes));
}

function otlpKind(kind: SpanKind): "SPAN_KIND_CLIENT" | "SPAN_KIND_INTERNAL" {
  return kind === SpanKind.CLIENT ? "SPAN_KIND_CLIENT" : "SPAN_KIND_INTERNAL";
}

function otlpStatus(code: SpanStatusCode): "STATUS_CODE_UNSET" | "STATUS_CODE_OK" | "STATUS_CODE_ERROR" {
  if (code === SpanStatusCode.ERROR) return "STATUS_CODE_ERROR";
  if (code === SpanStatusCode.OK) return "STATUS_CODE_OK";
  return "STATUS_CODE_UNSET";
}
