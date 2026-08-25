# Architecture, privacy, and bounds

## Standing realtime architecture

- Required flow: `event stream -> reducer/domain core -> bounded projection -> latest projection buffer -> requestAnimationFrame render loop -> keyed/persistent SVG/DOM updates`.
- `WebSocket handlers: may parse, enqueue, or store projections; must not redraw the UI directly.`
- `Rendering: browser-cadence rendering with coalesced updates.`
- `Every public stream declares one presentation window; raw rows, projections, replay, snapshots, and rendering enforce that same window.`
- `Tests: deterministic reducer/projection tests, actual SQLite row-count tests, and rendered-page inspection under genuine stream load.`

This is a repository invariant, not a tail-latency preference. `src/domain/tail-latency.ts` contains the typed `PUBLIC_STREAMS` allowlist. Every entry must be created through `definePublicStream`, which requires a duration, point cap, and broadcast cadence. The shared boundary derives the cutoff and replay capacity; a new stream is incomplete until its tests overfill both the time range and point cap and prove that projection, rendering, and physical storage stay within the declaration.

## One presentation window

The tail-latency stream presents the inclusive interval `[now - 60 seconds, now]`, capped at the newest 300 points. Its one-second broadcast cadence derives a maximum of 61 replay projections for that same interval. These values are declared once in `TAIL_LATENCY_STREAM`; reducers, SQLite retention, snapshot and replay recovery, browser filtering, chart geometry, and expiry scheduling consume that definition.

`src/domain/public-stream.ts` owns the definition and pure selection rules. `src/domain/public-stream-storage.ts` owns the storage enforcement interface. It hides the physical store behind five deletion operations, so the policy can be tested against real SQLite without coupling the domain to Cloudflare APIs. `src/worker/index.ts` implements those operations for Durable Object SQL and invokes them inside `transactionSync`.

Rows with timestamps before the cutoff or after `now` are physically deleted. Remaining sample rows are capped at 300 by observation time and insertion ID. Each replay row stores the timestamp of its oldest payload point; the row is deleted when that point crosses the cutoff. Replay is capped at 61 rows. Legacy rows with unknown coverage are unsafe and deleted. The current projection is rebuilt from surviving sample rows. The next hibernating alarm is the earlier of a pending cadence flush and one millisecond after the oldest point reaches the inclusive boundary. Expiry therefore continues when traffic pauses, without an in-memory interval.

Snapshot and WebSocket admission run retention before reading storage. They cannot return an expired current payload or replay frame. The browser applies the same selector again and schedules its own presentation-only expiry repaint, so a disconnected or quiet page does not display an aged point while waiting for another server projection.

## Ownership and flow

`src/domain/tail-latency.ts` owns the strict sanitized input schema and version 2 public projection. It receives keyed, allowlisted samples and emits ordered `{ key, durationMs, observedAt }` points plus `p50Ms`, `p95Ms`, `maxMs`, count, sequence, and generation time. It performs no I/O.

`src/worker/index.ts` owns measurement and Cloudflare I/O. The Worker measures only static-asset fetch duration. One SQLite-backed Durable Object named `public` owns ordering, physical retention, the singleton current projection, bounded replay, hibernating alarms, and WebSocket fan-out. It broadcasts no more than once per second; an in-cadence burst schedules one persisted flush.

`src/visualizations/page-stream.ts` owns the single page connection. The first slice admits exactly one stream, `tail-latency`. The public socket is `GET /api/stream?streams=tail-latency&since=<sequence>`. The message handler validates and stores only the latest projection. One `requestAnimationFrame` callback coalesces arrivals before notifying active visualizations. An `IntersectionObserver` and page-visibility check close the connection while the chart is off-screen.

`src/visualizations/tail-latency.ts` owns article-specific rendering. It updates persistent area and line paths plus one amber latest-point circle; historical requests remain in path geometry without separate DOM nodes. One animation controller interpolates toward the newest eligible geometry, coalesces an in-flight replacement from the last painted frame, and owns at most one animation frame. It cancels work off-screen and applies updates immediately when `prefers-reduced-motion` is active. It never replaces the SVG or renders a point outside the declared window. The server-rendered version 2 projection remains as the static fallback.

## Sequence and recovery

Each broadcast receives a monotonic sequence. The browser fetches the current snapshot, then opens the WebSocket with that sequence in `since`. On reconnect, the object replays later retained projections only when the client overlaps replay storage. A new client, a missing range, a client older than the retained range, an expired range, or a malformed stored payload receives the current validated snapshot. Missing old history is expected and is not repaired from another database.

Sequence 0 is the static fallback and the no-live-projection sentinel. The browser rejects duplicate and out-of-order sequences. Expiry may rebuild the persisted current payload at the existing sequence; browser-side expiry removes the same aged points immediately, and the next cadence projection carries the next sequence.

## Public telemetry contract

Only these fields enter storage:

- `durationMs`: non-negative and capped at 60 seconds;
- `observedAt`: integer timestamp and the retention key;
- `routeClass`: `home`, `article`, `asset`, or `other`;
- `statusClass`: `2xx`, `3xx`, `4xx`, or `5xx`.

The strict schema rejects extra fields. The engine never retains request paths, query strings, IP addresses, user agents, headers, bodies, secrets, or raw operational logs. Browsers are read-only; a client WebSocket message closes that connection as a policy violation.

## Storage growth audit

- `samples`: at most 300 rows, all in the current 60-second window;
- `replay`: at most 61 rows, all generated in that window and individually deleted when their oldest point expires;
- `current_projection`: exactly zero or one row through its singleton primary key;
- `sqlite_sequence`: one metadata row for the sample table’s `AUTOINCREMENT` counter; its row count is fixed and it contains no telemetry point;
- accepted WebSockets: hibernated runtime attachments, not historical telemetry; connection admission remains a public-launch rate-limiting gate.

The deterministic storage test inserts substantially more samples and replay rows than allowed, asserts exact SQLite row counts, and advances the clock beyond the window without inserting traffic. A new stream must provide the same proof.

## Failure behavior

- Invalid internal samples receive `400` and never enter the reducer.
- Unknown public streams receive `400`; non-WebSocket stream requests receive `426`.
- A failed delivery closes only that socket.
- Missing or invalid live state returns the static fallback.
- Malformed internal JSON receives `400`.
- Background telemetry failure does not delay the asset response.
- HTML allows scripts and styles only from the same origin; WebSockets are restricted to the page origin.

## Deliberate limits

The project has no general chart catalogue, plugin API, analytics warehouse, raw archive, or separate realtime provider. A post imports its own TypeScript visualization. The shared stream definition and retention interface enforce the repository invariant without speculating about a generic telemetry framework. A later stream still adds its schema, reducer, persistence adapter, and over-capacity/expiry tests explicitly.
