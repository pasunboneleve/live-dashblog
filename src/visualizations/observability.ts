import {
  publicObservabilityProjectionSchema,
} from "../domain/public-observability";
import {
  recordTelemetryHydrationComplete,
  recordTelemetryInteraction,
} from "../telemetry/browser-telemetry-hooks";
import { createWaterfallGeometry } from "./observability-geometry";
import { subscribeToObservability } from "./observability-stream";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Updates the recursive article's bounded aggregates and one keyed trace waterfall. */
export function mountObservability(root: HTMLElement): void {
  let current = publicObservabilityProjectionSchema.parse(JSON.parse(root.dataset.projection ?? "null"));
  let selectedTraceId = current.slowTraces[0]?.traceId ?? null;
  let visible = true;
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    subscription.setActive(visible);
  }, { rootMargin: "300px" });
  const subscription = subscribeToObservability((projection) => {
    current = projection;
    if (!current.slowTraces.some((trace) => trace.traceId === selectedTraceId)) {
      selectedTraceId = current.slowTraces[0]?.traceId ?? null;
    }
    render();
  });
  observer.observe(root);
  render();
  recordTelemetryHydrationComplete();

  const handlePageHide = (event: PageTransitionEvent) => {
    subscription.setActive(false);
    if (event.persisted) return;
    observer.disconnect();
    subscription.unsubscribe();
    window.removeEventListener("pageshow", handlePageShow);
  };
  const handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted) subscription.setActive(visible);
  };
  window.addEventListener("pagehide", handlePageHide, { once: true });
  window.addEventListener("pageshow", handlePageShow);

  function render(): void {
    setText("[data-trace-count]", current.traceCount);
    setText("[data-span-count]", current.spanCount);
    setText("[data-error-rate]", `${formatPercent(current.aggregates.overall.errorRate)}`);
    setText("[data-p50]", `${formatMilliseconds(current.aggregates.overall.p50Ms)} ms`);
    setText("[data-p95]", `${formatMilliseconds(current.aggregates.overall.p95Ms)} ms`);
    setText("[data-max]", `${formatMilliseconds(current.aggregates.overall.maxMs)} ms`);
    setText("[data-sequence]", current.sequence === 0 ? "embedded trace" : `live · sequence ${current.sequence}`);
    setText("[data-sampling]", `${formatPercent(current.sampling.sampleRate)} admitted · ${current.sampling.droppedTraceCount} dropped`);
    renderRuntimeGroups();
    renderHeatmap();
    renderTraceChoices();
    renderWaterfall();
  }

  function renderRuntimeGroups(): void {
    const maximum = Math.max(1, ...current.aggregates.byRuntimeSide.map((group) => group.count));
    for (const group of current.aggregates.byRuntimeSide) {
      const row = root.querySelector<HTMLElement>(`[data-runtime="${group.key}"]`);
      const meter = row?.querySelector<HTMLMeterElement>("meter");
      const count = row?.querySelector<HTMLElement>("[data-runtime-count]");
      if (meter) {
        meter.max = maximum;
        meter.value = group.count;
        meter.textContent = String(group.count);
      }
      if (count) count.textContent = `${group.count} spans · ${formatPercent(group.errorRate)} errors`;
    }
  }

  function renderHeatmap(): void {
    const maximum = Math.max(1, ...current.heatmap.map((bucket) => bucket.count));
    current.heatmap.forEach((bucket, index) => {
      const cell = root.querySelector<HTMLElement>(`[data-heat-index="${index}"]`);
      if (!cell) return;
      const intensity = Math.ceil(bucket.count / maximum * 5);
      cell.className = `heat-cell heat-${intensity}`;
      cell.textContent = String(bucket.count);
      cell.title = `${bucket.count} spans from ${bucket.lowerBoundMs} to ${bucket.upperBoundMs} milliseconds`;
    });
  }

  function renderTraceChoices(): void {
    const container = root.querySelector<HTMLElement>("[data-trace-choices]");
    if (!container) return;
    const existing = new Map(
      [...container.querySelectorAll<HTMLButtonElement>("button[data-trace-id]")]
        .map((button) => [button.dataset.traceId!, button]),
    );
    for (const trace of current.slowTraces) {
      let button = existing.get(trace.traceId);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.traceId = trace.traceId;
        button.addEventListener("click", () => {
          selectedTraceId = trace.traceId;
          recordTelemetryInteraction("focus-trace");
          renderTraceChoices();
          renderWaterfall();
        });
      }
      button.textContent = `${formatMilliseconds(trace.durationMs)} ms${trace.error ? " · error" : ""}`;
      button.setAttribute("aria-pressed", String(trace.traceId === selectedTraceId));
      container.appendChild(button);
      existing.delete(trace.traceId);
    }
    for (const button of existing.values()) button.remove();
  }

  function renderWaterfall(): void {
    const trace = current.slowTraces.find((candidate) => candidate.traceId === selectedTraceId) ?? null;
    const geometry = createWaterfallGeometry(trace);
    const svg = root.querySelector<SVGSVGElement>("[data-waterfall]");
    const rows = svg?.querySelector<SVGGElement>("[data-waterfall-rows]");
    const description = svg?.querySelector<SVGDescElement>("[data-waterfall-description]");
    const empty = root.querySelector<HTMLElement>("[data-empty]");
    if (!svg || !rows) return;
    svg.setAttribute("viewBox", geometry.viewBox);
    if (description) description.textContent = trace
      ? `${trace.spans.length} joined spans across ${formatMilliseconds(trace.durationMs)} milliseconds.`
      : "No complete traces remain in the current five-minute window.";
    if (empty) empty.hidden = trace !== null;
    const existing = new Map(
      [...rows.querySelectorAll<SVGGElement>("g[data-span-id]")]
        .map((group) => [group.dataset.spanId!, group]),
    );
    for (const span of geometry.spans) {
      let group = existing.get(span.spanId);
      if (!group) {
        group = document.createElementNS(SVG_NS, "g");
        group.dataset.spanId = span.spanId;
        group.appendChild(document.createElementNS(SVG_NS, "text"));
        group.appendChild(document.createElementNS(SVG_NS, "rect"));
        rows.appendChild(group);
      }
      const label = group.querySelector("text")!;
      const bar = group.querySelector("rect")!;
      label.textContent = span.label;
      label.setAttribute("x", "0");
      label.setAttribute("y", String(span.y + 12));
      bar.setAttribute("class", `span-bar ${span.runtimeSide}`);
      bar.setAttribute("x", span.x.toFixed(2));
      bar.setAttribute("y", String(span.y));
      bar.setAttribute("width", span.barWidth.toFixed(2));
      bar.setAttribute("height", "16");
      existing.delete(span.spanId);
    }
    for (const group of existing.values()) group.remove();
  }

  function setText(selector: string, value: number | string): void {
    const node = root.querySelector<HTMLElement>(selector);
    if (node) node.textContent = String(value);
  }
}

function formatMilliseconds(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString();
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
}
