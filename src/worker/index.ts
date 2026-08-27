import {
  STATIC_FALLBACK_PROJECTION,
  STREAM_NAME,
  TAIL_LATENCY_STREAM,
  decideProjectionAction,
  hasUnpublishedSample,
  projectTailLatency,
  publicTimingSampleSchema,
  selectRecoveryMode,
  retainBroadcastCursor,
  shouldPersistProjectionRefresh,
  tailLatencyProjectionSchema,
  type KeyedTimingSample,
  type PublicTimingSample,
  type StreamEnvelope,
  type TailLatencyProjection,
} from "../domain/tail-latency";
import { nextPresentationExpiry } from "../domain/public-stream";
import {
  OBSERVABILITY_STREAM_NAME,
  projectPublicObservability,
  publicObservabilityEnvelopeSchema,
  type PublicObservabilityProjection,
} from "../domain/public-observability";
import {
  SqlPublicObservabilityStore,
  initializePublicObservabilitySchema,
} from "../domain/public-observability-sql";
import {
  enforcePublicStreamRetention,
  type PublicStreamRetentionStore,
  type RetentionResult,
} from "../domain/public-stream-storage";
import { DurableObject, tracing } from "cloudflare:workers";
import { publicSpanBatchSchema, type PublicSpan } from "../domain/public-span";
import { parsePublicOtlpJson } from "../domain/public-otlp";
import {
  finishDurableObjectSpan,
  finishWorkerSpan,
  startPublicSpan,
  type PublicServerOperation,
} from "../domain/public-runtime-span";
import {
  SqlPublicTraceStore,
  initializePublicTraceSchema,
  type TraceSql,
  type TraceSqlCursor,
  type TraceSqlValue,
} from "../domain/public-trace-sql";
import {
  PUBLIC_TRACE_STREAM,
  enforceWholeTraceRetention,
  finalizeDueTraces,
  ingestPublicSpanBatch,
  nextTraceStoreAlarm,
  type PublicSpanBatchResult,
} from "../domain/public-trace-store";
import {
  PUBLIC_TRACE_ADMISSION_BATCH_LIMIT,
  PUBLIC_TRACE_ADMISSION_HEADER,
  PUBLIC_TRACE_ADMISSION_RATE_LIMIT,
  PUBLIC_TRACE_ADMISSION_RATE_WINDOW_MS,
  PUBLIC_TRACE_ADMISSION_TTL_MS,
  admissionMatchesBatch,
  publicTraceAdmissionSchema,
} from "../domain/public-trace-admission";

interface Env {
  ASSETS: Fetcher;
  DEVLOOP_BROWSER_EVENTS_URL?: string;
  TAIL_LATENCY: DurableObjectNamespace<TailLatencyRoom>;
}

const OBSERVABILITY_ARTICLE_PATH = "/posts/observability/";

interface StoredSampleRow {
  [key: string]: SqlStorageValue;
  duration_ms: number;
  id: number;
  observed_at: number;
  route_class: PublicTimingSample["routeClass"];
  status_class: PublicTimingSample["statusClass"];
}

interface CurrentProjectionRow {
  [key: string]: SqlStorageValue;
  last_broadcast_at: number;
  last_sample_id: number;
  payload: string;
  sequence: number;
}

interface LatestSampleRow {
  [key: string]: SqlStorageValue;
  latest_sample_id: number | null;
}

interface ReplayRow {
  [key: string]: SqlStorageValue;
  payload: string;
}

interface ReplayBoundsRow {
  [key: string]: SqlStorageValue;
  oldest_sequence: number | null;
}

interface AlarmSampleRow {
  [key: string]: SqlStorageValue;
  id: number;
  observed_at: number;
}

interface TraceAdmissionRow {
  [key: string]: SqlStorageValue;
  expires_at: number;
  remaining_batches: number;
  trace_id: string;
}

interface CountValueRow {
  [key: string]: SqlStorageValue;
  count: number;
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const room = env.TAIL_LATENCY.getByName("public");

    if (request.method === "GET" && url.pathname === "/__ready") {
      return new Response("ok", {
        headers: { "cache-control": "no-store" },
        status: 200,
      });
    }

