import { z } from "zod";
import { definePublicStream, selectPresentablePoints } from "./public-stream";

// Browser validation of public projections must remain compatible with the site's strict CSP.
z.config({ jitless: true });

export const TAIL_LATENCY_STREAM = definePublicStream({
  broadcastIntervalMs: 1_000,
  name: "tail-latency",
  presentation: { durationMs: 60_000, maxPoints: 300 },
});

/** The registry is both the public allowlist and the required retention declaration. */
export const PUBLIC_STREAMS = {
  [TAIL_LATENCY_STREAM.name]: TAIL_LATENCY_STREAM,
} as const;

export const STREAM_NAME = TAIL_LATENCY_STREAM.name;
export const PRESENTATION_WINDOW_MS = TAIL_LATENCY_STREAM.presentation.durationMs;
export const SAMPLE_LIMIT = TAIL_LATENCY_STREAM.presentation.maxPoints;
export const REPLAY_LIMIT = TAIL_LATENCY_STREAM.replayLimit;
export const BROADCAST_INTERVAL_MS = TAIL_LATENCY_STREAM.broadcastIntervalMs;

export const publicTimingSampleSchema = z.object({
  durationMs: z.number().nonnegative().max(60_000),
  observedAt: z.number().int().nonnegative(),
  routeClass: z.enum(["home", "article", "asset", "other"]),
  statusClass: z.enum(["2xx", "3xx", "4xx", "5xx"]),
}).strict();

export type PublicTimingSample = z.infer<typeof publicTimingSampleSchema>;

export interface KeyedTimingSample extends PublicTimingSample {
  key: string;
}

const latencyPointSchema = z.object({
  durationMs: z.number().nonnegative().max(60_000),
  key: z.string().min(1),
  observedAt: z.number().int().nonnegative(),
}).strict();

export type LatencyPoint = z.infer<typeof latencyPointSchema>;

export const tailLatencyProjectionSchema = z.object({
  generatedAt: z.number().int().nonnegative(),
  maxMs: z.number().nonnegative(),
  p50Ms: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  points: z.array(latencyPointSchema).max(SAMPLE_LIMIT),
  sampleCount: z.number().int().nonnegative().max(SAMPLE_LIMIT),
  sequence: z.number().int().nonnegative(),
  stream: z.literal(STREAM_NAME),
  version: z.literal(2),
}).strict().superRefine((projection, context) => {
  if (projection.sampleCount !== projection.points.length) {
    context.addIssue({ code: "custom", message: "sampleCount must match points.length" });
  }
  const eligible = selectPresentablePoints(TAIL_LATENCY_STREAM, projection.points, projection.generatedAt);
  if (eligible.length !== projection.points.length) {
    context.addIssue({ code: "custom", message: "points must fit the declared presentation window" });
  }
});

export type TailLatencyProjection = z.infer<typeof tailLatencyProjectionSchema>;

export const streamEnvelopeSchema = z.object({
  projection: tailLatencyProjectionSchema,
  stream: z.literal(STREAM_NAME),
  type: z.literal("projection"),
}).strict();

export type StreamEnvelope = z.infer<typeof streamEnvelopeSchema>;

export type RecoveryMode = "replay" | "snapshot";
export interface BroadcastCursor {
  lastBroadcastAt: number;
  lastSampleId: number;
  sequence: number;
}
export type ProjectionAction =
  | { kind: "publish" }
  | { at: number; kind: "schedule" }
  | { kind: "none" };

/** Snapshot refreshes preserve the cursor that distinguishes stored from broadcast samples. */
export function retainBroadcastCursor(current: BroadcastCursor | null): BroadcastCursor {
  return current ?? { lastBroadcastAt: 0, lastSampleId: 0, sequence: 0 };
}

export function hasUnpublishedSample(cursor: BroadcastCursor, latestSampleId: number): boolean {
  return latestSampleId > cursor.lastSampleId;
}

/** A sequence-zero fallback stays virtual until a live current row exists. */
export function shouldPersistProjectionRefresh(
  hasCurrentRow: boolean,
  pointsDeleted: number,
  currentPayloadValid: boolean,
): boolean {
  return hasCurrentRow && (pointsDeleted > 0 || !currentPayloadValid);
}

/** Chooses an immediate projection or replaces a later alarm with the cadence deadline. */
export function decideProjectionAction(
  lastBroadcastAt: number | null,
  now: number,
  scheduledAlarmAt: number | null,
): ProjectionAction {
  if (lastBroadcastAt === null || now - lastBroadcastAt >= BROADCAST_INTERVAL_MS) return { kind: "publish" };
  const cadenceAt = lastBroadcastAt + BROADCAST_INTERVAL_MS;
  if (scheduledAlarmAt !== null && scheduledAlarmAt <= cadenceAt) return { kind: "none" };
  return { at: cadenceAt, kind: "schedule" };
}

/** Chooses replay only when the client overlaps the retained sequence range. */
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

const STATIC_FALLBACK_SAMPLES: KeyedTimingSample[] = [
  12, 18, 22, 28, 31, 36, 42, 47, 55, 68, 85, 105, 130, 165, 230, 300, 410, 520, 610, 920,
].map((durationMs, index) => ({
  durationMs,
  key: `fallback-${index}`,
  observedAt: index * 1_000,
  routeClass: "article",
  statusClass: "2xx",
}));

export const STATIC_FALLBACK_PROJECTION = projectTailLatency(
  STATIC_FALLBACK_SAMPLES,
  0,
  STATIC_FALLBACK_SAMPLES.at(-1)?.observedAt ?? 0,
);

/** Reduces one declared presentation window into the complete browser contract. */
export function projectTailLatency(
  samples: readonly KeyedTimingSample[],
  sequence: number,
  generatedAt: number,
): TailLatencyProjection {
  const bounded = selectPresentablePoints(TAIL_LATENCY_STREAM, samples, generatedAt);
  const points = bounded.map(({ durationMs, key, observedAt }) => ({ durationMs, key, observedAt }));
  const durations = points.map((point) => point.durationMs).sort((left, right) => left - right);

  return {
    generatedAt,
    maxMs: durations.at(-1) ?? 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    points,
    sampleCount: points.length,
    sequence,
    stream: STREAM_NAME,
    version: 2,
  };
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  return sortedValues[rank] ?? 0;
}
