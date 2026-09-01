import {
  publicObservabilityProjectionSchema,
  type PublicObservabilityProjection,
} from "./public-observability";
import type { TraceSql } from "./public-trace-sql";
import type { PublicTraceStreamDefinition } from "./public-trace-store";

interface ProjectionStateRow {
  dirty: number;
  generated_at: number;
  last_broadcast_at: number;
  payload: string | null;
  sequence: number;
}

interface ReplayRow {
  payload: string;
}

interface SequenceRow {
  sequence: number | null;
}

interface CountRow {
  count: number;
}

interface SamplingRow {
  admitted: number;
  sampled_out: number;
}

interface DeadlineRow {
  deadline: number | null;
}

interface ColumnRow {
  name: string;
}

export interface ObservabilityProjectionCounts {
  current: number;
  dropBuckets: number;
  replay: number;
  samplingBuckets: number;
}

export interface PublicSamplingWindow {
  admittedTraceCount: number;
  sampleRate: number;
  sampledOutTraceCount: number;
}

/** Creates the bounded current-projection and replay tables without storing another raw trace copy. */
export function initializePublicObservabilitySchema(sql: TraceSql): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS observability_projection_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      sequence INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      last_broadcast_at INTEGER NOT NULL,
      dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
      payload TEXT
    );
    CREATE TABLE IF NOT EXISTS observability_projection_replay (
      sequence INTEGER PRIMARY KEY,
      generated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS observability_projection_replay_time_idx
      ON observability_projection_replay (generated_at, sequence);
    CREATE TABLE IF NOT EXISTS observability_drop_buckets (
      bucket_at INTEGER PRIMARY KEY,
      latest_event_at INTEGER NOT NULL,
      dropped_trace_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observability_sampling_buckets (
      bucket_at INTEGER PRIMARY KEY,
      latest_event_at INTEGER NOT NULL,
      admitted_trace_count INTEGER NOT NULL,
      sampled_out_trace_count INTEGER NOT NULL
    );
  `);
  const dropColumns = sql.exec<ColumnRow>(
    "PRAGMA table_info(observability_drop_buckets)",
  ).toArray();
  if (!dropColumns.some((column) => column.name === "latest_event_at")) {
    sql.exec(
      "ALTER TABLE observability_drop_buckets ADD COLUMN latest_event_at INTEGER NOT NULL DEFAULT 0",
    );
    sql.exec(
      "UPDATE observability_drop_buckets SET latest_event_at = bucket_at WHERE latest_event_at = 0",
    );
  }
}

export class SqlPublicObservabilityStore {
  constructor(
    private readonly sql: TraceSql,
    private readonly stream: PublicTraceStreamDefinition,
  ) {}

  markDirty(): void {
    this.sql.exec(`
      INSERT INTO observability_projection_state
        (singleton, sequence, generated_at, last_broadcast_at, dirty, payload)
      VALUES (1, 0, 0, 0, 1, NULL)
      ON CONFLICT(singleton) DO UPDATE SET dirty = 1
    `);
  }

  nextPublishAt(now: number): number | null {
    const state = this.state();
    if (!state || state.dirty !== 1) return null;
    return state.last_broadcast_at === 0
      ? now
      : Math.max(now, state.last_broadcast_at + this.stream.broadcastIntervalMs);
  }

  nextSequence(): number {
    return (this.state()?.sequence ?? 0) + 1;
  }

  publish(projection: PublicObservabilityProjection): void {
    const payload = JSON.stringify(projection);
    this.sql.exec(`
      INSERT INTO observability_projection_state
        (singleton, sequence, generated_at, last_broadcast_at, dirty, payload)
      VALUES (1, ?, ?, ?, 0, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        sequence = excluded.sequence,
        generated_at = excluded.generated_at,
        last_broadcast_at = excluded.last_broadcast_at,
        dirty = 0,
        payload = excluded.payload
    `, projection.sequence, projection.generatedAt, projection.generatedAt, payload);
    this.sql.exec(`
      INSERT INTO observability_projection_replay (sequence, generated_at, payload)
      VALUES (?, ?, ?)
    `, projection.sequence, projection.generatedAt, payload);
    this.enforceRetention(projection.generatedAt);
  }

  readCurrent(): PublicObservabilityProjection | null {
    return parseProjection(this.state()?.payload ?? null);
  }

  replayAfter(sequence: number): PublicObservabilityProjection[] | null {
    const rows = this.sql.exec<ReplayRow>(`
      SELECT payload FROM observability_projection_replay
      WHERE sequence > ? ORDER BY sequence LIMIT ?
    `, sequence, this.stream.replayLimit).toArray();
    const projections = rows.map((row) => parseProjection(row.payload));
    return projections.some((projection) => projection === null)
      ? null
      : projections.flatMap((projection) => projection ? [projection] : []);
  }

  oldestReplaySequence(): number | null {
    const sequence = this.sql.exec<SequenceRow>(
      "SELECT MIN(sequence) AS sequence FROM observability_projection_replay",
    ).toArray()[0]?.sequence;
    return sequence === null || sequence === undefined ? null : Number(sequence);
  }

  enforceRetention(now: number): {
    dropBucketsDeleted: number;
    replayDeleted: number;
    samplingBucketsDeleted: number;
  } {
    const replayOutside = this.sql.exec(
      "DELETE FROM observability_projection_replay WHERE generated_at < ? OR generated_at > ?",
      now - this.stream.presentationDurationMs,
      now,
    ).rowsWritten;
    const replayBeyond = this.sql.exec(`
      DELETE FROM observability_projection_replay
      WHERE sequence NOT IN (
        SELECT sequence FROM observability_projection_replay
        ORDER BY sequence DESC LIMIT ?
      )
    `, this.stream.replayLimit).rowsWritten;
    return {
      dropBucketsDeleted: this.enforceDropRetention(now),
      replayDeleted: replayOutside + replayBeyond,
      samplingBucketsDeleted: this.enforceSamplingRetention(now),
    };
  }

  recordSamplingDecision(now: number, admitted: boolean): void {
    const bucketAt = Math.floor(now / this.stream.broadcastIntervalMs)
      * this.stream.broadcastIntervalMs;
    this.sql.exec(`
      INSERT INTO observability_sampling_buckets
        (bucket_at, latest_event_at, admitted_trace_count, sampled_out_trace_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(bucket_at) DO UPDATE SET
        latest_event_at = MAX(latest_event_at, excluded.latest_event_at),
        admitted_trace_count = admitted_trace_count + excluded.admitted_trace_count,
        sampled_out_trace_count = sampled_out_trace_count + excluded.sampled_out_trace_count
    `, bucketAt, now, admitted ? 1 : 0, admitted ? 0 : 1);
    this.enforceRetention(now);
  }

  samplingWindow(now: number): PublicSamplingWindow {
    this.enforceRetention(now);
    const row = this.sql.exec<SamplingRow>(`
      SELECT
        COALESCE(SUM(admitted_trace_count), 0) AS admitted,
        COALESCE(SUM(sampled_out_trace_count), 0) AS sampled_out
      FROM observability_sampling_buckets
    `).toArray()[0];
    const admittedTraceCount = Number(row?.admitted ?? 0);
    const sampledOutTraceCount = Number(row?.sampled_out ?? 0);
    const decisions = admittedTraceCount + sampledOutTraceCount;
    return {
      admittedTraceCount,
      sampleRate: decisions === 0 ? 1 : admittedTraceCount / decisions,
      sampledOutTraceCount,
    };
  }

  recordDroppedTraces(now: number, count = 1): void {
    if (!Number.isSafeInteger(count) || count <= 0) return;
    const bucketAt = Math.floor(now / this.stream.broadcastIntervalMs)
      * this.stream.broadcastIntervalMs;
    this.sql.exec(`
      INSERT INTO observability_drop_buckets (bucket_at, latest_event_at, dropped_trace_count)
      VALUES (?, ?, ?)
      ON CONFLICT(bucket_at) DO UPDATE SET
        latest_event_at = MAX(latest_event_at, excluded.latest_event_at),
        dropped_trace_count = dropped_trace_count + excluded.dropped_trace_count
    `, bucketAt, now, count);
    this.enforceRetention(now);
  }

  droppedTraceCount(now: number): number {
    this.enforceRetention(now);
    return Number(this.sql.exec<CountRow>(`
      SELECT COALESCE(SUM(dropped_trace_count), 0) AS count
      FROM observability_drop_buckets
    `).toArray()[0]?.count ?? 0);
  }

  nextExpiryAt(): number | null {
    const replayAt = this.sql.exec<DeadlineRow>(
      "SELECT MIN(generated_at) AS deadline FROM observability_projection_replay",
    ).toArray()[0]?.deadline;
    const dropAt = this.oldestDropEventAt();
    const samplingAt = this.oldestSamplingEventAt();
    const oldest = [replayAt, dropAt, samplingAt]
      .filter((value): value is number => value !== null && value !== undefined);
    return oldest.length === 0
      ? null
      : Math.min(...oldest) + this.stream.presentationDurationMs + 1;
  }

  nextDropExpiryAt(): number | null {
    const oldest = this.oldestDropEventAt();
    return oldest === null ? null : oldest + this.stream.presentationDurationMs + 1;
  }

  nextSamplingExpiryAt(): number | null {
    const oldest = this.oldestSamplingEventAt();
    return oldest === null ? null : oldest + this.stream.presentationDurationMs + 1;
  }

  counts(): ObservabilityProjectionCounts {
    const current = this.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM observability_projection_state",
    ).toArray()[0]?.count ?? 0;
    const replay = this.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM observability_projection_replay",
    ).toArray()[0]?.count ?? 0;
    const dropBuckets = this.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM observability_drop_buckets",
    ).toArray()[0]?.count ?? 0;
    const samplingBuckets = this.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM observability_sampling_buckets",
    ).toArray()[0]?.count ?? 0;
    return {
      current: Number(current),
      dropBuckets: Number(dropBuckets),
      replay: Number(replay),
      samplingBuckets: Number(samplingBuckets),
    };
  }

  private state(): ProjectionStateRow | undefined {
    return this.sql.exec<ProjectionStateRow>(`
      SELECT sequence, generated_at, last_broadcast_at, dirty, payload
      FROM observability_projection_state WHERE singleton = 1
    `).toArray()[0];
  }

  private enforceDropRetention(now: number): number {
    const outside = this.sql.exec(
      "DELETE FROM observability_drop_buckets WHERE latest_event_at < ? OR latest_event_at > ?",
      now - this.stream.presentationDurationMs,
      now,
    ).rowsWritten;
    const beyond = this.sql.exec(`
      DELETE FROM observability_drop_buckets
      WHERE bucket_at NOT IN (
        SELECT bucket_at FROM observability_drop_buckets
        ORDER BY bucket_at DESC LIMIT ?
      )
    `, this.stream.replayLimit).rowsWritten;
    return outside + beyond;
  }

  private oldestDropEventAt(): number | null {
    const value = this.sql.exec<DeadlineRow>(
      "SELECT MIN(latest_event_at) AS deadline FROM observability_drop_buckets",
    ).toArray()[0]?.deadline;
    return value === null || value === undefined ? null : Number(value);
  }

  private enforceSamplingRetention(now: number): number {
    const outside = this.sql.exec(
      "DELETE FROM observability_sampling_buckets WHERE latest_event_at < ? OR latest_event_at > ?",
      now - this.stream.presentationDurationMs,
      now,
    ).rowsWritten;
    const beyond = this.sql.exec(`
      DELETE FROM observability_sampling_buckets
      WHERE bucket_at NOT IN (
        SELECT bucket_at FROM observability_sampling_buckets
        ORDER BY bucket_at DESC LIMIT ?
      )
    `, this.stream.replayLimit).rowsWritten;
    return outside + beyond;
  }

  private oldestSamplingEventAt(): number | null {
    const value = this.sql.exec<DeadlineRow>(
      "SELECT MIN(latest_event_at) AS deadline FROM observability_sampling_buckets",
    ).toArray()[0]?.deadline;
    return value === null || value === undefined ? null : Number(value);
  }
}

function parseProjection(payload: string | null): PublicObservabilityProjection | null {
  if (payload === null) return null;
  try {
    const parsed = publicObservabilityProjectionSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
