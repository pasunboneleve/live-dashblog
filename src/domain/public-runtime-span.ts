import { publicSpanSchema, type PublicSpan } from "./public-span";
import {
  createTraceContext,
  formatTraceparent,
  type RandomBytes,
  type TraceContext,
} from "./trace-context";

export type PublicServerOperation = "article" | "snapshot" | "stream";
export type PublicDurableObjectOperation = "snapshot" | "stream-connect";

export interface StartedPublicSpan {
  context: TraceContext;
  startedAtUnixMs: number;
  traceparent: string;
}

export function startPublicSpan(
  parentTraceparent: string | null,
  startedAtUnixMs: number,
  randomBytes?: RandomBytes,
): StartedPublicSpan {
  const context = createTraceContext(parentTraceparent, randomBytes);
  return { context, startedAtUnixMs, traceparent: formatTraceparent(context) };
}

export function finishWorkerSpan(
  operation: PublicServerOperation,
  started: StartedPublicSpan,
  responseStatus: number,
  endedAtUnixMs: number,
): PublicSpan {
  const identity = finishIdentity(started, responseStatus, endedAtUnixMs);
  if (operation === "article") {
    return publicSpanSchema.parse({
      ...identity,
      attributes: {
        cacheClass: "unknown",
        routeClass: "article",
        statusClass: statusClass(responseStatus),
      },
      kind: "SERVER",
      name: "worker.article-request",
      runtimeSide: "worker",
      serviceName: "live-dashblog-worker",
    });
  }
  return publicSpanSchema.parse({
    ...identity,
    attributes: { routeClass: operation, statusClass: statusClass(responseStatus) },
    kind: "SERVER",
    name: operation === "snapshot" ? "worker.snapshot-request" : "worker.stream-request",
    runtimeSide: "worker",
    serviceName: "live-dashblog-worker",
  });
}

export function finishDurableObjectSpan(
  operation: PublicDurableObjectOperation,
  started: StartedPublicSpan,
  responseStatus: number,
  endedAtUnixMs: number,
): PublicSpan {
  return publicSpanSchema.parse({
    ...finishIdentity(started, responseStatus, endedAtUnixMs),
    attributes: { operationClass: operation },
    kind: "INTERNAL",
    name: operation === "snapshot" ? "durable-object.snapshot" : "durable-object.stream-connect",
    runtimeSide: "durable-object",
    serviceName: "live-dashblog-observability-room",
  });
}

function finishIdentity(started: StartedPublicSpan, responseStatus: number, endedAtUnixMs: number) {
  return {
    durationMs: Math.min(60_000, Math.max(0, endedAtUnixMs - started.startedAtUnixMs)),
    parentSpanId: started.context.parentSpanId,
    spanId: started.context.spanId,
    startedAtUnixMs: started.startedAtUnixMs,
    status: responseStatus >= 500 ? "error" : "ok",
    traceId: started.context.traceId,
    version: 1,
  } as const;
}

function statusClass(status: number): "1xx" | "2xx" | "3xx" | "4xx" | "5xx" {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "1xx";
}
