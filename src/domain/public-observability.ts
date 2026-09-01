import { z } from "zod";
import { JOINED_PUBLIC_TRACE } from "./fixtures/public-spans";
import {
  PUBLIC_RUNTIME_SIDES,
  PUBLIC_SPAN_NAMES,
  type PublicSpan,
} from "./public-span";
import { PUBLIC_TRACE_STREAM } from "./public-trace-store";

export const OBSERVABILITY_STREAM_NAME = "observability";
export const OBSERVABILITY_PROJECTION_VERSION = 2;
export const OBSERVABILITY_BUCKET_DURATION_MS = 10_000;
export const OBSERVABILITY_BUCKET_COUNT = 30;
export const MAX_OBSERVABILITY_BUCKET_COUNT = OBSERVABILITY_BUCKET_COUNT + 1;
export const MAX_PROJECTED_TRACE_SAMPLES = 12;

const serviceNameSchema = z.enum([
  "live-dashblog-browser",
  "live-dashblog-observability-room",
  "live-dashblog-worker",
]);
const aggregateSchema = z.object({
  count: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  errorRate: z.number().min(0).max(1),
  maxMs: z.number().nonnegative(),
  p50Ms: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
}).strict();
const groupedAggregateSchema = aggregateSchema.extend({ key: z.string().min(1).max(64) }).strict();
const waterfallSpanSchema = z.object({
  durationMs: z.number().nonnegative().max(60_000),
  name: z.enum(PUBLIC_SPAN_NAMES as [typeof PUBLIC_SPAN_NAMES[number], ...typeof PUBLIC_SPAN_NAMES[number][]]),
  offsetMs: z.number().nonnegative(),
  parentSpanId: z.string().nullable(),
  runtimeSide: z.enum(PUBLIC_RUNTIME_SIDES),
  serviceName: serviceNameSchema,
  spanId: z.string(),
  status: z.enum(["unset", "ok", "error"]),
}).strict();
const traceSampleSchema = z.object({
  error: z.boolean(),
  observedWindowMs: z.number().nonnegative(),
  requestDurationMs: z.number().nonnegative(),
  spans: z.array(waterfallSpanSchema).max(16),
  requestStartedAtUnixMs: z.number().int().nonnegative(),
  traceId: z.string(),
}).strict();

export const publicObservabilityProjectionSchema = z.object({
  aggregates: z.object({
    overall: aggregateSchema,
    byRuntimeSide: z.array(groupedAggregateSchema).max(PUBLIC_RUNTIME_SIDES.length),
    byService: z.array(groupedAggregateSchema).max(3),
  }).strict(),
  dataExpiresAtUnixMs: z.number().int().nonnegative().nullable(),
  generatedAt: z.number().int().nonnegative(),
  durationBands: z.array(z.object({
    count: z.number().int().nonnegative(),
    lowerBoundMs: z.number().nonnegative(),
    upperBoundMs: z.number().positive(),
  }).strict()).max(10),
  sampling: z.object({
    admittedTraceCount: z.number().int().nonnegative(),
    droppedTraceCount: z.number().int().nonnegative(),
    sampleRate: z.number().min(0).max(1),
  }).strict(),
  sequence: z.number().int().nonnegative(),
  timeSeries: z.object({
    bucketDurationMs: z.literal(OBSERVABILITY_BUCKET_DURATION_MS),
    buckets: z.array(z.object({
      endUnixMs: z.number().int().nonnegative(),
      errorCount: z.number().int().nonnegative(),
      requestMaxMs: z.number().nonnegative(),
      requestP95Ms: z.number().nonnegative(),
      sampleTraceIds: z.array(z.string()).max(MAX_PROJECTED_TRACE_SAMPLES),
      startUnixMs: z.number().int().nonnegative(),
      traceCount: z.number().int().nonnegative(),
    }).strict()).min(1).max(MAX_OBSERVABILITY_BUCKET_COUNT),
  }).strict(),
  traceSamples: z.array(traceSampleSchema).max(MAX_PROJECTED_TRACE_SAMPLES),
  spanCount: z.number().int().nonnegative(),
  stream: z.literal(OBSERVABILITY_STREAM_NAME),
  traceCount: z.number().int().nonnegative(),
  version: z.literal(OBSERVABILITY_PROJECTION_VERSION),
}).strict();

export const publicObservabilityEnvelopeSchema = z.object({
  projection: publicObservabilityProjectionSchema,
  stream: z.literal(OBSERVABILITY_STREAM_NAME),
  type: z.literal("projection"),
}).strict();

