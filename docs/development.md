# Local development and validation

## Requirements

- Node.js 24 or another version supported by the pinned Astro and Wrangler releases;
- npm 11 or a compatible npm release;
- a browser for rendered-page inspection.

Install the pinned dependencies:

```bash
npm install
```

## Authoring loop

Run Astro when editing prose, layout, or the static fallback:

```bash
npm run dev
```

Open `http://localhost:4321/posts/tail-latency/`. Astro does not emulate the Worker API in this mode, so the chart intentionally remains on its static snapshot.

## Realtime Worker loop

Build the static site, then let Wrangler serve the asset bundle through the Worker and local SQLite Durable Object:

```bash
npm run dev:worker
```

Open the URL Wrangler reports, normally `http://localhost:8787/posts/tail-latency/`. Reload or request site assets to produce genuine Worker timings. The projection cadence is capped at one per second. After a quiet interval, the first sample publishes immediately. A later sample inside that cadence window schedules one persisted alarm for `last broadcast + 1 second`; every sample in that burst appears when the alarm fires, even if traffic then stops. An immediate publish clears a pending alarm, and a late alarm rechecks the same cadence decision before publishing.

To generate a local burst without inventing mock telemetry, request the home page several times while the article remains open:

```bash
for request in {1..20}; do curl --silent --output /dev/null http://localhost:8787/; done
```

The live sequence may advance once, not twenty times, during a one-second interval, and the next window count must include the burst. Scroll until the chart is more than the observer’s 200-pixel margin outside the viewport, issue another request after the cadence interval, then return to the chart. Going off-screen or hiding the page must close the socket. Returning opens one new page-level socket with `since=<last sequence>`; success means there is still only one socket at a time and the chart shows a newer sequence from contiguous replay or the current snapshot. Intermediate replay sequences may be coalesced into one browser frame.

Do not run Astro and Wrangler on the same port. A dependency, Wrangler configuration, or build-output change requires restarting `dev:worker`; ordinary browser reloads do not.

## Supervised live review with devloop

Validate the repository configuration before starting it:

```bash
devloop validate --config devloop.toml
```

Then start one supervised Wrangler runtime:

```bash
devloop run --config devloop.toml
```

Review `http://127.0.0.1:8787/posts/tail-latency/`. This is the Worker-served article, so snapshots, local SQLite Durable Object persistence, WebSockets, replay, and alarms remain active. Do not run `npm run dev` or `npm run dev:worker` beside this session; devloop already owns port 8787 and its Wrangler child.

The workflow behaves as follows:

- The polling watcher checks repository-local paths every 250 ms. This avoids unreliable native notifications observed on the development host while retaining the same debounced workflows.
- Startup runs one Astro production build, starts Wrangler, and polls the lightweight `GET /__ready` probe for up to 30 seconds. A `200` response means the supervised runtime is ready. The probe does not add a timing sample or open a Durable Object session.
- Changes under `src/pages/`, `src/layouts/`, `src/components/`, `src/styles/`, `src/visualizations/`, `src/domain/`, or `public/`, plus `astro.config.mjs`, run `npm run build`, restart the supervised Wrangler process so it opens the replaced `dist/` tree, require the same readiness probe to pass, then allow 500 ms for the reload listener to reconnect before notifying the browser.
- Changes under `src/worker/` restart the same supervised Wrangler process, require the readiness hook to pass, then ask connected review pages to reload. Devloop never starts a competing server.
- A `wrangler.jsonc` change restarts the supervised Wrangler process and must pass the same readiness hook before browser reload.
- Dependency or `devloop.toml` changes require stopping the session, updating dependencies or configuration explicitly, validating the config, and starting a new session.

Devloop writes session state and durable logs under `.devloop/`, which is ignored. The devloop build receives an ephemeral localhost event URL and includes a same-origin external reload module in the review page; `scripts/dev-worker.sh` passes the child-only value to Wrangler so a dev-only route can proxy the event stream. Ordinary `npm run build` and production builds do not receive that URL, so the module remains unreferenced and inert while the proxy route stays disabled.

For a live review, keep the article open and read the combined devloop/Wrangler output. After an edit, require all three observations before accepting it: the named watch workflow ran, its build or Worker refresh completed, and the browser loaded the changed page without console or network errors. Use the burst and off-screen recovery procedure above to inspect realtime behavior.

## Deterministic checks

```bash
npm run typecheck
npm run test
npm run build
```

`npm run check` runs those commands in order. The focused tests cover strict public-sample validation, histogram boundaries, percentile behavior, and the 300-sample bound.

## Rendered inspection

Before declaring a visualization production-ready, inspect the Worker-served article at desktop and narrow widths, plus zoom-equivalent scales near 80%, 100%, 125%, and 150%. Confirm:

- no console error or failed asset request;
- the WebSocket connects, reconnects with a sequence, and pauses off-screen;
- bursty asset requests do not produce more than one broadcast per second;
- the SVG bars persist while their attributes change;
- labels do not overlap and horizontal overflow remains inside the chart on narrow screens;
- the static snapshot remains legible with the Worker stopped.
