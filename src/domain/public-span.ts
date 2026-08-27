import { z } from "zod";

// Browser validation of public telemetry must remain compatible with the site's strict CSP.
z.config({ jitless: true });

const traceIdSchema = z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/);
const spanIdSchema = z.string().regex(/^(?!0{16}$)[0-9a-f]{16}$/);
const timestampSchema = z.number().int().nonnegative();
const durationSchema = z.number().nonnegative().max(60_000);
const statusSchema = z.enum(["unset", "ok", "error"]);
const statusClassSchema = z.enum(["2xx", "3xx", "4xx", "5xx"]);

const identityShape = {
  durationMs: durationSchema,
  parentSpanId: spanIdSchema.nullable(),
  spanId: spanIdSchema,
  startedAtUnixMs: timestampSchema,
  status: statusSchema,
  traceId: traceIdSchema,
  version: z.literal(1),
} as const;

const browserDocumentLoadSchema = z.object({
  ...identityShape,
  attributes: z.object({ routeClass: z.literal("article") }).strict(),
  kind: z.literal("INTERNAL"),
  name: z.literal("browser.document-load"),
  runtimeSide: z.literal("browser"),
  serviceName: z.literal("live-dashblog-browser"),
}).strict();

const browserHydrationSchema = z.object({
  ...identityShape,
  attributes: z.object({ routeClass: z.literal("article") }).strict(),
  kind: z.literal("INTERNAL"),
  name: z.literal("browser.hydration"),
  runtimeSide: z.literal("browser"),
  serviceName: z.literal("live-dashblog-browser"),
}).strict();

const browserSnapshotFetchSchema = z.object({
  ...identityShape,
  attributes: z.object({ routeClass: z.literal("snapshot") }).strict(),
  kind: z.literal("CLIENT"),
  name: z.literal("browser.snapshot-fetch"),
  runtimeSide: z.literal("browser"),
  serviceName: z.literal("live-dashblog-browser"),
}).strict();

const browserStreamConnectSchema = z.object({
  ...identityShape,
  attributes: z.object({ routeClass: z.literal("stream") }).strict(),
  kind: z.literal("CLIENT"),
  name: z.literal("browser.stream-connect"),
  runtimeSide: z.literal("browser"),
  serviceName: z.literal("live-dashblog-browser"),
}).strict();

const browserArticleInteractionSchema = z.object({
  ...identityShape,
  attributes: z.object({
    interactionClass: z.enum(["focus-trace", "change-group", "change-time-range"]),
    routeClass: z.literal("article"),
  }).strict(),
  kind: z.literal("INTERNAL"),
  name: z.literal("browser.article-interaction"),
  runtimeSide: z.literal("browser"),
  serviceName: z.literal("live-dashblog-browser"),
}).strict();

const workerArticleRequestSchema = z.object({
  ...identityShape,
  attributes: z.object({
    cacheClass: z.enum(["hit", "miss", "bypass", "unknown"]),
    routeClass: z.enum(["home", "article", "asset", "other"]),
    statusClass: statusClassSchema,
  }).strict(),
  kind: z.literal("SERVER"),
  name: z.literal("worker.article-request"),
  runtimeSide: z.literal("worker"),
  serviceName: z.literal("live-dashblog-worker"),
}).strict();

const workerSnapshotRequestSchema = z.object({
  ...identityShape,
  attributes: z.object({
    routeClass: z.literal("snapshot"),
    statusClass: statusClassSchema,
  }).strict(),
  kind: z.literal("SERVER"),
  name: z.literal("worker.snapshot-request"),
  runtimeSide: z.literal("worker"),
  serviceName: z.literal("live-dashblog-worker"),
}).strict();

const workerStreamRequestSchema = z.object({
  ...identityShape,
  attributes: z.object({
    routeClass: z.literal("stream"),
    statusClass: statusClassSchema,
  }).strict(),
  kind: z.literal("SERVER"),
  name: z.literal("worker.stream-request"),
  runtimeSide: z.literal("worker"),
  serviceName: z.literal("live-dashblog-worker"),
}).strict();

const durableObjectSnapshotSchema = z.object({
  ...identityShape,
  attributes: z.object({ operationClass: z.literal("snapshot") }).strict(),
  kind: z.literal("INTERNAL"),
  name: z.literal("durable-object.snapshot"),
  runtimeSide: z.literal("durable-object"),
  serviceName: z.literal("live-dashblog-observability-room"),
}).strict();