export type PublicObservabilityProjection = z.infer<typeof publicObservabilityProjectionSchema>;
export type PublicObservabilityEnvelope = z.infer<typeof publicObservabilityEnvelopeSchema>;

interface ProjectionSampling {
  droppedTraceExpiresAtUnixMs?: number | null;
  droppedTraceCount: number;
  sampleRate: number;
  samplingExpiresAtUnixMs?: number | null;
}

const SPAN_DURATION_EDGES_MS = Object.freeze([0, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000, 60_001]);

/** Reduces finalized whole traces into the complete browser-safe observability view. */
export function projectPublicObservability(
  traces: readonly (readonly PublicSpan[])[],
  sequence: number,
  generatedAt: number,
  sampling: ProjectionSampling = { droppedTraceCount: 0, sampleRate: 1 },
): PublicObservabilityProjection {
  const completeTraces = traces.filter((trace) => trace.length > 0);
  const projectedTraces = completeTraces.map(projectTrace);
  const spans = completeTraces.flat();
  const traceExpiryAt = completeTraces.length === 0
    ? null
    : Math.min(...completeTraces.map((trace) =>
      Math.min(...trace.map((span) => span.startedAtUnixMs))
      + PUBLIC_TRACE_STREAM.presentationDurationMs + 1
    ));
  const expiryCandidates = [
    traceExpiryAt,
    sampling.droppedTraceExpiresAtUnixMs,
    sampling.samplingExpiresAtUnixMs,
  ]
    .filter((value): value is number => value !== null && value !== undefined);
  return publicObservabilityProjectionSchema.parse({
    aggregates: {
      overall: aggregate(spans),
      byRuntimeSide: groupedAggregates(spans, PUBLIC_RUNTIME_SIDES, (span) => span.runtimeSide),
      byService: groupedAggregates(spans, [
        "live-dashblog-browser",
        "live-dashblog-observability-room",
        "live-dashblog-worker",
      ], (span) => span.serviceName),
    },
    dataExpiresAtUnixMs: expiryCandidates.length === 0 ? null : Math.min(...expiryCandidates),
    generatedAt,
    durationBands: SPAN_DURATION_EDGES_MS.slice(0, -1).map((lowerBoundMs, index) => {
      const upperBoundMs = SPAN_DURATION_EDGES_MS[index + 1]!;
      return {
        count: spans.filter((span) =>
          span.durationMs >= lowerBoundMs && span.durationMs < upperBoundMs
        ).length,
        lowerBoundMs,
        upperBoundMs,
      };
    }),
    sampling: {
      admittedTraceCount: completeTraces.length,
      droppedTraceCount: sampling.droppedTraceCount,
      sampleRate: sampling.sampleRate,
    },
    sequence,
    timeSeries: projectTimeSeries(projectedTraces, generatedAt),
    traceSamples: projectedTraces
      .sort(compareTraceInterest)
      .slice(0, MAX_PROJECTED_TRACE_SAMPLES),
    spanCount: spans.length,
    stream: OBSERVABILITY_STREAM_NAME,
    traceCount: completeTraces.length,
    version: OBSERVABILITY_PROJECTION_VERSION,
  });
}

export const STATIC_OBSERVABILITY_PROJECTION = projectPublicObservability(
  [JOINED_PUBLIC_TRACE],
  0,
  JOINED_PUBLIC_TRACE.reduce(
    (latest, span) => Math.max(latest, span.startedAtUnixMs + span.durationMs),
    0,
  ),
);

