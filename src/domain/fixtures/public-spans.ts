import { publicSpanSchema, type PublicSpan } from "../public-span";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

/** A deterministic cross-runtime trace used by reducers, storage, and page demos. */
export const JOINED_PUBLIC_TRACE: readonly PublicSpan[] = Object.freeze([
  {
    attributes: { cacheClass: "miss", routeClass: "article", statusClass: "2xx" },
    durationMs: 48,
    kind: "SERVER",
    name: "worker.article-request",
    parentSpanId: null,
    runtimeSide: "worker",
    serviceName: "live-dashblog-worker",
    spanId: "00f067aa0ba902b7",
    startedAtUnixMs: 1_800_000_000_000,
    status: "ok",
    traceId,
    version: 1,
  },
  {
    attributes: { routeClass: "article" },
    durationMs: 31,
    kind: "INTERNAL",
    name: "browser.document-load",
    parentSpanId: "00f067aa0ba902b7",
    runtimeSide: "browser",
    serviceName: "live-dashblog-browser",
    spanId: "b7ad6b7169203331",
    startedAtUnixMs: 1_800_000_000_049,
    status: "ok",
    traceId,
    version: 1,
  },
  {
    attributes: { routeClass: "snapshot" },
    durationMs: 18,
    kind: "CLIENT",
    name: "browser.snapshot-fetch",
    parentSpanId: "b7ad6b7169203331",
    runtimeSide: "browser",
    serviceName: "live-dashblog-browser",
    spanId: "a2fb4a1d1a96d312",
    startedAtUnixMs: 1_800_000_000_081,
    status: "ok",
    traceId,
    version: 1,
  },
  {
    attributes: { routeClass: "snapshot", statusClass: "2xx" },
    durationMs: 12,
    kind: "SERVER",
    name: "worker.snapshot-request",
    parentSpanId: "a2fb4a1d1a96d312",
    runtimeSide: "worker",
    serviceName: "live-dashblog-worker",
    spanId: "7a085853722dc6d2",
    startedAtUnixMs: 1_800_000_000_084,
    status: "ok",
    traceId,
    version: 1,
  },
  {
    attributes: { operationClass: "snapshot" },
    durationMs: 7,
    kind: "INTERNAL",
    name: "durable-object.snapshot",
    parentSpanId: "7a085853722dc6d2",
    runtimeSide: "durable-object",
    serviceName: "live-dashblog-observability-room",
    spanId: "c8f5ad3626f2f5f0",
    startedAtUnixMs: 1_800_000_000_087,
    status: "ok",
    traceId,
    version: 1,
  },
].map((span) => freezeSpan(publicSpanSchema.parse(span))));

function freezeSpan(span: PublicSpan): PublicSpan {
  Object.freeze(span.attributes);
  return Object.freeze(span);
}
