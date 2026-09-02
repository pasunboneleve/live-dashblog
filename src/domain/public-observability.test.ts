import { describe, expect, it } from "vitest";
import { JOINED_PUBLIC_TRACE } from "./fixtures/public-spans";
import {
  STATIC_OBSERVABILITY_PROJECTION,
  acceptObservabilityEnvelope,
  acceptObservabilitySnapshot,
  projectPublicObservability,
  publicObservabilityProjectionSchema,
} from "./public-observability";

describe("public observability projection", () => {
  it("derives aggregates, clipped time buckets, and a joined trace sample", () => {
    const projection = projectPublicObservability([JOINED_PUBLIC_TRACE], 7, 1_800_000_001_000);

    expect(projection).toMatchObject({
      dataExpiresAtUnixMs: 1_800_000_300_001,
      sequence: 7,
      spanCount: 5,
      traceCount: 1,
      aggregates: {
        overall: { count: 5, errorCount: 0, errorRate: 0, maxMs: 48, p50Ms: 18, p95Ms: 48 },
      },
      sampling: { admittedTraceCount: 1, droppedTraceCount: 0, sampleRate: 1 },
    });
    expect(projection.aggregates.byRuntimeSide.map(({ key, count }) => ({ key, count }))).toEqual([
      { key: "browser", count: 2 },
      { key: "durable-object", count: 1 },
      { key: "worker", count: 2 },
    ]);
    expect(projection.durationBands.reduce((count, bucket) => count + bucket.count, 0)).toBe(5);
    expect(projection.timeSeries.buckets).toHaveLength(31);
    expect(projection.timeSeries.buckets[0]!.startUnixMs).toBe(1_799_999_701_000);
    expect(projection.timeSeries.buckets.at(-1)!.endUnixMs).toBe(1_800_000_001_000);
    expect(projection.timeSeries.buckets.reduce((count, bucket) => count + bucket.traceCount, 0)).toBe(1);
    expect(projection.timeSeries.buckets.find((bucket) => bucket.traceCount === 1)).toMatchObject({
      requestMaxMs: 48,
      requestP95Ms: 48,
      sampleTraceIds: [JOINED_PUBLIC_TRACE[0]!.traceId],
    });
    expect(projection.traceSamples[0]).toMatchObject({
      observedWindowMs: 99,
      requestDurationMs: 48,
      requestStartedAtUnixMs: JOINED_PUBLIC_TRACE[0]!.startedAtUnixMs,
      spans: expect.any(Array),
    });
    expect(projection.traceSamples[0]!.spans.map((span) => span.name)).toEqual([
      "worker.article-request",
      "browser.document-load",
      "browser.snapshot-fetch",
      "worker.snapshot-request",
      "durable-object.snapshot",
    ]);
  });

  it("represents an honest empty window", () => {
    const projection = projectPublicObservability([], 9, 1_800_000_001_000, {
      droppedTraceCount: 3,
      sampleRate: 0.5,
      samplingExpiresAtUnixMs: 1_800_000_002_000,
    });

    expect(projection).toMatchObject({
      aggregates: { overall: { count: 0, errorRate: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 } },
      durationBands: expect.arrayContaining([expect.objectContaining({ count: 0 })]),
      sampling: { admittedTraceCount: 0, droppedTraceCount: 3, sampleRate: 0.5 },
      dataExpiresAtUnixMs: 1_800_000_002_000,
      traceSamples: [],
      spanCount: 0,
      traceCount: 0,
    });
    expect(projection.timeSeries.buckets).toHaveLength(31);
    expect(projection.timeSeries.buckets.every((bucket) => bucket.traceCount === 0)).toBe(true);
  });

  it("keeps the clipped bucket grid schema-valid at the Unix epoch", () => {
    const projection = projectPublicObservability([], 0, 0);

    expect(projection.timeSeries.buckets).toHaveLength(1);
    expect(projection.timeSeries.buckets[0]).toMatchObject({ startUnixMs: 0, endUnixMs: 0 });
    expect(publicObservabilityProjectionSchema.safeParse(projection).success).toBe(true);
  });

  it("aggregates root-request duration instead of idle time in the observed trace window", () => {
    const longLived = JOINED_PUBLIC_TRACE.map((span, index) => ({
      ...span,
      durationMs: index === 0 ? 48 : span.durationMs,
      startedAtUnixMs: index === JOINED_PUBLIC_TRACE.length - 1
        ? span.startedAtUnixMs + 10_000
        : span.startedAtUnixMs,
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));

    const projection = projectPublicObservability([longLived], 8, 1_800_000_011_000);
    const populated = projection.timeSeries.buckets.find((bucket) => bucket.traceCount === 1)!;

    expect(projection.traceSamples[0]).toMatchObject({ requestDurationMs: 48, observedWindowMs: 10_094 });
    expect(populated).toMatchObject({ requestP95Ms: 48, requestMaxMs: 48 });
  });

  it("buckets and ranks a trace by its root request clock", () => {
    const clockSkewed = JOINED_PUBLIC_TRACE.map((span, index) => ({
      ...span,
      startedAtUnixMs: index === 1 ? JOINED_PUBLIC_TRACE[0]!.startedAtUnixMs - 15_000 : span.startedAtUnixMs,
      traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }));
    const generatedAt = JOINED_PUBLIC_TRACE[0]!.startedAtUnixMs + 1_000;
    const projection = projectPublicObservability([clockSkewed], 10, generatedAt);
    const populated = projection.timeSeries.buckets.find((bucket) => bucket.traceCount === 1)!;

    expect(projection.traceSamples[0]!.requestStartedAtUnixMs).toBe(JOINED_PUBLIC_TRACE[0]!.startedAtUnixMs);
    expect(populated.startUnixMs).toBeLessThanOrEqual(JOINED_PUBLIC_TRACE[0]!.startedAtUnixMs);
    expect(populated.endUnixMs).toBeGreaterThan(JOINED_PUBLIC_TRACE[0]!.startedAtUnixMs);
  });

  it("ships a schema-valid deterministic static fallback", () => {
    expect(publicObservabilityProjectionSchema.safeParse(STATIC_OBSERVABILITY_PROJECTION).success)
      .toBe(true);
    expect(STATIC_OBSERVABILITY_PROJECTION.sequence).toBe(0);
  });

  it("accepts only valid snapshots and newer stream sequences", () => {
    const projection = projectPublicObservability([JOINED_PUBLIC_TRACE], 4, 1_800_000_001_000);
    expect(acceptObservabilitySnapshot(projection)?.sequence).toBe(4);
    expect(acceptObservabilitySnapshot({ ...projection, traceCount: -1 })).toBeNull();
    expect(acceptObservabilityEnvelope(3, {
      projection,
      stream: "observability",
      type: "projection",
    })?.sequence).toBe(4);
    expect(acceptObservabilityEnvelope(4, {
      projection,
      stream: "observability",
      type: "projection",
    })).toBeNull();
  });
});
