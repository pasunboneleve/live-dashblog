import { describe, expect, it } from "vitest";
import {
  createTailLatencyGeometry,
  projectionPresentationTime,
} from "../visualizations/tail-latency-geometry";
import {
  PRESENTATION_WINDOW_MS,
  PUBLIC_STREAMS,
  SAMPLE_LIMIT,
  STATIC_FALLBACK_PROJECTION,
  TAIL_LATENCY_STREAM,
  acceptProjectionEnvelope,
  decideProjectionAction,
  hasUnpublishedSample,
  projectTailLatency,
  publicTimingSampleSchema,
  retainBroadcastCursor,
  selectRecoveryMode,
  tailLatencyProjectionSchema,
  shouldPersistProjectionRefresh,
  type KeyedTimingSample,
} from "./tail-latency";

const sample = (durationMs: number, observedAt = durationMs, key = String(observedAt)): KeyedTimingSample => ({
  durationMs, key, observedAt, routeClass: "article", statusClass: "2xx",
});

describe("public timing boundary", () => {
  it("accepts only the allowlisted, privacy-bounded input shape", () => {
    const input = { durationMs: 42, observedAt: 42, routeClass: "article", statusClass: "2xx" };
    expect(publicTimingSampleSchema.safeParse(input).success).toBe(true);
    expect(publicTimingSampleSchema.safeParse({ ...input, ip: "203.0.113.8" }).success).toBe(false);
    expect(publicTimingSampleSchema.safeParse({ ...input, routeClass: "/private/path" }).success).toBe(false);
  });

  it("requires every allowlisted stream to declare one finite presentation window", () => {
    expect(Object.values(PUBLIC_STREAMS)).toEqual([TAIL_LATENCY_STREAM]);
    expect(TAIL_LATENCY_STREAM.presentation).toEqual({ durationMs: 60_000, maxPoints: 300 });
    expect(TAIL_LATENCY_STREAM.replayLimit).toBe(61);
  });
});

describe("tail latency projection", () => {
  it("preserves arrival order and computes nearest-rank summaries", () => {
    const projection = projectTailLatency(
      [10, 25, 26, 100, 101, 2_000].map((duration, index) => sample(duration, 1_000 + index, `point-${index}`)),
      7,
      2_000,
    );
    expect(projection.sequence).toBe(7);
    expect(projection.p50Ms).toBe(26);
    expect(projection.p95Ms).toBe(2_000);
    expect(projection.maxMs).toBe(2_000);
    expect(projection.points.map((point) => point.durationMs)).toEqual([10, 25, 26, 100, 101, 2_000]);
  });

  it("uses the same time and capacity window as the stream declaration", () => {
    const now = 100_000;
    const inside = Array.from({ length: SAMPLE_LIMIT + 200 }, (_, index) => sample(index, now - 1_000 + index, `point-${index}`));
    const projection = projectTailLatency(
      [sample(999, now - PRESENTATION_WINDOW_MS - 1, "aged"), ...inside, sample(999, now + 1, "future")],
      8,
      now,
    );
    expect(projection.points).toHaveLength(SAMPLE_LIMIT);
    expect(projection.sampleCount).toBe(SAMPLE_LIMIT);
    expect(projection.points[0]?.key).toBe("point-200");
    expect(projection.points.at(-1)?.key).toBe("point-499");
  });

  it("rejects a stored projection that contains an aged point", () => {
    const projection = projectTailLatency([sample(42, 100, "point")], 2, 100);
    expect(tailLatencyProjectionSchema.safeParse({
      ...projection,
      generatedAt: 100 + PRESENTATION_WINDOW_MS + 1,
    }).success).toBe(false);
  });

  it("keeps the sequence-zero static fallback legible at its own presentation time", () => {
    const geometry = createTailLatencyGeometry(
      STATIC_FALLBACK_PROJECTION.points,
      STATIC_FALLBACK_PROJECTION.generatedAt,
    );
    expect(geometry.points).toHaveLength(STATIC_FALLBACK_PROJECTION.sampleCount);
    expect(geometry.latest).not.toBeNull();
  });

  it("keeps server-fresh points visible when the browser clock is behind", () => {
    const projection = projectTailLatency([sample(42, 10_000, "fresh")], 3, 10_000);
    const presentationTime = projectionPresentationTime(projection, 8_000);
    const geometry = createTailLatencyGeometry(projection.points, presentationTime);

    expect(presentationTime).toBe(10_000);
    expect(geometry.latest?.key).toBe("fresh");
  });
});

describe("projection sequence recovery", () => {
  const envelopeAt = (sequence: number) => ({
    projection: projectTailLatency([sample(42, 1_234, "point")], sequence, 1_234),
    stream: "tail-latency",
    type: "projection",
  });

  it("accepts a newer typed projection and rejects duplicate or out-of-order frames", () => {
    expect(acceptProjectionEnvelope(4, envelopeAt(5))?.sequence).toBe(5);
    expect(acceptProjectionEnvelope(5, envelopeAt(5))).toBeNull();
    expect(acceptProjectionEnvelope(5, envelopeAt(3))).toBeNull();
  });

  it("rejects malformed and unknown-stream frames", () => {
    expect(acceptProjectionEnvelope(0, { ...envelopeAt(1), stream: "raw-logs" })).toBeNull();
    expect(acceptProjectionEnvelope(0, "not a projection")).toBeNull();
  });

  it("uses snapshot recovery when replay does not overlap the client", () => {
    expect(selectRecoveryMode(0, 1)).toBe("snapshot");
    expect(selectRecoveryMode(199, 200)).toBe("replay");
    expect(selectRecoveryMode(5, 200)).toBe("snapshot");
    expect(selectRecoveryMode(5, null)).toBe("snapshot");
  });
});

describe("projection cadence", () => {
  it("publishes when due and replaces only a later alarm with the cadence deadline", () => {
    expect(decideProjectionAction(null, 500, null)).toEqual({ kind: "publish" });
    expect(decideProjectionAction(1_000, 2_000, null)).toEqual({ kind: "publish" });
    expect(decideProjectionAction(1_000, 1_200, null)).toEqual({ at: 2_000, kind: "schedule" });
    expect(decideProjectionAction(1_000, 1_200, 1_900)).toEqual({ kind: "none" });
    expect(decideProjectionAction(2_000, 2_500, 9_999)).toEqual({ at: 3_000, kind: "schedule" });
  });

  it("keeps an in-cadence sample unpublished across a snapshot refresh", () => {
    const cursor = retainBroadcastCursor({ lastBroadcastAt: 1_000, lastSampleId: 300, sequence: 8 });
    const refreshed = retainBroadcastCursor(cursor);

    expect(refreshed.lastSampleId).toBe(300);
    expect(hasUnpublishedSample(refreshed, 301)).toBe(true);
    expect(decideProjectionAction(refreshed.lastBroadcastAt, 1_500, null))
      .toEqual({ at: 2_000, kind: "schedule" });
  });

  it("keeps the static fallback virtual until a live current row exists", () => {
    expect(shouldPersistProjectionRefresh(false, 0, false)).toBe(false);
    expect(shouldPersistProjectionRefresh(true, 0, false)).toBe(true);
    expect(shouldPersistProjectionRefresh(true, 1, true)).toBe(true);
  });
});