const durableObjectStreamConnectSchema = z.object({
  ...identityShape,
  attributes: z.object({ operationClass: z.literal("stream-connect") }).strict(),
  kind: z.literal("INTERNAL"),
  name: z.literal("durable-object.stream-connect"),
  runtimeSide: z.literal("durable-object"),
  serviceName: z.literal("live-dashblog-observability-room"),
}).strict();

/**
 * The complete public telemetry boundary. OpenTelemetry SDK data must pass through an
 * adapter into one of these operation-owned variants before it can be stored or shown.
 */
const publicSpanVariantSchema = z.discriminatedUnion("name", [
  browserDocumentLoadSchema,
  browserHydrationSchema,
  browserSnapshotFetchSchema,
  browserStreamConnectSchema,
  browserArticleInteractionSchema,
  workerArticleRequestSchema,
  workerSnapshotRequestSchema,
  workerStreamRequestSchema,
  durableObjectSnapshotSchema,
  durableObjectStreamConnectSchema,
]);

export const publicSpanSchema = publicSpanVariantSchema.superRefine((span, context) => {
  if (span.parentSpanId === span.spanId) {
    context.addIssue({ code: "custom", message: "A span cannot parent itself.", path: ["parentSpanId"] });
  }
});
export const publicSpanBatchSchema = z.array(publicSpanSchema).min(1).max(32);

export type PublicSpan = z.infer<typeof publicSpanSchema>;
export const PUBLIC_SPAN_NAMES = Object.freeze(
  publicSpanVariantSchema.options.map((schema) => schema.shape.name.value),
);
export const PUBLIC_SPAN_KINDS = Object.freeze(["CLIENT", "INTERNAL", "SERVER"] as const);
export const PUBLIC_RUNTIME_SIDES = Object.freeze(["browser", "durable-object", "worker"] as const);

export interface CompleteTraceValidation {
  issues: string[];
  valid: boolean;
}

/**
 * Validates identity relationships once a trace is finalized. Individual spans may
 * arrive before their parents, so ingestion applies only publicSpanSchema.
 */
export function validateCompleteTrace(spans: readonly PublicSpan[]): CompleteTraceValidation {
  const issues: string[] = [];
  const traceIds = new Set(spans.map((span) => span.traceId));
  if (traceIds.size !== 1) issues.push("A complete trace must contain exactly one traceId.");

  const spansById = new Map<string, PublicSpan>();
  for (const span of spans) {
    if (spansById.has(span.spanId)) issues.push(`Duplicate spanId: ${span.spanId}.`);
    spansById.set(span.spanId, span);
  }

  const rootCount = spans.filter((span) => span.parentSpanId === null).length;
  if (spans.length > 0 && rootCount !== 1) issues.push("A complete trace must contain exactly one root span.");

  for (const span of spans) {
    if (span.parentSpanId === span.spanId) issues.push(`Span ${span.spanId} cannot parent itself.`);
    const parent = span.parentSpanId === null ? undefined : spansById.get(span.parentSpanId);
    if (span.parentSpanId !== null && !parent) {
      issues.push(`Span ${span.spanId} has a parent outside the complete trace.`);
    }
    if (span.parentSpanId !== null && span.kind === "SERVER" && parent?.kind !== "CLIENT") {
      issues.push(`Server span ${span.spanId} must continue a client span.`);
    }
    if (span.runtimeSide === "durable-object" &&
        (parent?.runtimeSide !== "worker" || parent.kind !== "SERVER")) {
      issues.push(`Durable Object span ${span.spanId} must be a child of a Worker server span.`);
    }
    if (span.runtimeSide === "browser" && span.kind === "CLIENT" && parent?.runtimeSide !== "browser") {
      issues.push(`Browser client span ${span.spanId} must be a child of a browser span.`);
    }
    if (parent?.runtimeSide === "durable-object") {
      issues.push(`Durable Object span ${parent.spanId} cannot parent another public span.`);
    }
  }

  for (const span of spans) {
    const ancestors = new Set<string>([span.spanId]);
    let parentSpanId = span.parentSpanId;
    while (parentSpanId !== null) {
      if (ancestors.has(parentSpanId)) {
        issues.push(`Span ${span.spanId} participates in a parent cycle.`);
        break;
      }
      ancestors.add(parentSpanId);
      parentSpanId = spansById.get(parentSpanId)?.parentSpanId ?? null;
    }
  }

  return { issues: [...new Set(issues)], valid: issues.length === 0 };
}
