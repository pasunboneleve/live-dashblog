import { describe, expect, it } from "vitest";
import {
  BUCKET_UPPER_BOUNDS_MS,
  SAMPLE_LIMIT,
  appendBoundedSample,
  acceptProjectionEnvelope,
  decideProjectionAction,
  projectTailLatency,
  publicTimingSampleSchema,
  selectRecoveryMode,
  type PublicTimingSample,
} from "./tail-latency";

const sample = (durationMs: number, observedAt = durationMs): PublicTimingSample => ({
  durationMs,
  observedAt,
  routeClass: "article",
  statusClass: "2xx",
});

describe("public timing boundary", () => {
  it("accepts only the allowlisted, privacy-bounded shape", () => {
    expect(publicTimingSampleSchema.safeParse(sample(42)).success).toBe(true);
    expect(publicTimingSampleSchema.safeParse({ ...sample(42), ip: "203.0.113.8" }).success).toBe(false);
    expect(publicTimingSampleSchema.safeParse({ ...sample(42), routeClass: "/private/path" }).success).toBe(false);
  });
});

describe("tail latency projection", () => {
  it("computes a deterministic bounded histogram and nearest-rank percentiles", () => {
    const projection = projectTailLatency([10, 25, 26, 100, 101, 2_000].map(sample), 7, 1_234);

    expect(projection.sequence).toBe(7);
    expect(projection.p50Ms).toBe(26);
    expect(projection.p95Ms).toBe(2_000);
    expect(projection.maxMs).toBe(2_000);
    expect(projection.histogram.map((bucket) => bucket.count)).toEqual([2, 1, 1, 1, 0, 0, 0, 1]);
    expect(projection.histogram).toHaveLength(BUCKET_UPPER_BOUNDS_MS.length + 1);
  });

  it("drops the oldest sample when the rolling window reaches its bound", () => {
    const full = Array.from({ length: SAMPLE_LIMIT }, (_, index) => sample(index, index));
    const next = appendBoundedSample(full, sample(9_999, 9_999));

    expect(next).toHaveLength(SAMPLE_LIMIT);
    expect(next[0]?.observedAt).toBe(1);
    expect(next.at(-1)?.durationMs).toBe(9_999);
  });
});

describe("projection sequence recovery", () => {
  const envelopeAt = (sequence: number) => ({
    projection: projectTailLatency([sample(42)], sequence, 1_234),
    stream: "tail-latency",
    type: "projection",
  });

  it("accepts the next typed projection and rejects duplicate or out-of-order frames", () => {
    expect(acceptProjectionEnvelope(4, envelopeAt(5))?.sequence).toBe(5);
    expect(acceptProjectionEnvelope(5, envelopeAt(5))).toBeNull();
    expect(acceptProjectionEnvelope(5, envelopeAt(3))).toBeNull();
  });

  it("rejects malformed and unknown-stream frames", () => {
    expect(acceptProjectionEnvelope(0, { ...envelopeAt(1), stream: "raw-logs" })).toBeNull();
    expect(acceptProjectionEnvelope(0, "not a projection")).toBeNull();
  });

  it("replays only when retained history is contiguous with the client sequence", () => {
    expect(selectRecoveryMode(0, 1)).toBe("snapshot");
    expect(selectRecoveryMode(199, 200)).toBe("replay");
    expect(selectRecoveryMode(200, 200)).toBe("replay");
    expect(selectRecoveryMode(5, 200)).toBe("snapshot");
    expect(selectRecoveryMode(5, null)).toBe("snapshot");
  });
});

describe("projection cadence", () => {
  it("publishes immediately when due and schedules one persisted flush for an in-window burst", () => {
    expect(decideProjectionAction(null, 500, false)).toEqual({ kind: "publish" });
    expect(decideProjectionAction(1_000, 2_000, false)).toEqual({ kind: "publish" });
    expect(decideProjectionAction(1_000, 1_200, false)).toEqual({ at: 2_000, kind: "schedule" });
    expect(decideProjectionAction(1_000, 1_200, true)).toEqual({ kind: "none" });
    expect(decideProjectionAction(2_000, 2_500, false)).toEqual({ at: 3_000, kind: "schedule" });
  });
});
