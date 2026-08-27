import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { JOINED_PUBLIC_TRACE } from "./fixtures/public-spans";
import { type PublicSpan } from "./public-span";
import {
  SqlPublicTraceStore,
  initializePublicTraceSchema,
  type TraceSql,
  type TraceSqlCursor,
  type TraceSqlValue,
} from "./public-trace-sql";
import {
  PUBLIC_TRACE_STREAM,
  enforceWholeTraceRetention,
  finalizeDueTraces,
  ingestPublicSpanBatch,
  nextTraceStoreAlarm,
  type PublicTraceStreamDefinition,
} from "./public-trace-store";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("whole-trace assembly", () => {
  it("accepts out-of-order spans and finalizes the joined trace after grace", () => {
    const { store } = createStore();
    const receivedAt = 1_000_000;
    const reversed = [...JOINED_PUBLIC_TRACE].reverse();

    const ingest = ingestPublicSpanBatch(PUBLIC_TRACE_STREAM, store, reversed, receivedAt);
    expect(ingest).toMatchObject({ duplicates: 0, finalized: 0, inserted: 5, updated: 0 });
    expect(store.dueTraceIds(receivedAt + PUBLIC_TRACE_STREAM.assemblyGraceMs - 1)).toEqual([]);
    expect(finalizeDueTraces(store, receivedAt + PUBLIC_TRACE_STREAM.assemblyGraceMs))
      .toEqual({ finalized: 1, invalidTracesDeleted: 0 });
    expect(store.counts()).toEqual({ spans: 5, traces: 1 });
  });

  it("does not reopen a finalized trace for an exact duplicate", () => {
    const { database, store } = createStore();
    const receivedAt = 2_000_000;
    ingestPublicSpanBatch(PUBLIC_TRACE_STREAM, store, JOINED_PUBLIC_TRACE, receivedAt);
    finalizeDueTraces(store, receivedAt + PUBLIC_TRACE_STREAM.assemblyGraceMs);

    const duplicate = ingestPublicSpanBatch(
      PUBLIC_TRACE_STREAM,
      store,
      [JOINED_PUBLIC_TRACE[0]!],
      receivedAt + PUBLIC_TRACE_STREAM.assemblyGraceMs + 1,
    );

    expect(duplicate.duplicates).toBe(1);
    expect(readFinalizedAt(database)).toBe(receivedAt + PUBLIC_TRACE_STREAM.assemblyGraceMs);
  });

  it("reopens and refinalizes a trace when a late span changes it", () => {
    const { database, store } = createStore();
    const receivedAt = 3_000_000;
    ingestPublicSpanBatch(PUBLIC_TRACE_STREAM, store, JOINED_PUBLIC_TRACE.slice(0, 2), receivedAt);
    finalizeDueTraces(store, receivedAt + PUBLIC_TRACE_STREAM.assemblyGraceMs);

    const lateAt = receivedAt + PUBLIC_TRACE_STREAM.assemblyGraceMs + 1;
    const late = ingestPublicSpanBatch(PUBLIC_TRACE_STREAM, store, JOINED_PUBLIC_TRACE.slice(2), lateAt);
    expect(late.inserted).toBe(3);
    expect(readFinalizedAt(database)).toBeNull();
    expect(finalizeDueTraces(store, lateAt + PUBLIC_TRACE_STREAM.assemblyGraceMs))
      .toEqual({ finalized: 1, invalidTracesDeleted: 0 });
    expect(store.counts()).toEqual({ spans: 5, traces: 1 });
  });

  it("deletes an invalid incomplete trace after the assembly grace", () => {
    const { store } = createStore();
    const receivedAt = 4_000_000;
    const orphan = { ...JOINED_PUBLIC_TRACE[2]!, parentSpanId: "1111111111111111" };
    ingestPublicSpanBatch(PUBLIC_TRACE_STREAM, store, [orphan], receivedAt);

    expect(finalizeDueTraces(store, receivedAt + PUBLIC_TRACE_STREAM.assemblyGraceMs))
      .toEqual({ finalized: 0, invalidTracesDeleted: 1 });
    expect(store.counts()).toEqual({ spans: 0, traces: 0 });
  });

  it("fails closed instead of presenting a partial trace when stored payload is corrupt", () => {
    const { database, store } = createStore();
    const receivedAt = 4_500_000;
    ingestPublicSpanBatch(PUBLIC_TRACE_STREAM, store, JOINED_PUBLIC_TRACE, receivedAt);
    database.prepare("UPDATE public_spans SET payload = ? WHERE span_id = ?")
      .run("not-json", JOINED_PUBLIC_TRACE[2]!.spanId);

    expect(finalizeDueTraces(store, receivedAt + PUBLIC_TRACE_STREAM.assemblyGraceMs))
      .toEqual({ finalized: 0, invalidTracesDeleted: 1 });
    expect(store.counts()).toEqual({ spans: 0, traces: 0 });
  });
});