    if (request.method === "GET" && url.pathname === "/__devloop/reload" && isLoopbackHttpUrl(env.DEVLOOP_BROWSER_EVENTS_URL)) {
      return fetch(env.DEVLOOP_BROWSER_EVENTS_URL, {
        headers: { accept: "text/event-stream" },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/observability/v1/traces") {
      return context.tracing.enterSpan("worker.span-intake", async (span) => {
        span.setAttribute("app.telemetry.route_class", "intake");
        return ingestPublicOtlpRequest(request, room);
      });
    }

    if (isLoopbackHttpUrl(env.DEVLOOP_BROWSER_EVENTS_URL) &&
        (url.pathname === "/__devloop/public-spans" || url.pathname === "/__devloop/public-trace-state")) {
      const internalPath = url.pathname === "/__devloop/public-spans" ? "/public-spans" : "/public-trace-state";
      return context.tracing.enterSpan("worker.span-intake", (span) => {
        span.setAttribute("app.telemetry.route_class", "intake");
        return room.fetch(new Request(`https://observability.internal${internalPath}`, request));
      });
    }

    const publicServerOperation = serverOperation(url.pathname);
    if (publicServerOperation) {
      return tracePublicApiRequest(publicServerOperation, request, room, context);
    }

    if (request.method === "GET" && url.pathname.startsWith("/posts/")) {
      return traceArticleRequest(request, url, env, room, context);
    }

    const startedAt = performance.now();
    const response = await env.ASSETS.fetch(request);

    if (request.method === "GET") {
      const sample = {
        durationMs: Math.min(60_000, Math.max(0, performance.now() - startedAt)),
        observedAt: Date.now(),
        routeClass: classifyRoute(url.pathname),
        statusClass: classifyStatus(response.status),
      } satisfies PublicTimingSample;

      context.waitUntil(room.fetch(new Request("https://tail-latency.internal/record", {
        body: JSON.stringify(sample),
        headers: { "content-type": "application/json" },
        method: "POST",
      })));
    }

    return withSecurityHeaders(response, url);
  },
} satisfies ExportedHandler<Env>;

/** Owns the bounded reducer state, replay sequence, and hibernating public fan-out. */
export class TailLatencyRoom extends DurableObject<Env> {
  constructor(context: DurableObjectState, env: Env) {
    super(context, env);
    context.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          duration_ms REAL NOT NULL,
          observed_at INTEGER NOT NULL,
          route_class TEXT NOT NULL,
          status_class TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS current_projection (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          sequence INTEGER NOT NULL,
          generated_at INTEGER NOT NULL,
          last_broadcast_at INTEGER NOT NULL,
          last_sample_id INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS replay (
          sequence INTEGER PRIMARY KEY,
          generated_at INTEGER NOT NULL,
          oldest_observed_at INTEGER,
          payload TEXT NOT NULL
        );
      `);
      const currentProjectionColumns = this.ctx.storage.sql.exec<{ name: string }>(
        "PRAGMA table_info(current_projection)",
      ).toArray();
      if (!currentProjectionColumns.some((column) => column.name === "last_sample_id")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE current_projection ADD COLUMN last_sample_id INTEGER NOT NULL DEFAULT 0",
        );
      }
      const replayColumns = this.ctx.storage.sql.exec<{ name: string }>(
        "PRAGMA table_info(replay)",
      ).toArray();
      if (!replayColumns.some((column) => column.name === "oldest_observed_at")) {
        this.ctx.storage.sql.exec("ALTER TABLE replay ADD COLUMN oldest_observed_at INTEGER");
      }
      initializePublicTraceSchema(cloudflareTraceSql(this.ctx.storage.sql));
      initializePublicObservabilitySchema(cloudflareTraceSql(this.ctx.storage.sql));
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_trace_admissions (
          token TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL UNIQUE,
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          remaining_batches INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS browser_trace_admissions_expiry_idx
          ON browser_trace_admissions (expires_at, issued_at);
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/record") return this.record(request);
    if (request.method === "POST" && url.pathname === "/public-spans") return this.ingestSpans(request);
    if (request.method === "POST" && url.pathname === "/public-browser-spans") {
      return this.ingestBrowserSpans(request);
    }
    if (request.method === "POST" && url.pathname === "/public-trace-admissions") {
      return this.issueTraceAdmission(request);
    }
    if (request.method === "GET" && url.pathname === "/public-trace-state") {
      const store = this.publicTraceStore();
      return Response.json({
        counts: store.counts(),
        nextFinalizeAt: store.nextFinalizeAt(),
        oldestFirstSeenAt: store.oldestFirstSeenAt(),
      }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/api/tail-latency/snapshot") {
      return this.traceSnapshot(request);
    }
    if (request.method === "GET" && url.pathname === "/api/observability/snapshot") {
      return this.traceSnapshot(request);
    }
    if (request.method === "GET" && url.pathname === "/api/stream") {
      return this.traceStreamConnect(request);
    }
    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(socket: WebSocket, _message: ArrayBuffer | string): void {
    socket.close(1008, "This public stream is read-only");
  }

  webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    socket.close(code, wasClean ? reason : "Connection closed");
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const observability = this.publicObservabilityStore();
    if (this.maintainPublicTraces(now)) observability.markDirty();
    if (observability.enforceRetention(now).dropBucketsDeleted > 0) observability.markDirty();
    this.publishObservabilityIfDue(now);
    const retention = this.enforceRetention(now);
    const current = this.currentRow();
    const cursor = retainBroadcastCursor(fromCurrentRow(current));
    if (!hasUnpublishedSample(cursor, this.latestSampleId()) && !retention.timeExpired) {
      await this.scheduleNextAlarm(now);
      return;
    }

    const action = decideProjectionAction(current?.last_broadcast_at ?? null, now, null);
    if (action.kind === "publish") {
      this.publishProjection(now);
      await this.scheduleNextAlarm(now);
    } else if (action.kind === "schedule") {
      if (retention.pointsDeleted > 0) this.persistCurrentProjection(now);
      await this.scheduleNextAlarm(now, action.at);
    }
  }

  private async ingestSpans(request: Request): Promise<Response> {
    const parsed = publicSpanBatchSchema.safeParse(await parseRequestJson(request));
    if (!parsed.success) return new Response("Invalid public span batch", { status: 400 });

    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => ingestPublicSpanBatch(
      PUBLIC_TRACE_STREAM,
      this.publicTraceStore(),
      parsed.data,
      now,
    ));
    this.recordObservabilityIngestResult(result, now);
    await this.scheduleNextAlarm(now);
    return Response.json(result, {
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      status: 202,
    });
  }

  private async ingestBrowserSpans(request: Request): Promise<Response> {
    const token = request.headers.get(PUBLIC_TRACE_ADMISSION_HEADER);
    const parsed = publicSpanBatchSchema.safeParse(await parseRequestJson(request));
    if (!token || !parsed.success) return new Response("Invalid browser span batch", { status: 400 });

    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      this.deleteExpiredAdmissions(now);
      const admission = this.ctx.storage.sql.exec<TraceAdmissionRow>(`
        SELECT trace_id, expires_at, remaining_batches
        FROM browser_trace_admissions WHERE token = ?
      `, token).toArray()[0];
      if (!admission || admission.expires_at < now || admission.remaining_batches <= 0 ||
          !admissionMatchesBatch(admission.trace_id, parsed.data)) return null;
      this.ctx.storage.sql.exec(`
        UPDATE browser_trace_admissions
        SET remaining_batches = remaining_batches - 1
        WHERE token = ?
      `, token);
      return ingestPublicSpanBatch(PUBLIC_TRACE_STREAM, this.publicTraceStore(), parsed.data, now);
    });
    if (result === null) return new Response("Trace admission rejected", { status: 403 });
    this.recordObservabilityIngestResult(result, now);
    await this.scheduleNextAlarm(now);
    return Response.json(result, {
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      status: 202,
    });
  }

  private async issueTraceAdmission(request: Request): Promise<Response> {
    const parsed = publicTraceAdmissionSchema.safeParse(await parseRequestJson(request));
    if (!parsed.success) return new Response("Invalid trace admission", { status: 400 });

    const now = Date.now();
    const issued = this.ctx.storage.transactionSync(() => {
      this.deleteExpiredAdmissions(now);
      const recentlyIssued = Number(this.ctx.storage.sql.exec<CountValueRow>(`
        SELECT COUNT(*) AS count FROM browser_trace_admissions WHERE issued_at >= ?
      `, now - PUBLIC_TRACE_ADMISSION_RATE_WINDOW_MS).toArray()[0]?.count ?? 0);
      const active = Number(this.ctx.storage.sql.exec<CountValueRow>(`
        SELECT COUNT(*) AS count FROM browser_trace_admissions
      `).toArray()[0]?.count ?? 0);
      if (recentlyIssued >= PUBLIC_TRACE_ADMISSION_RATE_LIMIT || active >= PUBLIC_TRACE_STREAM.maxTraces) {
        return false;
      }
      this.ctx.storage.sql.exec(`
        INSERT INTO browser_trace_admissions
          (token, trace_id, issued_at, expires_at, remaining_batches)
        VALUES (?, ?, ?, ?, ?)
      `, parsed.data.token, parsed.data.traceId, now, now + PUBLIC_TRACE_ADMISSION_TTL_MS,
      PUBLIC_TRACE_ADMISSION_BATCH_LIMIT);
      return true;
    });
    if (!issued) {
      const observability = this.publicObservabilityStore();
      observability.recordDroppedTraces(now);
      observability.markDirty();
      await this.scheduleNextAlarm(now);
    }
    return new Response(null, {
      headers: { "cache-control": "no-store" },
      status: issued ? 201 : 429,
    });
  }

  private deleteExpiredAdmissions(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM browser_trace_admissions WHERE expires_at < ?", now);
  }

  private async traceSnapshot(request: Request): Promise<Response> {
    return tracing.enterSpan("durable-object.snapshot", async (nativeSpan) => {
      nativeSpan.setAttribute("app.telemetry.operation_class", "snapshot");
      const started = startPublicSpan(request.headers.get("traceparent"), Date.now());
      const response = new URL(request.url).pathname === "/api/observability/snapshot"
        ? await this.observabilitySnapshot()
        : await this.snapshot();
      await this.recordRuntimeSpan(finishDurableObjectSpan(
        "snapshot",
        started,
        response.status,
        Date.now(),
      ));
      return response;
    });
  }

  private async traceStreamConnect(request: Request): Promise<Response> {
    return tracing.enterSpan("durable-object.stream-connect", async (nativeSpan) => {
      nativeSpan.setAttribute("app.telemetry.operation_class", "stream-connect");
      const started = startPublicSpan(request.headers.get("traceparent"), Date.now());
      const response = await this.connectWebSocket(request);
      await this.recordRuntimeSpan(finishDurableObjectSpan(
        "stream-connect",
        started,
        response.status,
        Date.now(),
      ));
      return response;
    });
  }

  private async recordRuntimeSpan(span: PublicSpan): Promise<void> {
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => ingestPublicSpanBatch(
      PUBLIC_TRACE_STREAM,
      this.publicTraceStore(),
      [span],
      now,
    ));
    this.recordObservabilityIngestResult(result, now);
    await this.scheduleNextAlarm(now);
  }

  private async record(request: Request): Promise<Response> {
    const parsed = publicTimingSampleSchema.safeParse(await parseRequestJson(request));
    if (!parsed.success) return new Response("Invalid public timing sample", { status: 400 });

    const now = Date.now();
    const sample = parsed.data;
    const retention = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO samples (duration_ms, observed_at, route_class, status_class) VALUES (?, ?, ?, ?)",
        sample.durationMs, sample.observedAt, sample.routeClass, sample.statusClass,
      );
      return enforcePublicStreamRetention(
        TAIL_LATENCY_STREAM,
        retentionStore(this.ctx.storage.sql),
        now,
      );
    });

    const current = this.currentRow();
    const scheduledAlarmAt = await this.ctx.storage.getAlarm();
    const action = decideProjectionAction(
      current?.last_broadcast_at ?? null,
      now,
      scheduledAlarmAt,
    );
    if (action.kind === "publish") {
      if (scheduledAlarmAt !== null) await this.ctx.storage.deleteAlarm();
      this.publishProjection(now);
      await this.scheduleNextAlarm(now);
    } else if (action.kind === "schedule") {
      if (retention.pointsDeleted > 0) this.persistCurrentProjection(now);
      await this.scheduleNextAlarm(now, action.at);
    } else {
      if (retention.pointsDeleted > 0) this.persistCurrentProjection(now);
      await this.scheduleNextAlarm(now, scheduledAlarmAt);
    }

    return new Response(null, { status: 202 });
  }

  private publishProjection(now: number): void {
    const current = this.currentRow();
    const projection = this.createProjection((current?.sequence ?? 0) + 1, now);
    const payload = JSON.stringify(projection);
    const lastSampleId = this.latestSampleId();

    this.ctx.storage.transactionSync(() => {
      enforcePublicStreamRetention(TAIL_LATENCY_STREAM, retentionStore(this.ctx.storage.sql), now);
      this.writeCurrentProjection(projection, now, lastSampleId);
      this.ctx.storage.sql.exec(
        "INSERT INTO replay (sequence, generated_at, oldest_observed_at, payload) VALUES (?, ?, ?, ?)",
        projection.sequence,
        projection.generatedAt,
        projection.points[0]?.observedAt ?? null,
        payload,
      );
      enforcePublicStreamRetention(TAIL_LATENCY_STREAM, retentionStore(this.ctx.storage.sql), now);
    });

    this.broadcast(projection);
  }

  private persistCurrentProjection(now: number): void {
    const current = this.currentRow();
    const cursor = retainBroadcastCursor(fromCurrentRow(current));
    const projection = this.createProjection(cursor.sequence, now);
    this.writeCurrentProjection(
      projection,
      cursor.lastBroadcastAt,
      cursor.lastSampleId,
    );
  }

  private createProjection(sequence: number, now: number): TailLatencyProjection {
    const storedSamples = this.ctx.storage.sql.exec<StoredSampleRow>(
      "SELECT id, duration_ms, observed_at, route_class, status_class FROM samples ORDER BY observed_at, id",
    ).toArray();
    const samples = storedSamples.map(fromStoredSample);
    return projectTailLatency(samples, sequence, now);
  }

  private writeCurrentProjection(
    projection: TailLatencyProjection,
    lastBroadcastAt: number,
    lastSampleId: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO current_projection (singleton, sequence, generated_at, last_broadcast_at, last_sample_id, payload)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         sequence = excluded.sequence,
         generated_at = excluded.generated_at,
         last_broadcast_at = excluded.last_broadcast_at,
         last_sample_id = excluded.last_sample_id,
         payload = excluded.payload`,
      projection.sequence,
      projection.generatedAt,
      lastBroadcastAt,
      lastSampleId,
      JSON.stringify(projection),
    );
  }

