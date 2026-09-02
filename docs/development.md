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

Open `http://localhost:4321/posts/observability/`. Astro does not emulate the Worker API in this mode, so the dashboard intentionally remains on its embedded joined trace.

## Realtime Worker loop

Build the static site, then let Wrangler serve the asset bundle through the Worker and local SQLite Durable Object:

```bash
npm run dev:worker
```

Open the URL Wrangler reports, normally `http://localhost:8787/posts/observability/`. That request starts a Worker root, admits browser OTLP for the same trace, and joins the page, snapshot, and stream spans through the Durable Object. Complete traces appear after the five-second assembly grace. Projection broadcasts are capped at one every five seconds; later finalized traces inside that interval set persisted dirty state and schedule one alarm for the next cadence boundary.

The dashboard is event-driven rather than synthetic: each genuine article visit supplies enough activity for a complete low-traffic trace. For a continuous local review, keep one article open and request another admitted page at a restrained cadence:

```bash
while true; do curl --silent --output /dev/null http://localhost:8787/posts/observability/; sleep 2; done
```

Stop it with `Ctrl-C`. These are genuine article requests, not random trace fixtures. The trace and span counts should advance after assembly, the duration buckets should change, and the slow-trace selector should retain at most five joined waterfalls.

To exercise admission without inventing mock telemetry, request the article several times while one copy remains open:

```bash
for request in {1..8}; do curl --silent --output /dev/null http://localhost:8787/posts/observability/; sleep 0.2; done
```

The live sequence may advance once, not eight times, during one five-second interval. Scroll until the dashboard is more than the observer’s 300-pixel margin outside the viewport, issue another request after the cadence interval, then return. Going off-screen or hiding the page must close the socket. Returning opens one page-level socket with `streams=observability&since=<last sequence>`; success means the dashboard receives later replay or the current snapshot without duplicating a sequence. Intermediate projections may coalesce into one browser frame.

For a deterministic shedding check, start more than ten observability article requests in one second. The first ten roots may receive browser trace admission; later pages must still return their static HTML without trace metadata. More than 30 snapshot requests or ten WebSocket handshakes in one second receive `429` and `Retry-After`. A new fixed window admits work again. Do not use this burst as the continuous feeder: its purpose is to prove that optional telemetry fails closed while content fails open.

The observability stream retains at most 120 complete traces and 960 spans from the last five minutes, with no trace exceeding 16 spans. The Durable Object expires whole traces during quiet traffic and caps replay at 61 projections. The browser applies the same five-minute boundary while disconnected. See [architecture](architecture.md#observability-presentation-window) for the storage and alarm invariants.

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

Review `http://127.0.0.1:8787/posts/observability/`. This is the Worker-served article, so joined telemetry, local SQLite persistence, projections, WebSockets, replay, and alarms remain active. Do not run `npm run dev` or `npm run dev:worker` beside this session; devloop already owns port 8787 and its Wrangler child.

The workflow behaves as follows:

- The polling watcher checks the production source, content, style, and public-asset files declared in `devloop.toml` every 250 ms. Literal paths detect atomic editor replacements without recursively scanning transient hidden tooling paths; add each new production file to the appropriate watch group when it is introduced.
- Startup runs one Astro production build, starts Wrangler, and polls the lightweight `GET /__ready` probe for up to 30 seconds. A `200` response means the supervised runtime is ready. The probe does not add a timing sample or open a Durable Object session.
- Changes to the declared Astro pages, layout, component, styles, visualisation, shared domain modules, public assets, or `astro.config.mjs` run `npm run build`, restart the supervised Wrangler process so it opens the replaced `dist/` tree, require the same readiness probe to pass, then allow 500 ms for the reload listener to reconnect before notifying the browser.
- A change to the declared Worker entry point restarts the same supervised Wrangler process, requires the readiness hook to pass, then asks connected review pages to reload. Devloop never starts a competing server.
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

`npm run check` runs those commands in order. The focused tests cover strict public span and OTLP validation, Worker-bound admission, fixed-window burst and expiry behavior, joined parentage, out-of-order whole-trace assembly, exact SQLite trace and replay bounds, restart recovery, aggregate and duration-band derivation, clipped time buckets, root-request clocks and latency, trace-sample selection, waterfall geometry, sequence rejection, and the legacy tail-latency slice.

For the tail-latency slice, confirm that a live point’s SVG `cx` decreases between animation frames without a new projection, the status reads only `live`, and scrolling the chart beyond its observer margin stops both the animation frame and page-level stream. With reduced motion enabled, points advance only on projection or expiry updates.

## Rendered inspection

Before declaring a visualization production-ready, inspect the Worker-served article at desktop and narrow widths, plus zoom-equivalent scales near 80%, 100%, 125%, and 150%. Confirm:

- no console error or failed asset request;
- the WebSocket connects with `streams=observability`, replays only newer sequences, and pauses off-screen;
- repeated visits do not produce more than one projection broadcast per five seconds;
- the summary, runtime-side shares, ten labelled duration bands, and 30 or 31 clipped time buckets match the snapshot response;
- selecting a populated time bucket chooses its most informative retained trace; an empty bucket or a populated bucket without retained detail leaves the explicitly labelled previous trace visible;
- request `P95` uses root-span duration, while the selected trace labels its separate observed window;
- no more than five trace selectors and 16 keyed waterfall rows exist;
- changing the selected trace updates `aria-pressed` and the waterfall description;
- the waterfall clock starts at the root request, corrects each service clock without collapsing its elapsed intervals, and moves spans after more than one idle second into the bounded keyed activity list;
- browser, Worker, and Durable Object bars remain distinguishable without motion;
- labels do not overlap and horizontal overflow remains inside the dashboard on narrow screens;
- the embedded joined trace remains legible with the Worker stopped.
