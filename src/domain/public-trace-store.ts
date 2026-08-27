import { type PublicSpan, validateCompleteTrace } from "./public-span";

export interface PublicTraceStreamDefinition {
  assemblyGraceMs: number;
  broadcastIntervalMs: number;
  maxSpansPerTrace: number;
  maxTotalSpans: number;
  maxTraces: number;
  name: "observability";
  presentationDurationMs: number;
  replayLimit: number;
}

export const PUBLIC_TRACE_STREAM: PublicTraceStreamDefinition = Object.freeze({
  assemblyGraceMs: 5_000,
  broadcastIntervalMs: 5_000,
  maxSpansPerTrace: 16,
  maxTotalSpans: 960,
  maxTraces: 120,
  name: "observability",
  presentationDurationMs: 5 * 60_000,
  replayLimit: 61,
});

export interface TraceStoreCounts {
  spans: number;
  traces: number;
}

export interface TraceDeletion {
  spansDeleted: number;
  tracesDeleted: number;
}

export type SpanUpsertResult = "duplicate" | "inserted" | "updated";

/**
 * Physical operations required by the whole-trace policy. Implementations must make
 * each ingestPublicSpanBatch call atomic and cascade every trace deletion to spans.
 */
export interface PublicTraceStore {
  counts(): TraceStoreCounts;
  deleteOldestTrace(): TraceDeletion;
  deleteTrace(traceId: string): TraceDeletion;
  deleteTracesSeenOutside(cutoff: number, now: number): TraceDeletion;
  dueTraceIds(now: number): string[];
  markFinalized(traceId: string, finalizedAt: number): void;
  readFinalizedTraces(): PublicSpan[][];
  readTrace(traceId: string): PublicSpan[];
  spanCount(traceId: string): number;
  upsertSpan(span: PublicSpan, receivedAt: number, finalizeAfter: number): SpanUpsertResult;
}

export interface PublicSpanBatchResult {
  duplicates: number;
  finalized: number;
  inserted: number;
  invalidTracesDeleted: number;
  oversizedTracesDeleted: number;
  retention: TraceDeletion;
  updated: number;
}

/**
 * Upserts out-of-order spans, reopens changed finalized traces, then finalizes and
 * evicts only complete trace units. The caller owns the surrounding transaction.
 */
export function ingestPublicSpanBatch(
  stream: PublicTraceStreamDefinition,
  store: PublicTraceStore,
  spans: readonly PublicSpan[],
  receivedAt: number,
): PublicSpanBatchResult {
  const result: PublicSpanBatchResult = {
    duplicates: 0,
    finalized: 0,
    inserted: 0,
    invalidTracesDeleted: 0,
    oversizedTracesDeleted: 0,
    retention: { spansDeleted: 0, tracesDeleted: 0 },
    updated: 0,
  };

  for (const traceSpans of groupByTrace(spans).values()) {
    const traceId = traceSpans[0]!.traceId;
    for (const span of traceSpans) {
      const upsert = store.upsertSpan(span, receivedAt, receivedAt + stream.assemblyGraceMs);
      result[upsert === "duplicate" ? "duplicates" : upsert === "inserted" ? "inserted" : "updated"] += 1;
    }
    if (store.spanCount(traceId) > stream.maxSpansPerTrace) {
      store.deleteTrace(traceId);
      result.oversizedTracesDeleted += 1;
    }
  }

  finalizeDueTraces(store, receivedAt, result);
  result.retention = enforceWholeTraceRetention(stream, store, receivedAt);
  return result;
}

/** Finalizes stable valid traces and deletes invalid assemblies as one unit. */
export function finalizeDueTraces(
  store: PublicTraceStore,
  now: number,
  result?: PublicSpanBatchResult,
): { finalized: number; invalidTracesDeleted: number } {
  let finalized = 0;
  let invalidTracesDeleted = 0;
  for (const traceId of store.dueTraceIds(now)) {
    const validation = validateCompleteTrace(store.readTrace(traceId));
    if (validation.valid) {
      store.markFinalized(traceId, now);
      finalized += 1;
    } else {
      store.deleteTrace(traceId);
      invalidTracesDeleted += 1;
    }
  }
  if (result) {
    result.finalized += finalized;
    result.invalidTracesDeleted += invalidTracesDeleted;
  }
  return { finalized, invalidTracesDeleted };
}

/** Applies time, trace-count, and total-span bounds through whole-trace deletion. */
export function enforceWholeTraceRetention(
  stream: PublicTraceStreamDefinition,
  store: PublicTraceStore,
  now: number,
): TraceDeletion {
  const deleted = store.deleteTracesSeenOutside(now - stream.presentationDurationMs, now);
  let counts = store.counts();
  while (counts.traces > stream.maxTraces || counts.spans > stream.maxTotalSpans) {
    const oldest = store.deleteOldestTrace();
    if (oldest.tracesDeleted === 0) {
      throw new Error("Whole-trace retention could not delete an overflowing trace.");
    }
    deleted.tracesDeleted += oldest.tracesDeleted;
    deleted.spansDeleted += oldest.spansDeleted;
    counts = store.counts();
  }
  return deleted;
}

export function nextTraceStoreAlarm(
  stream: PublicTraceStreamDefinition,
  pendingFinalizeAt: number | null,
  oldestFirstSeenAt: number | null,
): number | null {
  const expiryAt = oldestFirstSeenAt === null
    ? null
    : oldestFirstSeenAt + stream.presentationDurationMs + 1;
  const candidates = [pendingFinalizeAt, expiryAt].filter((value): value is number => value !== null);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

function groupByTrace(spans: readonly PublicSpan[]): Map<string, PublicSpan[]> {
  const groups = new Map<string, PublicSpan[]>();
  for (const span of spans) {
    const group = groups.get(span.traceId);
    if (group) group.push(span);
    else groups.set(span.traceId, [span]);
  }
  return groups;
}
