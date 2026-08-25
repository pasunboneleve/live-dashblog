# Deployment, infrastructure, and cost

The guidance in this document was checked against official Cloudflare documentation on 25 August 2026.

## Application deployment

Astro pre-renders the site into `dist/`. Wrangler bundles `src/worker/index.ts`, uploads `dist/` as [Worker static assets](https://developers.cloudflare.com/workers/static-assets/), and applies the SQLite Durable Object migration declared in `wrangler.jsonc`.

The application deployment command is:

```bash
npm run check
npx wrangler deploy
```

Do not run it until deployment is explicitly authorized. `DEVLOOP_BROWSER_EVENTS_URL` is a local supervisor value and must never be configured in a deployed Worker; leaving it absent keeps the development reload proxy disabled. Cloudflare’s [Astro guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/) recommends static output when pages do not need on-demand rendering, and its [Workers CLI guide](https://developers.cloudflare.com/workers/get-started/guide/) uses Wrangler for Worker deployment.

## Why Terraform does not deploy this application

Cloudflare supports Worker uploads through Terraform, but its [infrastructure-as-code guidance](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/) also describes using Terraform for the stable Worker resource while Wrangler owns bundling, versions, and deployments. This repository keeps one application configuration in `wrangler.jsonc`; duplicating its compatibility date, modules, asset manifest, bindings, and migration lifecycle in Terraform would create two owners.

No Terraform configuration exists yet because no stable account-level input has been selected. Once a domain and zone are known, Terraform may own resources it models well, such as DNS records, custom-domain routing, or account policy. Wrangler remains the owner of Worker code, static assets, Durable Object bindings and migrations, and application-secret updates.

Never place encrypted application-secret values in Terraform configuration. Marking a Terraform value sensitive hides it from routine output but does not remove it from state. Use Wrangler’s encrypted secret binding mechanism instead.

## Secrets and deployment ordering

The current slice requires no application secret. If a later allowlisted producer needs one, declare its name in Wrangler configuration, run the Bitwarden-to-Wrangler script in [secrets.md](secrets.md), then deploy or create a version according to the chosen rollout model. Cloudflare notes that `wrangler secret put` creates and deploys a new Worker version; use `wrangler versions secret put` when a staged version is required. See [Cloudflare’s secrets guide](https://developers.cloudflare.com/workers/configuration/secrets/).

## Public-launch checklist

Do not treat the local vertical slice as launch-ready. Before any authorized public deployment:

1. add Cloudflare rate limiting or equivalent shedding for asset ingestion and WebSocket admission;
2. configure a billing notification against the agreed operating ceiling;
3. rerun the Worker-served CSP, external stylesheet, WebSocket, cadence, replay, and dev-proxy-disabled checks;
4. obtain explicit deployment authorization and deploy with Wrangler;
5. add domain routing and Terraform-managed DNS or account policy only after the zone inputs are chosen.

The first three items are deploy blockers, not optional follow-up work.

## Cost envelope

The design uses one SQLite-backed Durable Object, a 300-row sanitized sample window, 120 compact replay projections, at most one broadcast and persisted alarm per active cadence window, no polling loop, and the Hibernation WebSocket API. Cloudflare recommends hibernation because idle connected objects stop accruing duration charges; see [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

Each essay load intentionally contributes its HTML, CSS, JavaScript, and favicon fetch timings to the histogram; API snapshot and WebSocket requests do not. The Durable Object has no platform-level abuse control. Before a public launch, add Cloudflare rate limiting or an equivalent request-shedding policy and set a billing notification. Hibernation controls idle duration cost, not a flood of new connection requests.

Cloudflare’s current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) offers SQLite-backed Durable Objects on Free and lists Workers Paid at a US$5 monthly minimum with included Workers and Durable Object usage. That base charge will often fit an approximate A$10 target, but exchange rates, tax, traffic, CPU, requests, and SQLite writes can move the invoice. Treat the target as an operating alarm, not a guarantee. Review Cloudflare’s calculator and actual usage before enabling Paid.
