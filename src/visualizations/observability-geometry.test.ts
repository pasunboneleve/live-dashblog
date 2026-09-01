import { describe, expect, it } from "vitest";
import { STATIC_OBSERVABILITY_PROJECTION } from "../domain/public-observability";
import { createWaterfallGeometry } from "./observability-geometry";

describe("observability waterfall geometry", () => {
  it("keeps every joined span keyed and inside the responsive view box", () => {
    const geometry = createWaterfallGeometry(STATIC_OBSERVABILITY_PROJECTION.slowTraces[0] ?? null);

    expect(geometry.spans).toHaveLength(5);
    expect(new Set(geometry.spans.map((span) => span.spanId)).size).toBe(5);
    expect(geometry.spans.every((span) => span.x >= 190 && span.x + span.barWidth <= 720)).toBe(true);
    expect(geometry.viewBox).toBe(`0 0 720 ${geometry.height}`);
  });

  it("returns an accessible empty canvas", () => {
    expect(createWaterfallGeometry(null)).toEqual({ height: 72, spans: [], viewBox: "0 0 720 72" });
  });

  it("keeps a zero-duration trailing span visible inside the chart", () => {
    const trace = STATIC_OBSERVABILITY_PROJECTION.slowTraces[0]!;
    const trailing = {
      ...trace.spans.at(-1)!,
      durationMs: 0,
      offsetMs: trace.durationMs,
      spanId: "ffffffffffffffff",
    };
    const geometry = createWaterfallGeometry({ ...trace, spans: [...trace.spans, trailing] });
    const bar = geometry.spans.at(-1)!;

    expect(bar.x).toBe(718);
    expect(bar.barWidth).toBe(2);
  });
});
