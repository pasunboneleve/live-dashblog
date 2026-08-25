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
  const { areaPath, linePath } = createPaths(chartPoints);

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

/** Interpolates only target-window points, so animation cannot resurrect expired history. */
export function interpolateTailLatencyGeometry(
  from: TailLatencyGeometry,
  to: TailLatencyGeometry,
  progress: number,
): TailLatencyGeometry {
  const boundedProgress = Math.min(1, Math.max(0, progress));
  if (boundedProgress === 1) return to;

  const previousByKey = new Map(from.points.map((point) => [point.key, point]));
  if (!to.points.some((point) => previousByKey.has(point.key))) return to;

  const inverseScale = interpolate(1 / from.yMaximumMs, 1 / to.yMaximumMs, boundedProgress);
  const yMaximumMs = 1 / inverseScale;
  const points = to.points.map((target) => {
    const origin = previousByKey.get(target.key) ?? nearestPointByX(from.points, target.x) ?? target;
    const durationMs = interpolate(origin.durationMs, target.durationMs, boundedProgress);
    return {
      ...target,
      durationMs,
      x: interpolate(origin.x, target.x, boundedProgress),
      y: BOTTOM - (durationMs / yMaximumMs) * (BOTTOM - TOP),
    };
  });
  const { areaPath, linePath } = createPaths(points);
  return {
    ...to,
    areaPath,
    latest: points.at(-1) ?? null,
    linePath,
    points,
    yMaximumMs,
  };
}

function createPaths(points: readonly ChartPoint[]): Pick<TailLatencyGeometry, "areaPath" | "linePath"> {
  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
  const areaPath = points.length === 0
    ? ""
    : `M${points[0]?.x.toFixed(2)},${BOTTOM} ${linePath.replace(/^M/, "L")} L${points.at(-1)?.x.toFixed(2)},${BOTTOM} Z`;
  return { areaPath, linePath };
}

function nearestPointByX(points: readonly ChartPoint[], x: number): ChartPoint | null {
  let nearest: ChartPoint | null = null;
  for (const point of points) {
    if (nearest === null || Math.abs(point.x - x) < Math.abs(nearest.x - x)) {
      nearest = point;
    }
  }
  return nearest;
}

function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)] ?? 0;
}

function roundScaleMaximum(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, value)));
  return Math.ceil(value / magnitude) * magnitude;
}
