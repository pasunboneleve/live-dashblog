import type { PublicObservabilityProjection } from "../domain/public-observability";

const WATERFALL_WIDTH = 720;
const LABEL_WIDTH = 190;
const ROW_HEIGHT = 30;
const MIN_BAR_WIDTH = 2;

type SlowTrace = PublicObservabilityProjection["slowTraces"][number];

export interface WaterfallGeometry {
  height: number;
  spans: Array<{
    barWidth: number;
    label: string;
    runtimeSide: string;
    spanId: string;
    x: number;
    y: number;
  }>;
  viewBox: string;
}

/** Maps one bounded trace onto stable keyed rows without creating a node per event sample. */
export function createWaterfallGeometry(trace: SlowTrace | null): WaterfallGeometry {
  const chartWidth = WATERFALL_WIDTH - LABEL_WIDTH;
  const durationMs = Math.max(1, trace?.durationMs ?? 1);
  const spans = (trace?.spans ?? []).map((span, index) => {
    const x = Math.min(
      WATERFALL_WIDTH - MIN_BAR_WIDTH,
      LABEL_WIDTH + span.offsetMs / durationMs * chartWidth,
    );
    return {
      barWidth: Math.min(
        WATERFALL_WIDTH - x,
        Math.max(MIN_BAR_WIDTH, span.durationMs / durationMs * chartWidth),
      ),
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
