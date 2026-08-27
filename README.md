# Live Dashblog

[![CI](https://github.com/pasunboneleve/live-dashblog/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pasunboneleve/live-dashblog/actions/workflows/ci.yml?query=branch%3Amain)

Live Dashblog is a cost-restrained instrumented-essay blog. Astro publishes ordinary Markdown or MDX, while each post may import a purpose-built TypeScript visualization fed by a privacy-bounded projection of the Worker serving the site.

The runtime post now explains its own request with joined browser, Worker, and Durable Object spans. It derives bounded Honeycomb-like aggregates, a duration heatmap, and trace waterfalls from a five-minute SQLite window. The development-metrics post remains planned.

## Architecture at a glance

```text
Astro article + Worker-issued trace admission
  -> browser, Worker, and Durable Object OpenTelemetry spans
  -> strict same-origin OTLP boundary
  -> bounded whole-trace SQLite Durable Object
  -> aggregate, heatmap, and waterfall projection replay
  -> one hibernating page WebSocket
  -> latest projection buffer
  -> requestAnimationFrame
  -> persistent keyed DOM and SVG
```

## Quick start

```bash
npm install
npm run dev
```

Astro serves the embedded authoring view at `http://localhost:4321`. To exercise joined traces, the Durable Object, and WebSocket replay locally, run `npm run dev:worker` and open `/posts/observability/` on the Wrangler URL. See [local development](docs/development.md).

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
- [Decision: separate runtime and deployment-time metrics](docs/decisions/0001-separate-runtime-and-deployment-metrics.md)
- [Decision: bounded OpenTelemetry self-observation](docs/decisions/0002-use-bounded-opentelemetry-for-runtime-self-observation.md)
- [Local development and validation](docs/development.md)
- [Deployment, Terraform boundary, and cost](docs/deployment.md)
- [Bitwarden secrets and machine recovery](docs/secrets.md)

## Status

The Cloudflare scaffold is live on workers.dev, while the recursive observability implementation is currently validated locally and awaits its normal review and deployment path. Launch traffic shedding, cost notifications, the complete production smoke test, and the deployment-time development-metrics post remain open.
