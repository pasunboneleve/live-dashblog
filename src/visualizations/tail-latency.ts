import { nextPresentationExpiry } from "../domain/public-stream";
import {
  TAIL_LATENCY_STREAM,
  tailLatencyProjectionSchema,
} from "../domain/tail-latency";
import { subscribeToTailLatency } from "./page-stream";
import {
  createTailLatencyGeometry,
  projectionPresentationTime,
} from "./tail-latency-geometry";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Binds one custom article visualization to persistent, keyed SVG nodes. */
export function mountTailLatency(root: HTMLElement): void {
  let current = tailLatencyProjectionSchema.parse(JSON.parse(root.dataset.projection ?? "null"));
  let expiryTimer: number | null = null;
  let active = true;
  const pointLayer = root.querySelector<SVGGElement>("[data-points]");
  const pointNodes = new Map(
    [...root.querySelectorAll<SVGCircleElement>("[data-point]")]
      .map((point) => [point.dataset.point ?? "", point]),
  );
  const area = root.querySelector<SVGPathElement>("[data-area]");
  const line = root.querySelector<SVGPathElement>("[data-line]");
  const latestPoint = root.querySelector<SVGCircleElement>("[data-latest-point]");
  const latestHalo = root.querySelector<SVGCircleElement>("[data-latest-halo]");
  const latestValue = root.querySelector<HTMLElement>("[data-latest]");
  const p95 = root.querySelector<HTMLElement>("[data-p95]");
  const count = root.querySelector<HTMLElement>("[data-count]");
  const state = root.querySelector<HTMLElement>("[data-state]");
  const description = root.querySelector<SVGDescElement>("[data-chart-description]");
  const yMaximum = root.querySelector<SVGTextElement>("[data-y-maximum]");
  const subscription = subscribeToTailLatency((projection) => {
    current = projection;
    renderAtBrowserCadence();
  });
  const observer = new IntersectionObserver(([entry]) => {
    active = entry?.isIntersecting ?? false;
    subscription.setActive(active);
    if (active) renderAtBrowserCadence();
    else clearExpiryTimer();
  }, { rootMargin: "200px" });
  observer.observe(root);
  renderAtBrowserCadence();

  function renderAtBrowserCadence(): void {
    requestAnimationFrame(() => render(projectionPresentationTime(current, Date.now())));
  }

  function render(now: number): void {
    if (!active) return;
    const geometry = createTailLatencyGeometry(current.points, now);
    area?.setAttribute("d", geometry.areaPath);
    line?.setAttribute("d", geometry.linePath);

    const visibleKeys = new Set<string>();
    for (const point of geometry.points) {
      visibleKeys.add(point.key);
      let node = pointNodes.get(point.key);
      if (!node && pointLayer) {
        node = document.createElementNS(SVG_NAMESPACE, "circle");
        node.dataset.point = point.key;
        node.setAttribute("r", "2.5");
        pointLayer.appendChild(node);
        pointNodes.set(point.key, node);
      }
      node?.setAttribute("cx", point.x.toFixed(2));
      node?.setAttribute("cy", point.y.toFixed(2));
    }
    for (const [key, node] of pointNodes) {
      if (visibleKeys.has(key)) continue;
      node.remove();
      pointNodes.delete(key);
    }

    updateLatestPoint(latestPoint, geometry.latest);
    updateLatestPoint(latestHalo, geometry.latest);
    if (latestValue) latestValue.textContent = geometry.latest ? formatMilliseconds(geometry.latest.durationMs) : "—";
    if (p95) p95.textContent = formatMilliseconds(geometry.p95Ms);
    if (count) count.textContent = String(geometry.points.length);
    if (yMaximum) yMaximum.textContent = formatMilliseconds(geometry.yMaximumMs);
    if (state) state.textContent = current.sequence === 0 ? "static snapshot" : `live · sequence ${current.sequence}`;
    if (description) {
      description.textContent = geometry.latest
        ? `The latest request took ${formatMilliseconds(geometry.latest.durationMs)} milliseconds. It is the amber point at the right of ${Math.max(0, geometry.points.length - 1)} preceding requests in the last 60 seconds.`
        : "No request timings remain in the current 60-second presentation window.";
    }

    clearExpiryTimer();
    const expiresAt = current.sequence === 0
      ? null
      : nextPresentationExpiry(TAIL_LATENCY_STREAM, geometry.points, now);
    if (expiresAt !== null) {
      expiryTimer = window.setTimeout(renderAtBrowserCadence, Math.max(0, expiresAt - Date.now()));
    }
  }

  function clearExpiryTimer(): void {
    if (expiryTimer === null) return;
    window.clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

function updateLatestPoint(
  node: SVGCircleElement | null,
  point: { x: number; y: number } | null,
): void {
  if (!node) return;
  node.dataset.visible = point === null ? "false" : "true";
  if (!point) return;
  node.setAttribute("cx", point.x.toFixed(2));
  node.setAttribute("cy", point.y.toFixed(2));
}

function formatMilliseconds(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString();
}
