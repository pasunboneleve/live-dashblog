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
  it("derives aggregates, heatmap buckets, and a joined waterfall", () => {
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
    expect(projection.heatmap.reduce((count, bucket) => count + bucket.count, 0)).toBe(5);
    expect(projection.slowTraces[0]).toMatchObject({ durationMs: 99, spans: expect.any(Array) });
    expect(projection.slowTraces[0]!.spans.map((span) => span.name)).toEqual([
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
      heatmap: expect.arrayContaining([expect.objectContaining({ count: 0 })]),
      sampling: { admittedTraceCount: 0, droppedTraceCount: 3, sampleRate: 0.5 },
      dataExpiresAtUnixMs: 1_800_000_002_000,
      slowTraces: [],
      spanCount: 0,
      traceCount: 0,
    });
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
