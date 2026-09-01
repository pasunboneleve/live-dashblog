import { describe, expect, it } from "vitest";
import { JOINED_PUBLIC_TRACE } from "../domain/fixtures/public-spans";
import { projectPublicObservability, STATIC_OBSERVABILITY_PROJECTION } from "../domain/public-observability";
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
    expect(createWaterfallGeometry(null)).toEqual({
      height: 72,
      initialActivityMs: 0,
      laterSpans: [],
      spans: [],
      viewBox: "0 0 720 72",
    });
  });

  it("keeps a zero-duration span inside the initial activity visible in the chart", () => {
    const trace = STATIC_OBSERVABILITY_PROJECTION.traceSamples[0]!;
    const trailing = {
      ...trace.spans.at(-1)!,
      durationMs: 0,
      offsetMs: trace.observedWindowMs + 500,
      spanId: "ffffffffffffffff",
    };
    const geometry = createWaterfallGeometry({ ...trace, spans: [...trace.spans, trailing] });
    const bar = geometry.spans.at(-1)!;

    expect(bar.x).toBe(646);
    expect(bar.barWidth).toBe(2);
  });

  it("keeps later tab events without letting idle time flatten the operation waterfall", () => {
    const trace = STATIC_OBSERVABILITY_PROJECTION.traceSamples[0]!;
    const interaction = {
      ...trace.spans.at(-1)!,
      durationMs: 0,
      name: "browser.article-interaction" as const,
      offsetMs: 17_000,
      spanId: "eeeeeeeeeeeeeeee",
    };
    const geometry = createWaterfallGeometry({
      ...trace,
      observedWindowMs: 17_000,
      spans: [...trace.spans, interaction],
    });

    expect(geometry.spans).toHaveLength(trace.spans.length);
    expect(geometry.initialActivityMs).toBeLessThan(1_000);
    expect(geometry.laterSpans).toEqual([expect.objectContaining({
      label: "article-interaction",
      offsetLabel: "+17 s",
      spanId: interaction.spanId,
    })]);
    expect(Math.max(...geometry.spans.map((span) => span.barWidth))).toBeGreaterThan(100);
  });

  it("moves a later reconnect out of the first-pass scale", () => {
    const trace = STATIC_OBSERVABILITY_PROJECTION.traceSamples[0]!;
    const initialStream = {
      ...trace.spans.at(-1)!,
      durationMs: 20,
      name: "browser.stream-connect" as const,
      offsetMs: trace.observedWindowMs + 10,
      runtimeSide: "browser" as const,
      spanId: "cccccccccccccccc",
    };
    const reconnect = {
      ...initialStream,
      offsetMs: 44_000,
      spanId: "dddddddddddddddd",
    };
    const geometry = createWaterfallGeometry({
      ...trace,
      observedWindowMs: 44_000 + reconnect.durationMs,
      spans: [...trace.spans, initialStream, reconnect],
    });

    expect(geometry.initialActivityMs).toBeLessThan(1_000);
    expect(geometry.laterSpans).toEqual([expect.objectContaining({
      label: "stream-connect",
      offsetLabel: "+44 s",
      spanId: reconnect.spanId,
    })]);
  });

  it("preserves same-service elapsed time when the browser clock is early or late", () => {
    for (const browserClockSkewMs of [-15_000, 15_000]) {
      const clockSkewed = JOINED_PUBLIC_TRACE.map((span) => ({
        ...span,
        startedAtUnixMs: span.runtimeSide === "browser"
          ? span.startedAtUnixMs + browserClockSkewMs
          : span.startedAtUnixMs,
        traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }));
      const trace = projectPublicObservability(
        [clockSkewed],
        1,
        JOINED_PUBLIC_TRACE[0]!.startedAtUnixMs + 20_000,
      ).traceSamples[0]!;
      const root = trace.spans.find((span) => span.parentSpanId === null)!;
      const browserSpan = trace.spans.find((span) => span.runtimeSide === "browser")!;
      const earliestStartedAt = Math.min(...clockSkewed.map((span) => span.startedAtUnixMs));
      const interaction = {
        ...browserSpan,
        durationMs: 0,
        name: "browser.article-interaction" as const,
        offsetMs: JOINED_PUBLIC_TRACE[0]!.startedAtUnixMs + 17_000 + browserClockSkewMs - earliestStartedAt,
        parentSpanId: root.spanId,
        spanId: browserClockSkewMs < 0 ? "aaaaaaaaaaaaaaaa" : "9999999999999999",
      };
      const geometry = createWaterfallGeometry({
        ...trace,
        observedWindowMs: interaction.offsetMs,
        spans: [...trace.spans, interaction],
      });

      expect(geometry.spans).toHaveLength(trace.spans.length);
      expect(geometry.spans[0]).toMatchObject({ label: "article-request", x: 170 });
      expect(geometry.initialActivityMs).toBeLessThan(1_000);
      expect(geometry.laterSpans).toEqual([expect.objectContaining({ offsetLabel: "+17 s" })]);
    }
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