  private async snapshot(): Promise<Response> {
    await this.refreshForRead(Date.now());
    return Response.json(this.readCurrentProjection(), {
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  private async observabilitySnapshot(): Promise<Response> {
    const now = Date.now();
    await this.refreshObservabilityForRead(now);
    const projection = this.publicObservabilityStore().readCurrent()
      ?? projectPublicObservability([], 0, now);
    return Response.json(projection, {
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  private async connectWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const streams = url.searchParams.get("streams")?.split(",") ?? [];
    const stream = streams[0];
    if (streams.length !== 1 || (stream !== STREAM_NAME && stream !== OBSERVABILITY_STREAM_NAME)) {
      return new Response("Unknown or disallowed public stream", { status: 400 });
    }
    if (stream === OBSERVABILITY_STREAM_NAME) await this.refreshObservabilityForRead(Date.now());
    else await this.refreshForRead(Date.now());

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [stream]);
    server.serializeAttachment({ streams: [stream] });

    const since = parseSequence(url.searchParams.get("since"));
    if (stream === OBSERVABILITY_STREAM_NAME) {
      this.recoverObservabilitySocket(server, since);
      return new Response(null, { status: 101, webSocket: client });
    }
    const bounds = this.ctx.storage.sql.exec<ReplayBoundsRow>(
      "SELECT MIN(sequence) AS oldest_sequence FROM replay",
    ).toArray()[0];
    const mode = selectRecoveryMode(since, bounds?.oldest_sequence ?? null);
    const replay = mode === "replay"
      ? this.ctx.storage.sql.exec<ReplayRow>(
          "SELECT payload FROM replay WHERE sequence > ? ORDER BY sequence LIMIT ?",
          since,
          TAIL_LATENCY_STREAM.replayLimit,
        ).toArray()
      : [];
    const recovered = replay.map((row) => tailLatencyProjectionSchema.safeParse(parseStoredJson(row.payload)));
    if (recovered.length === 0 || recovered.some((projection) => !projection.success)) {
      server.send(JSON.stringify(envelope(this.readCurrentProjection())));
    } else {
      for (const projection of recovered) {
        if (projection.success) server.send(JSON.stringify(envelope(projection.data)));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private recoverObservabilitySocket(server: WebSocket, since: number): void {
    const store = this.publicObservabilityStore();
    const mode = selectRecoveryMode(since, store.oldestReplaySequence());
    const replay = mode === "replay" ? store.replayAfter(since) : [];
    if (!replay || replay.length === 0) {
      const current = store.readCurrent();
      if (current) server.send(JSON.stringify(observabilityEnvelope(current)));
      return;
    }
    for (const projection of replay) {
      server.send(JSON.stringify(observabilityEnvelope(projection)));
    }
  }

  private async refreshObservabilityForRead(now: number): Promise<void> {
    const store = this.publicObservabilityStore();
    if (this.maintainPublicTraces(now)) store.markDirty();
    if (store.enforceRetention(now).dropBucketsDeleted > 0) store.markDirty();
    const currentMissing = store.readCurrent() === null;
    if (currentMissing) store.markDirty();
    const publishAt = store.nextPublishAt(now);
    if (currentMissing || (publishAt !== null && publishAt <= now)) {
      this.publishObservability(now);
    }
    await this.scheduleNextAlarm(now);
  }

  private async refreshForRead(now: number): Promise<void> {
    const retention = this.enforceRetention(now);
    const current = this.currentRow();
    const parsed = current ? tailLatencyProjectionSchema.safeParse(parseStoredJson(current.payload)) : null;
    if (shouldPersistProjectionRefresh(
      current !== undefined,
      retention.pointsDeleted,
      parsed?.success ?? false,
    )) this.persistCurrentProjection(now);
    await this.scheduleNextAlarm(now);
  }

  private enforceRetention(now: number): RetentionResult {
    return this.ctx.storage.transactionSync(() => enforcePublicStreamRetention(
      TAIL_LATENCY_STREAM,
      retentionStore(this.ctx.storage.sql),
      now,
    ));
  }

  private async scheduleNextAlarm(now: number, cadenceAt: number | null = null): Promise<void> {
    const samples = this.ctx.storage.sql.exec<AlarmSampleRow>(
      "SELECT id, observed_at FROM samples ORDER BY observed_at, id",
    ).toArray();
    const expiryAt = nextPresentationExpiry(
      TAIL_LATENCY_STREAM,
      samples.map((sample) => ({ observedAt: sample.observed_at })),
      now,
    );
    const traceStore = this.publicTraceStore();
    const traceAlarmAt = nextTraceStoreAlarm(
      PUBLIC_TRACE_STREAM,
      traceStore.nextFinalizeAt(),
      traceStore.oldestFirstSeenAt(),
    );
    const observabilityPublishAt = this.publicObservabilityStore().nextPublishAt(now);
    const observabilityExpiryAt = this.publicObservabilityStore().nextExpiryAt();
    const candidates = [
      cadenceAt,
      expiryAt,
      traceAlarmAt,
      observabilityPublishAt,
      observabilityExpiryAt,
    ]
      .filter((candidate): candidate is number => candidate !== null);
    const scheduledAlarmAt = await this.ctx.storage.getAlarm();
    if (candidates.length === 0) {
      if (scheduledAlarmAt !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const desiredAlarmAt = Math.min(...candidates);
    if (scheduledAlarmAt === null || Math.abs(scheduledAlarmAt - desiredAlarmAt) >= 1) {
      await this.ctx.storage.setAlarm(desiredAlarmAt);
    }
  }

  private maintainPublicTraces(now: number): boolean {
    const result = this.ctx.storage.transactionSync(() => {
      const store = this.publicTraceStore();
      const finalized = finalizeDueTraces(store, now);
      const retention = enforceWholeTraceRetention(PUBLIC_TRACE_STREAM, store, now);
      return { finalized, retention };
    });
    if (result.finalized.invalidTracesDeleted > 0) {
      this.publicObservabilityStore().recordDroppedTraces(
        now,
        result.finalized.invalidTracesDeleted,
      );
    }
    return result.finalized.finalized > 0
      || result.finalized.invalidTracesDeleted > 0
      || result.retention.tracesDeleted > 0;
  }

  private publicTraceStore(): SqlPublicTraceStore {
    return new SqlPublicTraceStore(cloudflareTraceSql(this.ctx.storage.sql));
  }

  private publicObservabilityStore(): SqlPublicObservabilityStore {
    return new SqlPublicObservabilityStore(
      cloudflareTraceSql(this.ctx.storage.sql),
      PUBLIC_TRACE_STREAM,
    );
  }

  private publishObservabilityIfDue(now: number): void {
    const publishAt = this.publicObservabilityStore().nextPublishAt(now);
    if (publishAt !== null && publishAt <= now) this.publishObservability(now);
  }

  private publishObservability(now: number): void {
    const store = this.publicObservabilityStore();
    const projection = projectPublicObservability(
      this.publicTraceStore().readFinalizedTraces(),
      store.nextSequence(),
      now,
      {
        droppedTraceCount: store.droppedTraceCount(now),
        droppedTraceExpiresAtUnixMs: store.nextDropExpiryAt(),
        sampleRate: 1,
      },
    );
    this.ctx.storage.transactionSync(() => store.publish(projection));
    const message = JSON.stringify(observabilityEnvelope(projection));
    for (const socket of this.ctx.getWebSockets(OBSERVABILITY_STREAM_NAME)) {
      try { socket.send(message); } catch { socket.close(1011, "Projection delivery failed"); }
    }
  }

  private recordObservabilityIngestResult(result: PublicSpanBatchResult, now: number): void {
    const dropped = result.invalidTracesDeleted + result.oversizedTracesDeleted;
    if (result.finalized > 0 || dropped > 0 || result.retention.tracesDeleted > 0) {
      const store = this.publicObservabilityStore();
      if (dropped > 0) store.recordDroppedTraces(now, dropped);
      store.markDirty();
    }
  }

  private broadcast(projection: TailLatencyProjection): void {
    const message = JSON.stringify(envelope(projection));
    for (const socket of this.ctx.getWebSockets(STREAM_NAME)) {
      try { socket.send(message); } catch { socket.close(1011, "Projection delivery failed"); }
    }
  }

  private currentRow(): CurrentProjectionRow | undefined {
    return this.ctx.storage.sql.exec<CurrentProjectionRow>(
      "SELECT sequence, last_broadcast_at, last_sample_id, payload FROM current_projection WHERE singleton = 1",
    ).toArray()[0];
  }

  private latestSampleId(): number {
    return this.ctx.storage.sql.exec<LatestSampleRow>(
      "SELECT MAX(id) AS latest_sample_id FROM samples",
    ).toArray()[0]?.latest_sample_id ?? 0;
  }

  private readCurrentProjection(): TailLatencyProjection {
    const row = this.currentRow();
    if (!row) return STATIC_FALLBACK_PROJECTION;
    const parsed = tailLatencyProjectionSchema.safeParse(parseStoredJson(row.payload));
    return parsed.success ? parsed.data : STATIC_FALLBACK_PROJECTION;
  }
}

function envelope(projection: TailLatencyProjection): StreamEnvelope {
  return { projection, stream: STREAM_NAME, type: "projection" };
}

function observabilityEnvelope(
  projection: PublicObservabilityProjection,
) {
  return publicObservabilityEnvelopeSchema.parse({
    projection,
    stream: OBSERVABILITY_STREAM_NAME,
    type: "projection",
  });
}

function fromCurrentRow(row: CurrentProjectionRow | undefined) {
  return row
    ? {
        lastBroadcastAt: row.last_broadcast_at,
        lastSampleId: row.last_sample_id,
        sequence: row.sequence,
      }
    : null;
}

function fromStoredSample(row: StoredSampleRow): KeyedTimingSample {
  return {
    durationMs: row.duration_ms,
    key: String(row.id),
    observedAt: row.observed_at,
    routeClass: row.route_class,
    statusClass: row.status_class,
  };
}

function retentionStore(sql: SqlStorage): PublicStreamRetentionStore {
  return {
    deletePointsBeyond: (limit) => sql.exec(
      `DELETE FROM samples
       WHERE id NOT IN (
         SELECT id FROM samples ORDER BY observed_at DESC, id DESC LIMIT ?
       )`,
      limit,
    ).rowsWritten,
    deletePointsOutside: (cutoff, now) => sql.exec(
      "DELETE FROM samples WHERE observed_at < ? OR observed_at > ?",
      cutoff,
      now,
    ).rowsWritten,
    deleteReplayBeyond: (limit) => sql.exec(
      `DELETE FROM replay
       WHERE sequence NOT IN (
         SELECT sequence FROM replay ORDER BY sequence DESC LIMIT ?
       )`,
      limit,
    ).rowsWritten,
    deleteReplayContainingPointsBefore: (cutoff) => sql.exec(
      "DELETE FROM replay WHERE oldest_observed_at IS NULL OR oldest_observed_at < ?",
      cutoff,
    ).rowsWritten,
    deleteReplayOutside: (cutoff, now) => sql.exec(
      "DELETE FROM replay WHERE generated_at < ? OR generated_at > ?",
      cutoff,
      now,
    ).rowsWritten,
  };
}

function cloudflareTraceSql(sql: SqlStorage): TraceSql {
  return {
    exec<Row>(query: string, ...bindings: TraceSqlValue[]): TraceSqlCursor<Row> {
      const cursor = sql.exec(query, ...bindings);
      return {
        rowsWritten: cursor.rowsWritten,
        toArray: () => cursor.toArray() as Row[],
      };
    },
  };
}

async function tracePublicApiRequest(
  operation: Exclude<PublicServerOperation, "article">,
  request: Request,
  room: DurableObjectStub<TailLatencyRoom>,
  context: ExecutionContext,
): Promise<Response> {
  return context.tracing.enterSpan(`worker.${operation}-request`, async (nativeSpan) => {
    nativeSpan.setAttribute("app.telemetry.route_class", operation);
    const browserParent = request.headers.get("traceparent")
      ?? (operation === "stream" ? new URL(request.url).searchParams.get("traceparent") : null);
    const started = startPublicSpan(browserParent, Date.now());
    const response = await room.fetch(withTraceparent(request, started.traceparent, operation === "stream"));
    nativeSpan.setAttribute("http.response.status_code", response.status);
    context.waitUntil(recordPublicRuntimeSpan(
      room,
      finishWorkerSpan(operation, started, response.status, Date.now()),
    ));
    return response;
  });
}

async function ingestPublicOtlpRequest(
  request: Request,
  room: DurableObjectStub<TailLatencyRoom>,
): Promise<Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    return new Response("Expected OTLP/HTTP JSON", { status: 415 });
  }
  const payload = await readBoundedJson(request, 64 * 1024);
  if (payload === null) return new Response("Invalid or oversized OTLP payload", { status: 400 });
  const spans = parsePublicOtlpJson(payload);
  if (spans === null) return new Response("Disallowed OTLP span batch", { status: 400 });
  const admissionToken = request.headers.get(PUBLIC_TRACE_ADMISSION_HEADER);
  if (!admissionToken) return new Response("Missing trace admission", { status: 403 });

  const stored = await recordPublicBrowserSpans(room, admissionToken, spans);
  if (stored.status === 403) return new Response("Trace admission rejected", { status: 403 });
  if (!stored.ok) return new Response("Telemetry storage unavailable", { status: 503 });
  return Response.json({}, {
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

async function traceArticleRequest(
  request: Request,
  url: URL,
  env: Env,
  room: DurableObjectStub<TailLatencyRoom>,
  context: ExecutionContext,
): Promise<Response> {
  return context.tracing.enterSpan("worker.article-request", async (nativeSpan) => {
    nativeSpan.setAttribute("app.telemetry.route_class", "article");
    const startedAt = performance.now();
    const publicStarted = url.pathname === OBSERVABILITY_ARTICLE_PATH
      ? startPublicSpan(null, Date.now())
      : null;
    let response = await env.ASSETS.fetch(request);

    if (publicStarted) {
      const admissionToken = crypto.randomUUID().replaceAll("-", "");
      const admitted = await issueBrowserTraceAdmission(
        room,
        admissionToken,
        publicStarted.context.traceId,
      );
      if (admitted) {
        response = injectBrowserTraceContext(response, publicStarted.traceparent, admissionToken);
        context.waitUntil(recordPublicRuntimeSpan(
          room,
          finishWorkerSpan("article", publicStarted, response.status, Date.now()),
        ));
      }
    }

    const sample = {
      durationMs: Math.min(60_000, Math.max(0, performance.now() - startedAt)),
      observedAt: Date.now(),
      routeClass: "article",
      statusClass: classifyStatus(response.status),
    } satisfies PublicTimingSample;
    context.waitUntil(room.fetch(new Request("https://tail-latency.internal/record", {
      body: JSON.stringify(sample),
      headers: { "content-type": "application/json" },
      method: "POST",
    })));
    nativeSpan.setAttribute("http.response.status_code", response.status);
    return withSecurityHeaders(response, url);
  });
}

function recordPublicRuntimeSpan(
  room: DurableObjectStub<TailLatencyRoom>,
  span: PublicSpan,
): Promise<Response> {
  return recordPublicRuntimeSpans(room, [span]);
}

function recordPublicRuntimeSpans(
  room: DurableObjectStub<TailLatencyRoom>,
  spans: readonly PublicSpan[],
): Promise<Response> {
  return room.fetch(new Request("https://observability.internal/public-spans", {
    body: JSON.stringify(spans),
    headers: { "content-type": "application/json" },
    method: "POST",
  }));
}

function recordPublicBrowserSpans(
  room: DurableObjectStub<TailLatencyRoom>,
  admissionToken: string,
  spans: readonly PublicSpan[],
): Promise<Response> {
  return room.fetch(new Request("https://observability.internal/public-browser-spans", {
    body: JSON.stringify(spans),
    headers: {
      "content-type": "application/json",
      [PUBLIC_TRACE_ADMISSION_HEADER]: admissionToken,
    },
    method: "POST",
  }));
}

async function issueBrowserTraceAdmission(
  room: DurableObjectStub<TailLatencyRoom>,
  token: string,
  traceId: string,
): Promise<boolean> {
  const response = await room.fetch(new Request("https://observability.internal/public-trace-admissions", {
    body: JSON.stringify({ token, traceId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }));
  return response.status === 201;
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("OTLP payload exceeds the public intake limit");
        return null;
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    return null;
  }
}

function withTraceparent(request: Request, traceparent: string, stripQueryContext: boolean): Request {
  const headers = new Headers(request.headers);
  headers.set("traceparent", traceparent);
  if (!stripQueryContext) return new Request(request, { headers });
  const url = new URL(request.url);
  url.searchParams.delete("traceparent");
  return new Request(url, { headers, method: request.method });
}

function injectBrowserTraceContext(
  response: Response,
  traceparent: string,
  admissionToken: string,
): Response {
  if (!response.headers.get("content-type")?.startsWith("text/html")) return response;
  const transformed = new HTMLRewriter()
    .on("head", {
      element(element) {
        element.prepend(
          `<meta name="traceparent" content="${traceparent}"><meta name="public-trace-admission" content="${admissionToken}">`,
          { html: true },
        );
      },
    })
    .transform(response);
  const uncached = new Response(transformed.body, transformed);
  uncached.headers.set("cache-control", "no-store");
  return uncached;
}

function serverOperation(pathname: string): Exclude<PublicServerOperation, "article"> | null {
  if (pathname === "/api/tail-latency/snapshot" || pathname === "/api/observability/snapshot") {
    return "snapshot";
  }
  if (pathname === "/api/stream") return "stream";
  return null;
}

function classifyRoute(pathname: string): PublicTimingSample["routeClass"] {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/posts/")) return "article";
  if (/\.[a-z0-9]{2,8}$/i.test(pathname)) return "asset";
  return "other";
}

function classifyStatus(status: number): PublicTimingSample["statusClass"] {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

function parseSequence(raw: string | null): number {
  const parsed = Number(raw ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseStoredJson(payload: string): unknown {
  try { return JSON.parse(payload) as unknown; } catch { return null; }
}

async function parseRequestJson(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}

function isLoopbackHttpUrl(raw: string | undefined): raw is string {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

function withSecurityHeaders(response: Response, requestUrl: URL): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  if (secured.headers.get("content-type")?.startsWith("text/html")) {
    const webSocketOrigin = `${requestUrl.protocol === "https:" ? "wss:" : "ws:"}//${requestUrl.host}`;
    secured.headers.set(
      "content-security-policy",
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${webSocketOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    );
  }
  return secured;
}
