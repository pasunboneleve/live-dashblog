# Architecture, privacy, and bounds

## Standing realtime architecture

- Required flow: `event stream -> reducer/domain core -> bounded projection -> latest projection buffer -> requestAnimationFrame render loop -> keyed/persistent SVG/DOM updates`.
- `WebSocket handlers: may parse, enqueue, or store projections; must not redraw the UI directly.`
- `Rendering: browser-cadence rendering with coalesced updates.`
- `Every retained sample, replay, and projection collection has one documented bound; live connection admission is a separate launch gate.`
- `Tests: deterministic reducer/projection tests plus rendered-page inspection under genuine stream load.`

The checklist above is the standing contract for later stream types. This first slice covers sample and replay bounds, cadence, duplicate and out-of-order projection policy, persistent SVG updates, and rendered-page inspection under genuine request traffic. A later stream must define its own realistic test inputs and failure cases when it is introduced; the repository does not contain mock traffic requirements or empty framework modules for hypothetical streams.

## Ownership

`src/domain/tail-latency.ts` owns the public schema and pure projection. It receives allowlisted samples and emits a complete, bounded projection. It performs no I/O and can be tested without Cloudflare.

`src/worker/index.ts` owns measurement and Cloudflare I/O. The Worker measures only its static-asset fetch duration. One SQLite-backed Durable Object named `public` owns ordering, the 300-sample rolling reducer window, the current projection, 120 replay projections, and WebSocket fan-out. It emits at most once per second. A sample publishes immediately when no prior broadcast exists or the cadence interval has elapsed. A sample inside the interval schedules one persisted alarm for `last broadcast + 1 second`. Each projection persists the newest included sample ID. An immediate publish deletes any pending alarm; an alarm no-ops when no newer sample exists, otherwise re-runs the same cadence decision and reschedules rather than publishing early if another path has already broadcast. The object uses no in-memory interval or timeout, so it can hibernate while the alarm is pending.

`src/visualizations/page-stream.ts` owns the single connection for the page. The first slice admits exactly one allowlisted stream, `tail-latency`; the keyed envelope prevents the client from accepting an unrelated payload and leaves a deliberate seam for adding a second allowlisted stream later. Multi-key admission is not implemented. The public socket is `GET /api/stream?streams=tail-latency&since=<sequence>`. `streams` must contain exactly that one allowlisted name. `since` is a non-negative safe integer; missing or invalid values become `0`, and `since=0` requests the current snapshot without replay. Unknown streams return `400`, and a request without a WebSocket upgrade returns `426`. The message handler validates and stores only the latest projection. One `requestAnimationFrame` callback coalesces arrivals before notifying active visualizations.

`src/visualizations/tail-latency.ts` owns the article-specific rendering. It updates the attributes and accessible labels of server-rendered SVG bars keyed by bucket. It never replaces the SVG. An `IntersectionObserver` and page-visibility check close the connection when the visualization is off-screen. The server-rendered projection remains as the static fallback.

The browser retries a dropped connection after two seconds. That browser timer does not keep the Durable Object awake; the no-in-memory-timer hibernation rule applies to server code. Live projections begin at sequence 1. Sequence 0 is the static fallback and may also cross the snapshot or WebSocket boundary as an explicit no-valid-live-projection sentinel. The browser rejects projections that are not newer than its current sequence, so sequence 0 preserves the server-rendered fallback for a new client and the last good live frame for a reconnecting client. `since=0` requests the current snapshot without replaying history.

## Sequence and recovery

Every broadcast projection receives a monotonic sequence. The browser first fetches the current snapshot, then opens the WebSocket with that sequence in `since`. On reconnect, the Durable Object replays up to 120 later projections only when the client sequence is contiguous with retained history. A new client, a missing replay window, or a sequence older than `oldest retained - 1` receives exactly the current snapshot. Gaps older than the replay bound are expected and are not repaired from another database. A corrupt replay payload also falls back to the current validated snapshot.

## Public telemetry contract

Only these fields cross into storage:

- `durationMs`: finite, non-negative, capped at 60 seconds;
- `observedAt`: integer timestamp;
- `routeClass`: `home`, `article`, `asset`, or `other`;
- `statusClass`: `2xx`, `3xx`, `4xx`, or `5xx`.

The schema is strict, so extra fields fail validation. The engine does not retain request paths, query strings, IP addresses, user agents, headers, request bodies, secrets, or raw operational logs. Browsers can open allowlisted streams and read snapshots; any client WebSocket message closes the connection as a policy violation.

`routeClass`, `statusClass`, and `observedAt` are bounded classification metadata reserved for explicit later projections; projection version 1 reduces durations only. The sample window is trimmed by insertion ID, so `observedAt` is not an eviction key.

## Public projection contract

Version 1 uses bucket upper bounds of 25, 50, 100, 200, 400, 800, and 1,600 milliseconds, plus an overflow bucket. `p50Ms` and `p95Ms` use the nearest-rank method over capped durations in the current window. `maxMs`, `sampleCount`, `sequence`, `generatedAt`, `stream: "tail-latency"`, and the eight keyed histogram entries complete the projection. `GET /api/tail-latency/snapshot` returns that projection document with `Cache-Control: no-store`; the WebSocket envelope is `{ type: "projection", stream: "tail-latency", projection }`. Stored current and replay payloads pass the same schema before delivery; invalid storage falls back to the generated sequence-0 static projection.

The strict `version: 1` schema rejects additive wire fields. A contract change therefore requires a new version schema and an explicit compatibility decision before deployment; it must not silently widen version 1.

## Failure behavior

- Invalid internal samples receive `400` and never enter the reducer.
- Unknown public streams receive `400`.
- A non-WebSocket stream request receives `426`.
- A failed WebSocket delivery closes only that socket.
- A missing live projection returns the static fallback.
- A malformed internal JSON body receives `400` rather than escaping the Durable Object handler.
- Background telemetry failure does not delay the asset response; Cloudflare can surface the failed `waitUntil` operation during local or platform inspection without exposing it to the browser.
- HTML allows scripts and styles only from the same origin. Component CSS is emitted into the external Astro stylesheet, and WebSocket connections are restricted to the exact page origin.

## Deliberate limits

The first slice does not implement a general chart catalogue, plugin API, analytics warehouse, raw event archive, or separate realtime provider. A post imports its own TypeScript visualization. A future stream must add its public schema and reducer explicitly rather than receiving a generic operational payload. The rolling sample window follows insertion order of successful `record` calls, not client timestamps. Connected sockets are not a retained collection and have no application-level cap in this local slice; request shedding or rate limiting is therefore a hard public-launch gate.
