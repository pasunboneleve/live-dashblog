import { publicObservabilityProjectionSchema } from "../domain/public-observability";
import { recordTelemetryHydrationComplete, recordTelemetryInteraction } from "../telemetry/browser-telemetry-hooks";
import { createTimeSeriesGeometry, createWaterfallGeometry } from "./observability-geometry";
import { describeTraceSelection } from "./observability-selection";
import { subscribeToObservability } from "./observability-stream";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Updates one bounded time series and keeps one explicitly selected trace visible below it. */
export function mountObservability(root: HTMLElement): void {
  let current = publicObservabilityProjectionSchema.parse(JSON.parse(root.dataset.projection ?? "null"));
  const embeddedTrace = current.traceSamples[0] ?? null;
  let selectedBucketStart = newestInspectableBucketStart();
  let selectedTraceId = interestingTraceIdForBucket(selectedBucketStart) ?? embeddedTrace?.traceId ?? null;
  let selectedTrace = current.traceSamples.find((trace) => trace.traceId === selectedTraceId) ?? embeddedTrace;
  let visible = true;
  const timeBucketContainer = root.querySelector<SVGGElement>("[data-time-buckets]");
  timeBucketContainer?.addEventListener("click", handleBucketClick);
  timeBucketContainer?.addEventListener("keydown", handleBucketKeydown);
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    subscription.setActive(visible);
  }, { rootMargin: "300px" });
  const subscription = subscribeToObservability((projection) => {
    current = projection;
    if (!current.timeSeries.buckets.some((bucket) => bucket.startUnixMs === selectedBucketStart)) {
      selectedBucketStart = newestInspectableBucketStart();
    }
    const selectedBucketTraceIds = new Set(selectedBucket()?.sampleTraceIds ?? []);
    const retainedSelection = current.traceSamples.find((trace) => trace.traceId === selectedTraceId) ?? null;
    if (selectedBucketTraceIds.size === 0) {
      selectedTrace = retainedSelection ?? selectedTrace;
    } else if (retainedSelection && selectedBucketTraceIds.has(retainedSelection.traceId)) {
      selectedTrace = retainedSelection;
    } else {
      selectedTrace = interestingTraceForBucket(selectedBucketStart)
        ?? current.traceSamples[0]
        ?? selectedTrace
        ?? embeddedTrace;
      selectedTraceId = selectedTrace?.traceId ?? null;
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
    timeBucketContainer?.removeEventListener("click", handleBucketClick);
    timeBucketContainer?.removeEventListener("keydown", handleBucketKeydown);
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
    setText("[data-error-rate]", formatPercent(current.aggregates.overall.errorRate));
    setText("[data-p50]", formatDuration(current.aggregates.overall.p50Ms));
    setText("[data-p95]", formatDuration(current.aggregates.overall.p95Ms));
    setText("[data-max]", formatDuration(current.aggregates.overall.maxMs));
    setText("[data-sequence]", current.sequence === 0 ? "embedded example" : "live");
    const bounded = current.sampling.droppedTraceCount > 0;
    setText(
      "[data-sampling]",
      `${bounded ? "≤" : ""}${formatPercent(current.sampling.sampleRate)} admitted · ${bounded ? "≥" : ""}${current.sampling.droppedTraceCount} dropped`,
    );
    renderTimeSeries();
    renderRuntimeGroups();
    renderDurationBands();
    renderTraceChoices();
    renderWaterfall();
  }

  function renderTimeSeries(): void {
    const svg = root.querySelector<SVGSVGElement>("[data-time-series]");
    const container = svg?.querySelector<SVGGElement>("[data-time-buckets]");
    const line = svg?.querySelector<SVGPathElement>("[data-latency-line]");
    const description = svg?.querySelector<SVGDescElement>("[data-time-series-description]");
    if (!svg || !container || !line) return;
    const geometry = createTimeSeriesGeometry(current.timeSeries.buckets);
    svg.setAttribute("viewBox", geometry.viewBox);
    line.setAttribute("d", geometry.linePath);
    setText("[data-time-series-max]", formatDuration(geometry.maximumRequestMs));
    if (description) description.textContent = "Bars count traces per 10-second interval. The line plots p95 root-request duration on a logarithmic scale.";
    const existing = new Map(
      [...container.querySelectorAll<SVGGElement>("g[data-bucket-start]")]
        .map((group) => [Number(group.dataset.bucketStart), group]),
    );
    geometry.buckets.forEach((geometryBucket, index) => {
      const bucket = current.timeSeries.buckets[index]!;
      let group = existing.get(bucket.startUnixMs);
      if (!group) {
        group = document.createElementNS(SVG_NS, "g");
        group.dataset.bucketStart = String(bucket.startUnixMs);
        group.setAttribute("role", "button");
        group.setAttribute("tabindex", "0");
        group.appendChild(createSvgElement("rect", "bucket-hit"));
        group.appendChild(createSvgElement("rect", "trace-bar"));
        group.appendChild(createSvgElement("circle", "latency-point"));
        container.appendChild(group);
      }
      const hit = group.querySelector<SVGRectElement>(".bucket-hit")
        ?? group.appendChild(createSvgElement("rect", "bucket-hit"));
      const bar = group.querySelector<SVGRectElement>(".trace-bar")
        ?? group.appendChild(createSvgElement("rect", "trace-bar"));
      const point = group.querySelector<SVGCircleElement>(".latency-point")
        ?? group.appendChild(createSvgElement("circle", "latency-point"));
      setAttributes(hit, { x: geometryBucket.x, y: 18, width: geometryBucket.width, height: 150 });
      setAttributes(bar, { x: geometryBucket.x, y: 168 - geometryBucket.barHeight, width: geometryBucket.width, height: geometryBucket.barHeight });
      point.setAttribute("display", geometryBucket.pointY === null ? "none" : "inline");
      if (geometryBucket.pointY !== null) setAttributes(point, { cx: geometryBucket.x + geometryBucket.width / 2, cy: geometryBucket.pointY, r: 3.5 });
      group.setAttribute("class", `time-bucket${bucket.startUnixMs === selectedBucketStart ? " selected" : ""}`);
      group.setAttribute("aria-pressed", String(bucket.startUnixMs === selectedBucketStart));
      group.setAttribute("aria-label", bucketAriaLabel(bucket));
      existing.delete(bucket.startUnixMs);
    });
    for (const group of existing.values()) group.remove();
    renderBucketSummary();
  }

  function renderBucketSummary(): void {
    const bucket = selectedBucket();
    if (!bucket) return;
    const range = `${formatClock(bucket.startUnixMs)}–${formatClock(bucket.endUnixMs)}`;
    if (bucket.traceCount === 0) {
      setText("[data-bucket-summary]", `${range} · no traces. The previously selected trace remains visible below.`);
      return;
    }
    const retained = bucket.sampleTraceIds.length;
    const detail = retained === 0
      ? "no retained detail; the previous trace remains below"
      : `${retained} retained ${plural(retained, "detail")}`;
    setText(
      "[data-bucket-summary]",
      `${range} · ${bucket.traceCount} ${plural(bucket.traceCount, "trace")} · ${formatDuration(bucket.requestP95Ms)} request p95 · ${bucket.errorCount} ${plural(bucket.errorCount, "error")} · ${detail}`,
    );
  }

  function renderRuntimeGroups(): void {
    for (const group of current.aggregates.byRuntimeSide) {
      const row = root.querySelector<HTMLElement>(`[data-runtime="${group.key}"]`);
      const meter = row?.querySelector<HTMLMeterElement>("meter");
      const count = row?.querySelector<HTMLElement>("[data-runtime-count]");
      if (meter) {
        meter.max = Math.max(1, current.spanCount);
        meter.value = group.count;
        meter.textContent = String(group.count);
      }
      if (count) count.textContent = `${group.count} of ${current.spanCount} spans · ${formatPercent(group.errorRate)} errors`;
    }
  }

  function renderDurationBands(): void {
    const maximum = Math.max(1, ...current.durationBands.map((bucket) => bucket.count));
    current.durationBands.forEach((bucket, index) => {
      const cell = root.querySelector<HTMLElement>(`[data-heat-index="${index}"]`);
      const count = cell?.querySelector("strong");
      if (!cell || !count) return;
      cell.className = `heat-cell heat-${Math.ceil(bucket.count / maximum * 5)}`;
      count.textContent = String(bucket.count);
      cell.title = `${bucket.count} spans from ${formatDuration(bucket.lowerBoundMs)} to ${formatDuration(bucket.upperBoundMs)}`;
    });
  }

  function renderTraceChoices(): void {
    const container = root.querySelector<HTMLElement>("[data-trace-choices]");
    if (!container) return;
    const traceIds = new Set(selectedBucket()?.sampleTraceIds ?? []);
    const traces = current.traceSamples.filter((trace) => traceIds.has(trace.traceId));
    const existing = new Map(
      [...container.querySelectorAll<HTMLButtonElement>("button[data-trace-id]")]
        .map((button) => [button.dataset.traceId!, button]),
    );
    for (const trace of traces) {
      let button = existing.get(trace.traceId);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.traceId = trace.traceId;
        button.addEventListener("click", () => {
          selectedTraceId = trace.traceId;
          selectedTrace = trace;
          recordTelemetryInteraction("focus-trace");
          renderTraceChoices();
          renderWaterfall();
        });
      }
      button.textContent = `${formatDuration(trace.requestDurationMs)} request · ${trace.spans.length} spans${trace.error ? " · error" : ""}`;
      button.setAttribute("aria-pressed", String(trace.traceId === selectedTraceId));
      container.appendChild(button);
      existing.delete(trace.traceId);
    }
    for (const button of existing.values()) button.remove();
  }

  function renderWaterfall(): void {
    const trace = selectedTrace ?? embeddedTrace;
    const geometry = createWaterfallGeometry(trace);
    const svg = root.querySelector<SVGSVGElement>("[data-waterfall]");
    const rows = svg?.querySelector<SVGGElement>("[data-waterfall-rows]");
    const description = svg?.querySelector<SVGDescElement>("[data-waterfall-description]");
    if (!svg || !rows || !trace) return;
    svg.setAttribute("viewBox", geometry.viewBox);
    const source = describeTraceSelection({
      projectionIsEmbedded: current.sequence === 0,
      selectedBucket: selectedBucket(),
      selectedTraceId: trace.traceId,
      traceIsEmbeddedFallback: trace === embeddedTrace
        && !current.traceSamples.some((candidate) => candidate.traceId === trace.traceId),
    });
    setText("[data-selected-trace-summary]", `${source} · ${formatDuration(trace.requestDurationMs)} request · ${formatDuration(geometry.initialActivityMs)} initial activity · ${formatDuration(trace.observedWindowMs)} observed · ${trace.spans.length} joined spans`);
    if (description) description.textContent = `${geometry.spans.length} spans scaled across ${formatDuration(geometry.initialActivityMs)} of contiguous initial activity. Activity after a one-second gap is listed below and does not change the chart scale.`;
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
        const duration = document.createElementNS(SVG_NS, "text");
        duration.setAttribute("class", "duration-label");
        duration.setAttribute("text-anchor", "end");
        group.appendChild(duration);
        rows.appendChild(group);
      }
      const [label, bar, duration] = [...group.children] as [SVGTextElement, SVGRectElement, SVGTextElement];
      label.textContent = span.label;
      setAttributes(label, { x: 0, y: span.y + 12 });
      bar.setAttribute("class", `span-bar ${span.runtimeSide}`);
      setAttributes(bar, { x: span.x, y: span.y, width: span.barWidth, height: 16 });
      duration.textContent = span.durationLabel;
      setAttributes(duration, { x: 712, y: span.y + 12 });
      existing.delete(span.spanId);
    }
    for (const group of existing.values()) group.remove();
    renderLaterActivity(geometry.laterSpans);
  }

  function renderLaterActivity(laterSpans: ReturnType<typeof createWaterfallGeometry>["laterSpans"]): void {
    const section = root.querySelector<HTMLElement>("[data-later-activity]");
    const list = section?.querySelector<HTMLOListElement>("[data-later-spans]");
    if (!section || !list) return;
    section.hidden = laterSpans.length === 0;
    setText(
      "[data-later-activity-summary]",
      `${laterSpans.length} ${plural(laterSpans.length, "span")} resumed after at least one quiet second. ${laterSpans.length === 1 ? "It remains" : "They remain"} joined to this trace without stretching the initial-activity clock.`,
    );
    const existing = new Map(
      [...list.querySelectorAll<HTMLLIElement>("li[data-later-span-id]")]
        .map((item) => [item.dataset.laterSpanId!, item]),
    );
    for (const span of laterSpans) {
      let item = existing.get(span.spanId);
      if (!item) {
        item = document.createElement("li");
        item.dataset.laterSpanId = span.spanId;
        item.appendChild(document.createElement("span"));
        item.appendChild(document.createElement("strong"));
        item.appendChild(document.createElement("span"));
        item.appendChild(document.createElement("span"));
        list.appendChild(item);
      }
      const [runtime, label, offset, duration] = [...item.children] as [HTMLSpanElement, HTMLElement, HTMLSpanElement, HTMLSpanElement];
      runtime.className = `activity-runtime ${span.runtimeSide}`;
      runtime.setAttribute("aria-hidden", "true");
      label.textContent = span.label;
      offset.textContent = `${span.offsetLabel} from request`;
      duration.textContent = span.durationLabel;
      existing.delete(span.spanId);
    }
    for (const item of existing.values()) item.remove();
  }

  function selectBucket(startUnixMs: number): void {
    selectedBucketStart = startUnixMs;
    const nextTrace = interestingTraceForBucket(startUnixMs);
    if (nextTrace) {
      selectedTrace = nextTrace;
      selectedTraceId = nextTrace.traceId;
    }
    recordTelemetryInteraction("change-time-range");
    renderTimeSeries();
    renderTraceChoices();
    renderWaterfall();
  }

  function handleBucketClick(event: Event): void {
    const group = (event.target as Element).closest<SVGGElement>("g[data-bucket-start]");
    if (group?.dataset.bucketStart) selectBucket(Number(group.dataset.bucketStart));
  }

  function handleBucketKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    const group = (event.target as Element).closest<SVGGElement>("g[data-bucket-start]");
    if (!group?.dataset.bucketStart) return;
    event.preventDefault();
    selectBucket(Number(group.dataset.bucketStart));
  }

  function selectedBucket() {
    return current.timeSeries.buckets.find((bucket) => bucket.startUnixMs === selectedBucketStart) ?? null;
  }

  function newestInspectableBucketStart(): number {
    return [...current.timeSeries.buckets].reverse().find((bucket) => bucket.sampleTraceIds.length > 0)?.startUnixMs
      ?? current.timeSeries.buckets.at(-1)?.startUnixMs
      ?? 0;
  }

  function interestingTraceIdForBucket(startUnixMs: number): string | null {
    return interestingTraceForBucket(startUnixMs)?.traceId ?? null;
  }

  function interestingTraceForBucket(startUnixMs: number) {
    const ids = new Set(current.timeSeries.buckets.find((bucket) => bucket.startUnixMs === startUnixMs)?.sampleTraceIds ?? []);
    return current.traceSamples.find((trace) => ids.has(trace.traceId)) ?? null;
  }

  function setText(selector: string, value: number | string): void {
    const node = root.querySelector<HTMLElement | SVGElement>(selector);
    if (node) node.textContent = String(value);
  }
}

function createSvgElement(name: "circle" | "rect", className: string) {
  const element = document.createElementNS(SVG_NS, name);
  element.setAttribute("class", className);
  return element;
}

function setAttributes(element: Element, attributes: Record<string, number>): void {
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value.toFixed(2));
}

function bucketAriaLabel(bucket: { endUnixMs: number; errorCount: number; requestP95Ms: number; startUnixMs: number; traceCount: number }): string {
  return `${formatClock(bucket.startUnixMs)} to ${formatClock(bucket.endUnixMs)}: ${bucket.traceCount} ${plural(bucket.traceCount, "trace")}, ${formatDuration(bucket.requestP95Ms)} request p95, ${bucket.errorCount} ${plural(bucket.errorCount, "error")}. Select interval.`;
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
}

function formatDuration(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} s`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