export function acceptObservabilitySnapshot(candidate: unknown): PublicObservabilityProjection | null {
  const parsed = publicObservabilityProjectionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function acceptObservabilityEnvelope(
  lastSequence: number,
  candidate: unknown,
): PublicObservabilityProjection | null {
  const parsed = publicObservabilityEnvelopeSchema.safeParse(candidate);
  return parsed.success && parsed.data.projection.sequence > lastSequence
    ? parsed.data.projection
    : null;
}

function aggregate(spans: readonly PublicSpan[]) {
  const durations = spans.map((span) => span.durationMs).sort((left, right) => left - right);
  const errorCount = spans.filter((span) => span.status === "error").length;
  return {
    count: spans.length,
    errorCount,
    errorRate: spans.length === 0 ? 0 : errorCount / spans.length,
    maxMs: durations.at(-1) ?? 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
  };
}

function groupedAggregates<Key extends string>(
  spans: readonly PublicSpan[],
  keys: readonly Key[],
  keyFor: (span: PublicSpan) => Key,
) {
  return keys.map((key) => ({ key, ...aggregate(spans.filter((span) => keyFor(span) === key)) }));
}

function projectTrace(trace: readonly PublicSpan[]) {
  const startedAtUnixMs = Math.min(...trace.map((span) => span.startedAtUnixMs));
  const endedAtUnixMs = Math.max(...trace.map((span) => span.startedAtUnixMs + span.durationMs));
  const rootSpan = [...trace]
    .sort((left, right) => left.startedAtUnixMs - right.startedAtUnixMs || left.spanId.localeCompare(right.spanId))
    .find((span) => span.parentSpanId === null) ?? trace[0]!;
  return {
    error: trace.some((span) => span.status === "error"),
    observedWindowMs: endedAtUnixMs - startedAtUnixMs,
    requestDurationMs: rootSpan.durationMs,
    requestStartedAtUnixMs: rootSpan.startedAtUnixMs,
    spans: [...trace]
      .sort((left, right) => left.startedAtUnixMs - right.startedAtUnixMs || left.spanId.localeCompare(right.spanId))
      .map((span) => ({
        durationMs: span.durationMs,
        name: span.name,
        offsetMs: span.startedAtUnixMs - startedAtUnixMs,
        parentSpanId: span.parentSpanId,
        runtimeSide: span.runtimeSide,
        serviceName: span.serviceName,
        spanId: span.spanId,
        status: span.status,
      })),
    traceId: trace[0]?.traceId ?? "00000000000000000000000000000000",
  };
}

type ProjectedTrace = ReturnType<typeof projectTrace>;

function projectTimeSeries(traces: readonly ProjectedTrace[], generatedAt: number) {
  const presentationStart = Math.max(0, generatedAt - PUBLIC_TRACE_STREAM.presentationDurationMs);
  const boundaries = bucketBoundaries(presentationStart, generatedAt);
  const sampledTraceIds = new Set(
    [...traces].sort(compareTraceInterest).slice(0, MAX_PROJECTED_TRACE_SAMPLES).map((trace) => trace.traceId),
  );
  return {
    bucketDurationMs: OBSERVABILITY_BUCKET_DURATION_MS,
    buckets: boundaries.slice(0, -1).map((startUnixMs, index) => {
      const endUnixMs = boundaries[index + 1]!;
      const bucketTraces = traces.filter((trace) =>
        trace.requestStartedAtUnixMs >= startUnixMs
          && (index === boundaries.length - 2
            ? trace.requestStartedAtUnixMs <= endUnixMs
            : trace.requestStartedAtUnixMs < endUnixMs)
      );
      const requestDurations = bucketTraces
        .map((trace) => trace.requestDurationMs)
        .sort((left, right) => left - right);
      return {
        endUnixMs,
        errorCount: bucketTraces.filter((trace) => trace.error).length,
        requestMaxMs: requestDurations.at(-1) ?? 0,
        requestP95Ms: percentile(requestDurations, 0.95),
        sampleTraceIds: bucketTraces
          .filter((trace) => sampledTraceIds.has(trace.traceId))
          .map((trace) => trace.traceId),
        startUnixMs,
        traceCount: bucketTraces.length,
      };
    }),
  };
}

function compareTraceInterest(left: ProjectedTrace, right: ProjectedTrace): number {
  const leftRuntimeSides = new Set(left.spans.map((span) => span.runtimeSide)).size;
  const rightRuntimeSides = new Set(right.spans.map((span) => span.runtimeSide)).size;
  return Number(right.error) - Number(left.error)
    || rightRuntimeSides - leftRuntimeSides
    || right.spans.length - left.spans.length
    || right.requestDurationMs - left.requestDurationMs
    || right.requestStartedAtUnixMs - left.requestStartedAtUnixMs
    || left.traceId.localeCompare(right.traceId);
}

/** Clips the wall-clock grid to the exact presentation interval at both edges. */
function bucketBoundaries(presentationStart: number, generatedAt: number): number[] {
  if (generatedAt <= presentationStart) return [presentationStart, generatedAt];
  const boundaries = [presentationStart];
  let boundary = Math.ceil(presentationStart / OBSERVABILITY_BUCKET_DURATION_MS)
    * OBSERVABILITY_BUCKET_DURATION_MS;
  if (boundary === presentationStart) boundary += OBSERVABILITY_BUCKET_DURATION_MS;
  while (boundary < generatedAt) {
    boundaries.push(boundary);
    boundary += OBSERVABILITY_BUCKET_DURATION_MS;
  }
  boundaries.push(generatedAt);
  return boundaries;
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)] ?? 0;
}
