import { selectPresentablePoints } from "../domain/public-stream";
import {
  TAIL_LATENCY_STREAM,
  type LatencyPoint,
} from "../domain/tail-latency";

const LEFT = 42;
const RIGHT = 708;
const TOP = 16;
const BOTTOM = 184;

export interface ChartPoint extends LatencyPoint {
  x: number;
  y: number;
}

export interface TailLatencyGeometry {
  areaPath: string;
  latest: ChartPoint | null;
  linePath: string;
  maxMs: number;
  p95Ms: number;
  points: ChartPoint[];
  yMaximumMs: number;
}

export function projectionPresentationTime(
  projection: Pick<{ generatedAt: number; sequence: number }, "generatedAt" | "sequence">,
  browserNow: number,
): number {
  return projection.sequence === 0
    ? projection.generatedAt
    : Math.max(browserNow, projection.generatedAt);
}

/** Converts the shared presentation window into deterministic SVG geometry. */
export function createTailLatencyGeometry(
  points: readonly LatencyPoint[],
  now: number,
): TailLatencyGeometry {
  const visible = selectPresentablePoints(TAIL_LATENCY_STREAM, points, now);
  const durations = visible.map((point) => point.durationMs).sort((left, right) => left - right);
  const maxMs = durations.at(-1) ?? 0;
  const yMaximumMs = Math.max(25, roundScaleMaximum(maxMs));
  const cutoff = now - TAIL_LATENCY_STREAM.presentation.durationMs;
  const chartPoints = visible.map((point) => ({
    ...point,
    x: LEFT + ((point.observedAt - cutoff) / TAIL_LATENCY_STREAM.presentation.durationMs) * (RIGHT - LEFT),
    y: BOTTOM - (point.durationMs / yMaximumMs) * (BOTTOM - TOP),
  }));
  const linePath = chartPoints.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const areaPath = chartPoints.length === 0
    ? ""
    : `M${chartPoints[0]?.x.toFixed(2)},${BOTTOM} ${linePath.replace(/^M/, "L")} L${chartPoints.at(-1)?.x.toFixed(2)},${BOTTOM} Z`;

  return {
    areaPath,
    latest: chartPoints.at(-1) ?? null,
    linePath,
    maxMs,
    p95Ms: percentile(durations, 0.95),
    points: chartPoints,
    yMaximumMs,
  };
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)] ?? 0;
}

function roundScaleMaximum(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, value)));
  return Math.ceil(value / magnitude) * magnitude;
}
