# 0002 Use bounded OpenTelemetry for runtime self-observation

## Status

Proposed

## Context

The observability post should explain the running blog with the telemetry produced by the page and server machinery that presents the explanation. The page needs both browser and server evidence, joined as a distributed trace rather than inferred from timestamps. It should offer Honeycomb-like aggregates, heatmaps, and trace waterfalls while remaining useful at low traffic and safe under an unexpected traffic spike.

A conventional unrestricted telemetry pipeline would conflict with that goal. Raw OpenTelemetry payloads may contain high-cardinality or private attributes, independent span eviction can break trace waterfalls, and instrumenting the telemetry renderer can create an infinite feedback loop. A permanent analytics archive would also exceed the blog’s short public presentation need.

## Decision

Use OpenTelemetry spans as the canonical runtime signal. Join browser and server work with W3C Trace Context:

1. The Worker starts the initial article `SERVER` span and injects its active `traceparent` into the HTML.
2. Browser document-load instrumentation continues that trace. Later browser operations create child spans.
3. Each browser HTTP operation creates a `CLIENT` span and propagates its context. The Worker extracts it and creates the corresponding remote `SERVER` child. Durable Object operations are `INTERNAL` children below the server span.
4. The Worker accepts browser spans through a same-origin OTLP/HTTP endpoint, maps them immediately to a strict sanitized public-span schema, and discards the raw payload. Worker instrumentation sends server and internal spans through the same sanitizer and bounded store without an OTLP network round trip.

Persist sanitized spans by whole trace in a SQLite Durable Object. Each record carries `traceId`, `spanId`, optional `parentSpanId`, enumerated name and kind, timestamps and duration, status, and allowlisted low-cardinality service, runtime-side, and route-class attributes. Do not retain arbitrary attributes, full URLs, query strings, IP addresses, user agents, headers, referrers, identifiers, bodies, or secrets.

One stream declaration defines the presentation window, maximum traces, maximum spans per trace, maximum total spans, replay cap, and broadcast cadence. Expiry and capacity eviction remove whole traces. Parent-based sampling preserves the root decision across browser and server spans; intake shedding and hard storage caps remain independent safeguards. The public projection reports the sample rate.

Derive Honeycomb-like aggregates and trace views from this bounded store. The projection includes count, error count and rate, `P50`, `P95`, and maximum span duration grouped only by allowlisted runtime side or service; explicitly labelled span-duration bands; wall-clock time buckets clipped to the presentation bounds whose latency metric and timestamp come from the root request; and bounded complete trace samples for drilldown. Do not create a separate raw archive or analytics warehouse.

Exclude telemetry intake, projection application, and observability visualization rendering from export into the canonical stream. The renderer may expose a labeled local-only final span, but it cannot export that span back into the stream it displays.

Keep browser OpenTelemetry behind a narrow repository adapter because its JavaScript browser instrumentation is experimental. The domain schema, trace joining, sampling behavior, projection reducer, whole-trace retention, and recursion exclusions require deterministic tests independent of the instrumentation package.

## Consequences

- One reader produces meaningful client and server spans without synthetic traffic.
- `traceId` and `parentSpanId` preserve exact cross-runtime causality and support a coherent waterfall.
- Viral traffic reduces telemetry fidelity while static article delivery remains available.
- Whole-trace eviction trades some span utilization for waterfalls that are never knowingly fragmented.
- The public data surface stays short-lived, low-cardinality, and explicitly sanitized.
- The observability post can display its own operation without an infinite telemetry loop.
- The current tail-latency prototype must be refactored into span-derived projections rather than extended as a parallel telemetry model.
