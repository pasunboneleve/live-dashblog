import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { JOINED_PUBLIC_TRACE } from "./fixtures/public-spans";
import { projectPublicObservability } from "./public-observability";
import {
  SqlPublicObservabilityStore,
  initializePublicObservabilitySchema,
} from "./public-observability-sql";
import type { TraceSql, TraceSqlCursor, TraceSqlValue } from "./public-trace-sql";
import { PUBLIC_TRACE_STREAM } from "./public-trace-store";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("bounded observability projection replay", () => {
  it("migrates existing drop buckets to the latest-event retention key", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE observability_drop_buckets (
        bucket_at INTEGER PRIMARY KEY,
        dropped_trace_count INTEGER NOT NULL
      );
      INSERT INTO observability_drop_buckets (bucket_at, dropped_trace_count) VALUES (5000, 2);
    `);

    initializePublicObservabilitySchema(nodeSql(database));

    expect(database.prepare(
      "SELECT latest_event_at FROM observability_drop_buckets WHERE bucket_at = 5000",
    ).get()).toEqual({ latest_event_at: 5000 });
  });

  it("persists one current projection and replays only later sequences", () => {
    const { store } = createStore();
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      store.publish(projectPublicObservability([JOINED_PUBLIC_TRACE], sequence, 10_000 + sequence));
    }

    expect(store.counts()).toEqual({ current: 1, dropBuckets: 0, replay: 3, samplingBuckets: 0 });
    expect(store.readCurrent()?.sequence).toBe(3);
    expect(store.oldestReplaySequence()).toBe(1);
    expect(store.nextExpiryAt()).toBe(10_001 + PUBLIC_TRACE_STREAM.presentationDurationMs + 1);
    expect(store.replayAfter(1)?.map((projection) => projection.sequence)).toEqual([2, 3]);
  });

  it("enforces exact replay count and presentation-time bounds", () => {
    const { sql } = createStore();
    const stream = { ...PUBLIC_TRACE_STREAM, presentationDurationMs: 10, replayLimit: 3 };
    const bounded = new SqlPublicObservabilityStore(sql, stream);
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      bounded.publish(projectPublicObservability([JOINED_PUBLIC_TRACE], sequence, 20_000 + sequence));
    }
    expect(bounded.counts()).toEqual({ current: 1, dropBuckets: 0, replay: 3, samplingBuckets: 0 });
    expect(bounded.replayAfter(0)?.map((projection) => projection.sequence)).toEqual([4, 5, 6]);

    bounded.enforceRetention(20_020);
    expect(bounded.counts()).toEqual({ current: 1, dropBuckets: 0, replay: 0, samplingBuckets: 0 });
  });

  it("persists dirty cadence state and fails corrupt replay closed across restart", () => {
    const { database, sql, store } = createStore();
    store.markDirty();
    expect(store.nextPublishAt(30_000)).toBe(30_000);
    store.publish(projectPublicObservability([JOINED_PUBLIC_TRACE], 1, 30_000));
    store.markDirty();

    const recovered = new SqlPublicObservabilityStore(sql, PUBLIC_TRACE_STREAM);
    expect(recovered.nextPublishAt(30_001)).toBe(35_000);
    database.prepare("UPDATE observability_projection_replay SET payload = 'not-json'").run();
    expect(recovered.replayAfter(0)).toBeNull();
  });

  it("coalesces dropped traces into bounded cadence buckets", () => {
    const { sql } = createStore();
    const stream = { ...PUBLIC_TRACE_STREAM, presentationDurationMs: 20_000, replayLimit: 3 };
    const bounded = new SqlPublicObservabilityStore(sql, stream);
    bounded.recordDroppedTraces(40_001, 2);
    bounded.recordDroppedTraces(40_004, 3);
    bounded.recordDroppedTraces(45_001, 4);

    expect(bounded.droppedTraceCount(45_001)).toBe(9);
    expect(bounded.counts().dropBuckets).toBe(2);
    expect(bounded.nextExpiryAt()).toBe(60_005);
    expect(bounded.nextDropExpiryAt()).toBe(60_005);
    expect(bounded.droppedTraceCount(65_000)).toBe(4);
    expect(bounded.counts().dropBuckets).toBe(1);
  });

  it("reports and expires the root sampling rate independently from invalid traces", () => {
    const { sql } = createStore();
    const stream = { ...PUBLIC_TRACE_STREAM, presentationDurationMs: 20_000, replayLimit: 3 };
    const bounded = new SqlPublicObservabilityStore(sql, stream);
    bounded.recordSamplingDecision(40_001, true);
    bounded.recordSamplingDecision(40_002, true);
    bounded.recordSamplingDecision(40_003, false);
    bounded.recordDroppedTraces(40_004, 5);

    expect(bounded.samplingWindow(40_004)).toEqual({
      admittedTraceCount: 2,
      sampleRate: 2 / 3,
      sampledOutTraceCount: 1,
    });
    expect(bounded.counts().samplingBuckets).toBe(1);
    expect(bounded.nextExpiryAt()).toBe(60_004);
    expect(bounded.nextSamplingExpiryAt()).toBe(60_004);

    expect(bounded.samplingWindow(60_004)).toEqual({
      admittedTraceCount: 0,
      sampleRate: 1,
      sampledOutTraceCount: 0,
    });
    expect(bounded.counts().samplingBuckets).toBe(0);
  });
});

function createStore(): {
  database: DatabaseSync;
  sql: TraceSql;
  store: SqlPublicObservabilityStore;
} {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = nodeSql(database);
  initializePublicObservabilitySchema(sql);
  return { database, sql, store: new SqlPublicObservabilityStore(sql, PUBLIC_TRACE_STREAM) };
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
        return { rowsWritten: 0, toArray: () => statement.all(...bindings) as Row[] };
      }
      const result = statement.run(...bindings);
      return { rowsWritten: Number(result.changes), toArray: () => [] };
    },
  };
}
