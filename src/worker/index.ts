import {
  REPLAY_LIMIT,
  SAMPLE_LIMIT,
  STATIC_FALLBACK_PROJECTION,
  STREAM_NAME,
  decideProjectionAction,
  projectTailLatency,
  publicTimingSampleSchema,
  selectRecoveryMode,
  tailLatencyProjectionSchema,
  type PublicTimingSample,
  type StreamEnvelope,
  type TailLatencyProjection,
} from "../domain/tail-latency";
import { DurableObject } from "cloudflare:workers";

interface Env {
  ASSETS: Fetcher;
  DEVLOOP_BROWSER_EVENTS_URL?: string;
  TAIL_LATENCY: DurableObjectNamespace<TailLatencyRoom>;
}

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

    if (url.pathname === "/api/stream" || url.pathname === "/api/tail-latency/snapshot") {
      return room.fetch(request);
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
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/record") return this.record(request);
    if (request.method === "GET" && url.pathname === "/api/tail-latency/snapshot") return this.snapshot();
    if (request.method === "GET" && url.pathname === "/api/stream") return this.connectWebSocket(request);
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
    const current = this.currentRow();
    if (this.latestSampleId() <= (current?.last_sample_id ?? 0)) return;
    const action = decideProjectionAction(current?.last_broadcast_at ?? null, now, false);
    if (action.kind === "publish") {
      this.publishProjection(now);
    } else if (action.kind === "schedule") {
      await this.ctx.storage.setAlarm(action.at);
    }
  }

  private async record(request: Request): Promise<Response> {
    const parsed = publicTimingSampleSchema.safeParse(await parseRequestJson(request));
    if (!parsed.success) return new Response("Invalid public timing sample", { status: 400 });

    const sample = parsed.data;
    this.ctx.storage.sql.exec(
      "INSERT INTO samples (duration_ms, observed_at, route_class, status_class) VALUES (?, ?, ?, ?)",
      sample.durationMs, sample.observedAt, sample.routeClass, sample.statusClass,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM samples WHERE id NOT IN (SELECT id FROM samples ORDER BY id DESC LIMIT ?)",
      SAMPLE_LIMIT,
    );

    const now = Date.now();
    const current = this.currentRow();
    const alarmScheduled = await this.ctx.storage.getAlarm() !== null;
    const action = decideProjectionAction(
      current?.last_broadcast_at ?? null,
      now,
      alarmScheduled,
    );
    if (action.kind === "publish") {
      if (alarmScheduled) await this.ctx.storage.deleteAlarm();
      this.publishProjection(now);
    } else if (action.kind === "schedule") {
      await this.ctx.storage.setAlarm(action.at);
    }

    return new Response(null, { status: 202 });
  }

  private publishProjection(now: number): void {
    const current = this.currentRow();
    const storedSamples = this.ctx.storage.sql.exec<StoredSampleRow>(
      "SELECT id, duration_ms, observed_at, route_class, status_class FROM samples ORDER BY id",
    ).toArray();
    const samples = storedSamples.map(fromStoredSample);
    const projection = projectTailLatency(samples, (current?.sequence ?? 0) + 1, now);
    const payload = JSON.stringify(projection);
    const lastSampleId = storedSamples.at(-1)?.id ?? 0;

    this.ctx.storage.sql.exec(
      `INSERT INTO current_projection (singleton, sequence, generated_at, last_broadcast_at, last_sample_id, payload)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         sequence = excluded.sequence,
         generated_at = excluded.generated_at,
         last_broadcast_at = excluded.last_broadcast_at,
         last_sample_id = excluded.last_sample_id,
         payload = excluded.payload`,
      projection.sequence, projection.generatedAt, now, lastSampleId, payload,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO replay (sequence, generated_at, payload) VALUES (?, ?, ?)",
      projection.sequence, projection.generatedAt, payload,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM replay WHERE sequence NOT IN (SELECT sequence FROM replay ORDER BY sequence DESC LIMIT ?)",
      REPLAY_LIMIT,
    );

    this.broadcast(projection);
  }

  private snapshot(): Response {
    return Response.json(this.readCurrentProjection(), {
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  private connectWebSocket(request: Request): Response {
    const url = new URL(request.url);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const streams = url.searchParams.get("streams")?.split(",") ?? [];
    if (streams.length !== 1 || streams[0] !== STREAM_NAME) {
      return new Response("Unknown or disallowed public stream", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [STREAM_NAME]);
    server.serializeAttachment({ streams: [STREAM_NAME] });

    const since = parseSequence(url.searchParams.get("since"));
    const bounds = this.ctx.storage.sql.exec<ReplayBoundsRow>(
      "SELECT MIN(sequence) AS oldest_sequence FROM replay",
    ).toArray()[0];
    const mode = selectRecoveryMode(since, bounds?.oldest_sequence ?? null);
    const replay = mode === "replay"
      ? this.ctx.storage.sql.exec<ReplayRow>(
          "SELECT payload FROM replay WHERE sequence > ? ORDER BY sequence LIMIT ?", since, REPLAY_LIMIT,
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

function fromStoredSample(row: StoredSampleRow): PublicTimingSample {
  return { durationMs: row.duration_ms, observedAt: row.observed_at, routeClass: row.route_class, statusClass: row.status_class };
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
