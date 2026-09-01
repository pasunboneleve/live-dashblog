interface TraceSelectionDescription {
  projectionIsEmbedded: boolean;
  selectedBucket: { sampleTraceIds: readonly string[]; traceCount: number } | null;
  selectedTraceId: string | null;
  traceIsEmbeddedFallback: boolean;
}

/** Names the relationship between the visible waterfall and the selected interval. */
export function describeTraceSelection({
  projectionIsEmbedded,
  selectedBucket,
  selectedTraceId,
  traceIsEmbeddedFallback,
}: TraceSelectionDescription): string {
  if (projectionIsEmbedded) return "embedded example";
  if (traceIsEmbeddedFallback) return "embedded example · no retained live detail";
  if (selectedTraceId && selectedBucket?.sampleTraceIds.includes(selectedTraceId)) return "selected interval";
  if (selectedBucket?.traceCount === 0) return "previous selection · selected interval is empty";
  if (selectedBucket) return "previous selection · no retained detail for selected interval";
  return "previous selection";
}
