import { describe, expect, it } from "vitest";
import { STATIC_OBSERVABILITY_PROJECTION } from "../domain/public-observability";
import { createTimeSeriesGeometry, createWaterfallGeometry } from "./observability-geometry";

describe("observability waterfall geometry", () => {
  it("keeps every joined span keyed and inside the responsive view box", () => {
    const geometry = createWaterfallGeometry(STATIC_OBSERVABILITY_PROJECTION.traceSamples[0] ?? null);

    expect(geometry.spans).toHaveLength(5);
    expect(new Set(geometry.spans.map((span) => span.spanId)).size).toBe(5);
    expect(geometry.spans.every((span) => span.x >= 170 && span.x + span.barWidth <= 648)).toBe(true);
    expect(geometry.viewBox).toBe(`0 0 720 ${geometry.height}`);
  });

  it("returns an accessible empty canvas", () => {
    expect(createWaterfallGeometry(null)).toEqual({ height: 72, spans: [], viewBox: "0 0 720 72" });
  });

  it("keeps a zero-duration trailing span visible inside the chart", () => {
    const trace = STATIC_OBSERVABILITY_PROJECTION.traceSamples[0]!;
    const trailing = {
      ...trace.spans.at(-1)!,
      durationMs: 0,
      offsetMs: trace.observedWindowMs,
      spanId: "ffffffffffffffff",
    };
    const geometry = createWaterfallGeometry({ ...trace, spans: [...trace.spans, trailing] });
    const bar = geometry.spans.at(-1)!;

    expect(bar.x).toBe(646);
    expect(bar.barWidth).toBe(2);
  });

  it("keeps clipped time buckets clickable while separating count bars from request latency", () => {
    const geometry = createTimeSeriesGeometry(STATIC_OBSERVABILITY_PROJECTION.timeSeries.buckets);
    const populated = geometry.buckets.filter((bucket) => bucket.traceCount > 0);

    expect(geometry.buckets).toHaveLength(31);
    expect(populated).toHaveLength(1);
    expect(populated[0]).toMatchObject({ traceCount: 1, pointY: expect.any(Number) });
    expect(geometry.linePath).toMatch(/^M /);
    expect(geometry.viewBox).toBe("0 0 720 210");
  });

  it("breaks the latency path across intervals with no requests", () => {
    const base = STATIC_OBSERVABILITY_PROJECTION.timeSeries.buckets.find((bucket) => bucket.traceCount > 0)!;
    const buckets = [
      { ...base, startUnixMs: 0, endUnixMs: 10_000 },
      { ...base, startUnixMs: 10_000, endUnixMs: 20_000, traceCount: 0, requestP95Ms: 0 },
      { ...base, startUnixMs: 20_000, endUnixMs: 30_000 },
    ];

    expect(createTimeSeriesGeometry(buckets).linePath.match(/M /g)).toHaveLength(2);
  });
});
