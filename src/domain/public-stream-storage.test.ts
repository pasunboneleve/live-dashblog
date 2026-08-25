import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTailLatencyGeometry } from "../visualizations/tail-latency-geometry";
import {
  PRESENTATION_WINDOW_MS,
  SAMPLE_LIMIT,
  TAIL_LATENCY_STREAM,
  projectTailLatency,
  type KeyedTimingSample,
} from "./tail-latency";
import {
  enforcePublicStreamRetention,
  type PublicStreamRetentionStore,
} from "./public-stream-storage";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("physical public-stream retention", () => {
  it("bounds actual SQLite rows, projection geometry, replay, and ancillary tables", () => {
    const database = createDatabase();
    const now = 1_000_000;
    for (let index = 0; index < SAMPLE_LIMIT + 350; index += 1) {
      database.prepare(
        "INSERT INTO samples (duration_ms, observed_at, route_class, status_class) VALUES (?, ?, 'article', '2xx')",
      ).run(index % 80, now - 1_000 + index);
    }
    for (let sequence = 1; sequence <= TAIL_LATENCY_STREAM.replayLimit + 100; sequence += 1) {
      database.prepare("INSERT INTO replay (sequence, generated_at, oldest_observed_at, payload) VALUES (?, ?, ?, '{}')")
        .run(sequence, now - 500, now - 1_000);
    }
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      database.prepare(
        `INSERT INTO current_projection (singleton, sequence, generated_at, last_broadcast_at, last_sample_id, payload)
         VALUES (1, ?, ?, ?, 0, '{}')
         ON CONFLICT(singleton) DO UPDATE SET sequence = excluded.sequence`,
      ).run(sequence, now, now);
    }

    inTransaction(database, () => enforcePublicStreamRetention(
      TAIL_LATENCY_STREAM,
      sqliteRetentionStore(database),
      now,
    ));

    const projection = projectTailLatency(readSamples(database), 10, now);
    const geometry = createTailLatencyGeometry(projection.points, now);
    expect(rowCount(database, "samples")).toBe(SAMPLE_LIMIT);
    expect(projection.points).toHaveLength(SAMPLE_LIMIT);
    expect(geometry.points).toHaveLength(SAMPLE_LIMIT);
    expect(rowCount(database, "replay")).toBe(TAIL_LATENCY_STREAM.replayLimit);
    expect(rowCount(database, "current_projection")).toBe(1);
    expect(rowCount(database, "sqlite_sequence")).toBe(1);
  });

  it("physically expires points and replay when traffic pauses", () => {
    const database = createDatabase();
    const now = 2_000_000;
    database.prepare(
      "INSERT INTO samples (duration_ms, observed_at, route_class, status_class) VALUES (42, ?, 'article', '2xx')",
    ).run(now);
    database.prepare(
      "INSERT INTO replay (sequence, generated_at, oldest_observed_at, payload) VALUES (1, ?, ?, '{}')",
    ).run(now, now);
    inTransaction(database, () => enforcePublicStreamRetention(
      TAIL_LATENCY_STREAM,
      sqliteRetentionStore(database),
      now,
    ));

    const afterPause = now + PRESENTATION_WINDOW_MS + 1;
    const result = inTransaction(database, () => enforcePublicStreamRetention(
      TAIL_LATENCY_STREAM,
      sqliteRetentionStore(database),
      afterPause,
    ));
    const projection = projectTailLatency(readSamples(database), 2, afterPause);
    const geometry = createTailLatencyGeometry(projection.points, afterPause);

    expect(result.timeExpired).toBe(true);
    expect(rowCount(database, "samples")).toBe(0);
    expect(rowCount(database, "replay")).toBe(0);
    expect(projection.points).toHaveLength(0);
    expect(geometry.points).toHaveLength(0);
  });

  it("deletes an expired replay even when its raw point was evicted earlier", () => {
    const database = createDatabase();
    const now = 3_000_000;
    database.prepare(
      "INSERT INTO samples (duration_ms, observed_at, route_class, status_class) VALUES (10, ?, 'article', '2xx')",
    ).run(now);
    database.prepare(
      "INSERT INTO replay (sequence, generated_at, oldest_observed_at, payload) VALUES (1, ?, ?, '{}')",
    ).run(now, now - PRESENTATION_WINDOW_MS - 1);

    const result = inTransaction(database, () => enforcePublicStreamRetention(
      TAIL_LATENCY_STREAM,
      sqliteRetentionStore(database),
      now,
    ));

    expect(result.pointsDeleted).toBe(0);
    expect(rowCount(database, "samples")).toBe(1);
    expect(rowCount(database, "replay")).toBe(0);
  });
});

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duration_ms REAL NOT NULL,
      observed_at INTEGER NOT NULL,
      route_class TEXT NOT NULL,
      status_class TEXT NOT NULL
    );
    CREATE TABLE current_projection (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      sequence INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      last_broadcast_at INTEGER NOT NULL,
      last_sample_id INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE replay (
      sequence INTEGER PRIMARY KEY,
      generated_at INTEGER NOT NULL,
      oldest_observed_at INTEGER,
      payload TEXT NOT NULL
    );
  `);
  return database;
}

function sqliteRetentionStore(database: DatabaseSync): PublicStreamRetentionStore {
  const changes = (sql: string, ...values: unknown[]) => Number(database.prepare(sql).run(...values).changes);
  return {
    deletePointsBeyond: (limit) => changes(
      "DELETE FROM samples WHERE id NOT IN (SELECT id FROM samples ORDER BY observed_at DESC, id DESC LIMIT ?)",
      limit,
    ),
    deletePointsOutside: (cutoff, now) => changes(
      "DELETE FROM samples WHERE observed_at < ? OR observed_at > ?",
      cutoff,
      now,
    ),
    deleteReplayBeyond: (limit) => changes(
      "DELETE FROM replay WHERE sequence NOT IN (SELECT sequence FROM replay ORDER BY sequence DESC LIMIT ?)",
      limit,
    ),
    deleteReplayContainingPointsBefore: (cutoff) => changes(
      "DELETE FROM replay WHERE oldest_observed_at IS NULL OR oldest_observed_at < ?",
      cutoff,
    ),
    deleteReplayOutside: (cutoff, now) => changes(
      "DELETE FROM replay WHERE generated_at < ? OR generated_at > ?",
      cutoff,
      now,
    ),
  };
}

function inTransaction<Result>(database: DatabaseSync, operation: () => Result): Result {
  database.exec("BEGIN");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function rowCount(database: DatabaseSync, table: string): number {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

function readSamples(database: DatabaseSync): KeyedTimingSample[] {
  return database.prepare(
    "SELECT id, duration_ms, observed_at FROM samples ORDER BY observed_at, id",
  ).all().map((row) => ({
    durationMs: Number(row.duration_ms),
    key: String(row.id),
    observedAt: Number(row.observed_at),
    routeClass: "article",
    statusClass: "2xx",
  }));
}
