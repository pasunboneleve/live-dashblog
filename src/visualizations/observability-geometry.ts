import type { PublicObservabilityProjection } from "../domain/public-observability";

const WATERFALL_WIDTH = 720;
const LABEL_WIDTH = 170;
const DURATION_LABEL_WIDTH = 72;
const ROW_HEIGHT = 30;
const MIN_BAR_WIDTH = 2;

type TraceSample = PublicObservabilityProjection["traceSamples"][number];
type TimeBucket = PublicObservabilityProjection["timeSeries"]["buckets"][number];

export interface TimeSeriesGeometry {
  buckets: Array<{
    barHeight: number;
    endUnixMs: number;
    errorCount: number;
    pointY: number | null;
    startUnixMs: number;
    traceCount: number;
    x: number;
    width: number;
  }>;
  linePath: string;
  maximumRequestMs: number;
  viewBox: string;
}

export interface WaterfallGeometry {
  height: number;
  spans: Array<{
    barWidth: number;
    durationLabel: string;
    label: string;
    runtimeSide: string;
    spanId: string;
    x: number;
    y: number;
  }>;
  viewBox: string;
}

/** Maps one bounded trace onto stable keyed rows without creating a node per event sample. */
export function createWaterfallGeometry(trace: TraceSample | null): WaterfallGeometry {
  const chartWidth = WATERFALL_WIDTH - LABEL_WIDTH - DURATION_LABEL_WIDTH;
  const chartRight = WATERFALL_WIDTH - DURATION_LABEL_WIDTH;
  const durationMs = Math.max(1, trace?.observedWindowMs ?? 1);
  const spans = (trace?.spans ?? []).map((span, index) => {
    const x = Math.min(
      chartRight - MIN_BAR_WIDTH,
      LABEL_WIDTH + span.offsetMs / durationMs * chartWidth,
    );
    return {
      barWidth: Math.min(
        chartRight - x,
        Math.max(MIN_BAR_WIDTH, span.durationMs / durationMs * chartWidth),
      ),
      durationLabel: formatDuration(span.durationMs),
      label: span.name.replace(/^(browser|worker|durable-object)\./, ""),
      runtimeSide: span.runtimeSide,
      spanId: span.spanId,
      x,
      y: index * ROW_HEIGHT + 8,
    };
  });
  const height = Math.max(72, spans.length * ROW_HEIGHT + 12);
  return { height, spans, viewBox: `0 0 ${WATERFALL_WIDTH} ${height}` };
}

/** Maps clipped wall-clock buckets to hit targets, count bars, and request-latency points. */
export function createTimeSeriesGeometry(buckets: readonly TimeBucket[]): TimeSeriesGeometry {
  const width = 720;
  const height = 210;
  const left = 54;
  const right = 14;
  const top = 18;
  const bottom = 42;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const rangeStart = buckets[0]?.startUnixMs ?? 0;
  const rangeEnd = buckets.at(-1)?.endUnixMs ?? rangeStart + 1;
  const rangeDuration = Math.max(1, rangeEnd - rangeStart);
  const maximumRequestMs = Math.max(1, ...buckets.map((bucket) => bucket.requestP95Ms));
  const maximumTraceCount = Math.max(1, ...buckets.map((bucket) => bucket.traceCount));
  let populatedPointCount = 0;
  let previousBucketWasPopulated = false;
  const path: string[] = [];
  const geometryBuckets = buckets.map((bucket) => {
    const rawX = left + (bucket.startUnixMs - rangeStart) / rangeDuration * plotWidth;
    const rawWidth = (bucket.endUnixMs - bucket.startUnixMs) / rangeDuration * plotWidth;
    const x = rawX + Math.min(1, rawWidth / 2);
    const width = Math.max(2, rawWidth - Math.min(2, rawWidth));
    const pointY = bucket.traceCount === 0
      ? null
      : top + plotHeight * (1 - Math.log1p(bucket.requestP95Ms) / Math.log1p(maximumRequestMs));
    if (pointY !== null) {
      path.push(`${populatedPointCount > 0 && previousBucketWasPopulated ? "L" : "M"} ${(rawX + rawWidth / 2).toFixed(2)} ${pointY.toFixed(2)}`);
      populatedPointCount += 1;
    }
    previousBucketWasPopulated = pointY !== null;
    return {
      barHeight: bucket.traceCount === 0
        ? 0
        : Math.max(18, bucket.traceCount / maximumTraceCount * Math.min(76, plotHeight * 0.5)),
      endUnixMs: bucket.endUnixMs,
      errorCount: bucket.errorCount,
      pointY,
      startUnixMs: bucket.startUnixMs,
      traceCount: bucket.traceCount,
      width,
      x,
    };
  });
  return {
    buckets: geometryBuckets,
    linePath: path.join(" "),
    maximumRequestMs,
    viewBox: `0 0 ${width} ${height}`,
  };
}

function formatDuration(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} s`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}
