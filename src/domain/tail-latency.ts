import { z } from "zod";

export const STREAM_NAME = "tail-latency" as const;
export const SAMPLE_LIMIT = 300;
export const REPLAY_LIMIT = 120;
export const BROADCAST_INTERVAL_MS = 1_000;
export const BUCKET_UPPER_BOUNDS_MS = [25, 50, 100, 200, 400, 800, 1_600] as const;

export const publicTimingSampleSchema = z.object({
  durationMs: z.number().nonnegative().max(60_000),
  observedAt: z.number().int().nonnegative(),
  routeClass: z.enum(["home", "article", "asset", "other"]),
  statusClass: z.enum(["2xx", "3xx", "4xx", "5xx"]),
}).strict();

export type PublicTimingSample = z.infer<typeof publicTimingSampleSchema>;

const histogramBucketSchema = z.object({
  count: z.number().int().nonnegative(),
  key: z.string().min(1),
  label: z.string().min(1),
  upperBoundMs: z.number().positive().nullable(),
}).strict();

export const tailLatencyProjectionSchema = z.object({
  generatedAt: z.number().int().nonnegative(),
  histogram: z.array(histogramBucketSchema).length(BUCKET_UPPER_BOUNDS_MS.length + 1),
  maxMs: z.number().nonnegative(),
  p50Ms: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  sampleCount: z.number().int().nonnegative().max(SAMPLE_LIMIT),
  sequence: z.number().int().nonnegative(),
  stream: z.literal(STREAM_NAME),
  version: z.literal(1),
}).strict();

export type TailLatencyProjection = z.infer<typeof tailLatencyProjectionSchema>;

export const streamEnvelopeSchema = z.object({
  projection: tailLatencyProjectionSchema,
  stream: z.literal(STREAM_NAME),
  type: z.literal("projection"),
}).strict();

export type StreamEnvelope = z.infer<typeof streamEnvelopeSchema>;

export type RecoveryMode = "replay" | "snapshot";
export type ProjectionAction =
  | { kind: "publish" }
  | { at: number; kind: "schedule" }
  | { kind: "none" };

/** Chooses an immediate projection or one persisted alarm without exceeding the cadence. */
export function decideProjectionAction(
  lastBroadcastAt: number | null,
  now: number,
  alarmScheduled: boolean,
): ProjectionAction {
  if (lastBroadcastAt === null || now - lastBroadcastAt >= BROADCAST_INTERVAL_MS) return { kind: "publish" };
  if (alarmScheduled) return { kind: "none" };
  return { at: lastBroadcastAt + BROADCAST_INTERVAL_MS, kind: "schedule" };
}

/** Chooses replay only when the client's last sequence is contiguous with retained history. */
export function selectRecoveryMode(currentSequence: number, oldestRetainedSequence: number | null): RecoveryMode {
  if (currentSequence === 0 || oldestRetainedSequence === null) return "snapshot";
  return currentSequence < oldestRetainedSequence - 1 ? "snapshot" : "replay";
}

/** Accepts only a valid projection newer than the browser's current sequence. */
export function acceptProjectionEnvelope(
  currentSequence: number,
  candidate: unknown,
): TailLatencyProjection | null {
  const parsed = streamEnvelopeSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.projection.sequence <= currentSequence) return null;
  return parsed.data.projection;
}

const STATIC_FALLBACK_SAMPLES: PublicTimingSample[] = [
  12, 18, 22, 28, 31, 36, 42, 47, 55, 68, 85, 105, 130, 165, 230, 300, 410, 520, 610, 920,
].map((durationMs, observedAt) => ({ durationMs, observedAt, routeClass: "article", statusClass: "2xx" }));

export const STATIC_FALLBACK_PROJECTION = projectTailLatency(STATIC_FALLBACK_SAMPLES, 0, 0);

/** Reduces one bounded window into the complete public contract consumed by the browser. */
export function projectTailLatency(
  samples: readonly PublicTimingSample[],
  sequence: number,
  generatedAt: number,
): TailLatencyProjection {
  const bounded = samples.slice(-SAMPLE_LIMIT);
  const durations = bounded.map((sample) => sample.durationMs).sort((left, right) => left - right);

  return {
    generatedAt,
    histogram: createHistogram(durations),
    maxMs: durations.at(-1) ?? 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    sampleCount: durations.length,
    sequence,
    stream: STREAM_NAME,
    version: 1,
  };
}

export function appendBoundedSample(
  samples: readonly PublicTimingSample[],
  sample: PublicTimingSample,
): PublicTimingSample[] {
  return [...samples, sample].slice(-SAMPLE_LIMIT);
}

function createHistogram(durations: readonly number[]) {
  const counts = Array.from({ length: BUCKET_UPPER_BOUNDS_MS.length + 1 }, () => 0);

  for (const duration of durations) {
    const index = BUCKET_UPPER_BOUNDS_MS.findIndex((limit) => duration <= limit);
    counts[index === -1 ? counts.length - 1 : index] += 1;
  }

  return counts.map((count, index) => {
    const upperBoundMs = BUCKET_UPPER_BOUNDS_MS[index] ?? null;
    return {
      count,
      key: upperBoundMs === null ? "overflow" : `le-${upperBoundMs}`,
      label: upperBoundMs === null ? `>${BUCKET_UPPER_BOUNDS_MS.at(-1)} ms` : `≤${upperBoundMs} ms`,
      upperBoundMs,
    };
  });
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  return sortedValues[rank] ?? 0;
}
