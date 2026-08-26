# 0001 Separate runtime and deployment-time metrics

## Status

Proposed

## Context

The first planned post explains the running blog through live, sanitized observability. Its data must remain useful at low traffic and must shed optional telemetry and realtime connections before unexpected traffic can threaten the operating budget.

The second planned post explains development using metrics initially obtained from [Appfire Flow](https://appfire.com/flow/info). Those metrics need to be current when the site is deployed, but readers do not need to query or recompute them. Flow is also scheduled for retirement on 31 December 2027, so its data shape and authentication model cannot become a permanent browser or article interface.

Putting both sources behind one runtime metrics service would give the browser an unnecessary upstream dependency, widen the secret boundary, and couple static development history to the Durable Object’s short presentation window. Computing both at build time would remove the defining live behavior from the observability post.

## Decision

Use two independent acquisition planes:

1. Runtime observability enters through the Cloudflare Worker, passes through explicit ingestion and realtime-admission budgets, and becomes a bounded public projection in a SQLite Durable Object. The article falls back to an embedded static view when live data is limited or unavailable.
2. Development metrics enter only during deployment through a replaceable source adapter. The adapter fetches, validates, aggregates, and redacts source data, then writes an immutable public snapshot into the Astro build. Source credentials exist only in the deployment job.

Each plane owns its typed schema and failure policy. Both expose a bounded public dataset, schema version, generation time, and measurement window to a purpose-built post visualization. They do not share persistence or a generic metrics framework.

A failed development-metrics refresh fails the candidate deployment. The previous successful deployment stays live; the pipeline does not silently label an old snapshot as current. Scheduled deployments may refresh the snapshot without a content change.

## Consequences

- Article loads never depend on Flow availability or credentials.
- Flow can be replaced without changing the post or browser contract, provided the next adapter emits the same public snapshot schema.
- Viral traffic can reduce observability fidelity without interrupting static content delivery.
- Runtime retention remains short and physically bounded; development snapshots contain only allowlisted aggregates for their declared reporting window.
- Deployment now depends on the selected development-metrics source. Source failure is visible as a failed deployment rather than stale public data.
- The deployment workflow will need a source credential and possibly a schedule after the supported Flow extraction interface and reporting interval are chosen.