describe("physical whole-trace bounds", () => {
  it("deletes an entire trace that exceeds its per-trace span cap", () => {
    const { store } = createStore();
    const stream = { ...PUBLIC_TRACE_STREAM, maxSpansPerTrace: 2 };
    const result = ingestPublicSpanBatch(stream, store, JOINED_PUBLIC_TRACE, 5_000_000);

    expect(result.oversizedTracesDeleted).toBe(1);
    expect(store.counts()).toEqual({ spans: 0, traces: 0 });
  });

  it("evicts oldest whole traces for both trace and total-span capacity", () => {
    const { store } = createStore();
    const stream: PublicTraceStreamDefinition = {
      ...PUBLIC_TRACE_STREAM,
      maxSpansPerTrace: 8,
      maxTotalSpans: 5,
      maxTraces: 2,
    };
    for (let index = 0; index < 4; index += 1) {
      ingestPublicSpanBatch(stream, store, rekeyTrace(JOINED_PUBLIC_TRACE.slice(0, 2), index), 6_000_000 + index);
    }

    expect(store.counts()).toEqual({ spans: 4, traces: 2 });
    expect(store.readTrace(traceIdFor(0))).toEqual([]);
    expect(store.readTrace(traceIdFor(1))).toEqual([]);
    expect(store.readTrace(traceIdFor(2))).toHaveLength(2);
    expect(store.readTrace(traceIdFor(3))).toHaveLength(2);
  });

  it("physically expires every span in an aged trace when traffic pauses", () => {
    const { store } = createStore();
    const receivedAt = 7_000_000;
    ingestPublicSpanBatch(PUBLIC_TRACE_STREAM, store, JOINED_PUBLIC_TRACE, receivedAt);

    const result = enforceWholeTraceRetention(
      PUBLIC_TRACE_STREAM,
      store,
      receivedAt + PUBLIC_TRACE_STREAM.presentationDurationMs + 1,
    );
    expect(result).toEqual({ spansDeleted: 5, tracesDeleted: 1 });
    expect(store.counts()).toEqual({ spans: 0, traces: 0 });
  });

  it("derives the next alarm from assembly and presentation deadlines", () => {
    expect(nextTraceStoreAlarm(PUBLIC_TRACE_STREAM, 5_000, 2_000)).toBe(5_000);
    expect(nextTraceStoreAlarm(PUBLIC_TRACE_STREAM, null, 2_000))
      .toBe(2_000 + PUBLIC_TRACE_STREAM.presentationDurationMs + 1);
    expect(nextTraceStoreAlarm(PUBLIC_TRACE_STREAM, null, null)).toBeNull();
  });

  it("recovers pending trace state through a new store instance", () => {
    const { database, store } = createStore();
    const receivedAt = 8_000_000;
    ingestPublicSpanBatch(PUBLIC_TRACE_STREAM, store, JOINED_PUBLIC_TRACE, receivedAt);

    const recovered = new SqlPublicTraceStore(nodeSql(database));
    expect(recovered.counts()).toEqual({ spans: 5, traces: 1 });
    expect(recovered.nextFinalizeAt()).toBe(receivedAt + PUBLIC_TRACE_STREAM.assemblyGraceMs);
    expect(finalizeDueTraces(recovered, receivedAt + PUBLIC_TRACE_STREAM.assemblyGraceMs))
      .toEqual({ finalized: 1, invalidTracesDeleted: 0 });
  });
});

function createStore(): { database: DatabaseSync; store: SqlPublicTraceStore } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = nodeSql(database);
  initializePublicTraceSchema(sql);
  return { database, store: new SqlPublicTraceStore(sql) };
}

function nodeSql(database: DatabaseSync): TraceSql {
  return {
    exec<Row>(query: string, ...bindings: TraceSqlValue[]): TraceSqlCursor<Row> {
      if (bindings.length === 0 && query.includes(";")) {
        database.exec(query);
        return { rowsWritten: 0, toArray: () => [] };
      }
      const statement = database.prepare(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
        const rows = statement.all(...bindings) as Row[];
        return { rowsWritten: 0, toArray: () => rows };
      }
      const result = statement.run(...bindings);
      return { rowsWritten: Number(result.changes), toArray: () => [] };
    },
  };
}

function readFinalizedAt(database: DatabaseSync): number | null {
  const row = database.prepare("SELECT finalized_at FROM public_traces LIMIT 1").get();
  return row?.finalized_at === null || row?.finalized_at === undefined ? null : Number(row.finalized_at);
}

function rekeyTrace(spans: readonly PublicSpan[], index: number): PublicSpan[] {
  const traceId = traceIdFor(index);
  const idMap = new Map(spans.map((span, spanIndex) => [span.spanId, spanIdFor(index, spanIndex)]));
  return spans.map((span) => ({
    ...span,
    parentSpanId: span.parentSpanId === null ? null : idMap.get(span.parentSpanId) ?? null,
    spanId: idMap.get(span.spanId)!,
    traceId,
  }));
}

function traceIdFor(index: number): string {
  return (index + 1).toString(16).padStart(32, "0");
}

function spanIdFor(traceIndex: number, spanIndex: number): string {
  return (traceIndex * 100 + spanIndex + 1).toString(16).padStart(16, "0");
}
