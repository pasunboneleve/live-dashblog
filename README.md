# Live Dashblog

Live Dashblog is a cost-restrained instrumented-essay blog. Astro publishes ordinary Markdown or MDX, while each post may import a purpose-built TypeScript visualization fed by a privacy-bounded projection of the Worker serving the site.

The first slice explains tail latency with a rolling 60-second request line. It is a local scaffold: no Cloudflare or Bitwarden account has been accessed, and no resource has been deployed.

## Architecture at a glance

```text
static Astro article + Worker request timing
  -> typed reducer
  -> bounded SQLite Durable Object projection
  -> one hibernating page WebSocket with a keyed stream envelope
  -> latest projection buffer
  -> requestAnimationFrame
  -> persistent keyed SVG line, area, and points
```

## Quick start

```bash
npm install
npm run dev
```

Astro serves the static authoring view at `http://localhost:4321`. To exercise the Worker, Durable Object, and WebSocket locally, run `npm run dev:worker` and open the Wrangler URL instead. See [local development](docs/development.md).

For a supervised live review that rebuilds Astro and reloads the Worker-served page as files change:

```bash
devloop run --config devloop.toml
```

## Validation

```bash
npm run check
```

## Repository map

- `src/pages/` owns articles and static routes.
- `src/domain/` owns typed public telemetry and pure projections.
- `src/worker/` owns Cloudflare I/O, persistence, and fan-out.
- `src/visualizations/` owns page-level streaming and per-post rendering.
- `docs/` owns durable architecture and operations detail.
- `scripts/` streams Bitwarden values to supported consumers without persistent secret files.

## Documentation

- [Architecture, privacy, and bounds](docs/architecture.md)
- [Local development and validation](docs/development.md)
- [Deployment, Terraform boundary, and cost](docs/deployment.md)
- [Bitwarden secrets and machine recovery](docs/secrets.md)

## Status

One vertical slice is implemented. The domain core has deterministic tests; Cloudflare deployment and live-account checks remain intentionally unperformed.
