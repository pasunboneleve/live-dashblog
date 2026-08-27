import { publicSpanSchema, type PublicSpan } from "./public-span";
import type {
  PublicTraceStore,
  SpanUpsertResult,
  TraceDeletion,
  TraceStoreCounts,
} from "./public-trace-store";

export interface TraceSqlCursor<Row> {
  rowsWritten: number;
  toArray(): Row[];
}

export type TraceSqlValue = string | number | null;

export interface TraceSql {
  exec<Row = Record<string, unknown>>(
    query: string,
    ...bindings: TraceSqlValue[]
  ): TraceSqlCursor<Row>;
}

interface CountRow {
  span_count: number;
  trace_count: number;
}

interface SpanCountRow {
  span_count: number;
}

interface PayloadRow {
  payload: string;
}

interface TraceIdRow {
  trace_id: string;
}

interface DeadlineRow {
  deadline: number | null;
}

/** Creates the normalized trace tables. Safe to call during every Durable Object construction. */
export function initializePublicTraceSchema(sql: TraceSql): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS public_traces (
      trace_id TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      finalize_after INTEGER NOT NULL,
      finalized_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS public_spans (
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (trace_id, span_id)
    );
    CREATE INDEX IF NOT EXISTS public_traces_finalize_idx
      ON public_traces (finalized_at, finalize_after);
    CREATE INDEX IF NOT EXISTS public_traces_first_seen_idx
      ON public_traces (first_seen_at, last_seen_at, trace_id);
  `);
}

/** SQLite implementation of the physical whole-trace storage port. */
export class SqlPublicTraceStore implements PublicTraceStore {
  constructor(private readonly sql: TraceSql) {}

  counts(): TraceStoreCounts {
    const row = this.sql.exec<CountRow>(`
      SELECT
        (SELECT COUNT(*) FROM public_traces) AS trace_count,
        (SELECT COUNT(*) FROM public_spans) AS span_count
    `).toArray()[0];
    return { spans: Number(row?.span_count ?? 0), traces: Number(row?.trace_count ?? 0) };
  }

  deleteOldestTrace(): TraceDeletion {
    const oldest = this.sql.exec<TraceIdRow>(`
      SELECT trace_id FROM public_traces
      ORDER BY first_seen_at, last_seen_at, trace_id
      LIMIT 1
    `).toArray()[0];
    return oldest ? this.deleteTrace(oldest.trace_id) : { spansDeleted: 0, tracesDeleted: 0 };
  }

  deleteTrace(traceId: string): TraceDeletion {
    const spansDeleted = this.sql.exec(
      "DELETE FROM public_spans WHERE trace_id = ?",
      traceId,
    ).rowsWritten;
    const tracesDeleted = this.sql.exec(
      "DELETE FROM public_traces WHERE trace_id = ?",
      traceId,
    ).rowsWritten;
    return { spansDeleted, tracesDeleted };
  }

  deleteTracesSeenOutside(cutoff: number, now: number): TraceDeletion {
    const traceIds = this.sql.exec<TraceIdRow>(`
      SELECT trace_id FROM public_traces
      WHERE first_seen_at < ? OR first_seen_at > ?
      ORDER BY first_seen_at, trace_id
    `, cutoff, now).toArray();
    return traceIds.reduce<TraceDeletion>((total, row) => {
      const deleted = this.deleteTrace(row.trace_id);
      return {
        spansDeleted: total.spansDeleted + deleted.spansDeleted,
        tracesDeleted: total.tracesDeleted + deleted.tracesDeleted,
      };
    }, { spansDeleted: 0, tracesDeleted: 0 });
  }

  dueTraceIds(now: number): string[] {
    return this.sql.exec<TraceIdRow>(`
      SELECT trace_id FROM public_traces
      WHERE finalized_at IS NULL AND finalize_after <= ?
      ORDER BY finalize_after, trace_id
    `, now).toArray().map((row) => row.trace_id);
  }

  markFinalized(traceId: string, finalizedAt: number): void {
    this.sql.exec(
      "UPDATE public_traces SET finalized_at = ? WHERE trace_id = ?",
      finalizedAt,
      traceId,
    );
  }

  nextFinalizeAt(): number | null {
    const value = this.sql.exec<DeadlineRow>(`
      SELECT MIN(finalize_after) AS deadline FROM public_traces
      WHERE finalized_at IS NULL
    `).toArray()[0]?.deadline;
    return value === null || value === undefined ? null : Number(value);
  }

  oldestFirstSeenAt(): number | null {
    const value = this.sql.exec<DeadlineRow>(
      "SELECT MIN(first_seen_at) AS deadline FROM public_traces",
    ).toArray()[0]?.deadline;
    return value === null || value === undefined ? null : Number(value);
  }

  readTrace(traceId: string): PublicSpan[] {
    const parsed = this.sql.exec<PayloadRow>(`
      SELECT payload FROM public_spans
      WHERE trace_id = ?
      ORDER BY span_id
    `, traceId).toArray().map((row) => publicSpanSchema.safeParse(parseJson(row.payload)));
    if (parsed.some((span) => !span.success)) return [];
    return parsed.flatMap((span) => span.success ? [span.data] : []);
  }

  spanCount(traceId: string): number {
    const row = this.sql.exec<SpanCountRow>(
      "SELECT COUNT(*) AS span_count FROM public_spans WHERE trace_id = ?",
      traceId,
    ).toArray()[0];
    return Number(row?.span_count ?? 0);
  }

  upsertSpan(span: PublicSpan, receivedAt: number, finalizeAfter: number): SpanUpsertResult {
    const payload = JSON.stringify(span);
    const existing = this.sql.exec<PayloadRow>(`
      SELECT payload FROM public_spans
      WHERE trace_id = ? AND span_id = ?
    `, span.traceId, span.spanId).toArray()[0];
    if (existing?.payload === payload) return "duplicate";

    this.sql.exec(`
      INSERT INTO public_traces (
        trace_id, first_seen_at, last_seen_at, finalize_after, finalized_at
      ) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(trace_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        finalize_after = excluded.finalize_after,
        finalized_at = NULL
    `, span.traceId, receivedAt, receivedAt, finalizeAfter);
    this.sql.exec(`
      INSERT INTO public_spans (trace_id, span_id, payload)
      VALUES (?, ?, ?)
      ON CONFLICT(trace_id, span_id) DO UPDATE SET payload = excluded.payload
    `, span.traceId, span.spanId, payload);
    return existing ? "updated" : "inserted";
  }
}

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}
