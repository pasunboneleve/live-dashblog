import { nextPresentationExpiry } from "../domain/public-stream";
import {
  TAIL_LATENCY_STREAM,
  tailLatencyProjectionSchema,
} from "../domain/tail-latency";
import { subscribeToTailLatency } from "./page-stream";
import {
  createTailLatencyGeometry,
  projectionPresentationTime,
  type TailLatencyGeometry,
} from "./tail-latency-geometry";
import {
  AnimationFrameLoop,
  type AnimationFrameClock,
} from "./animation-frame-loop";
import { recordTelemetryHydrationComplete } from "../telemetry/browser-telemetry-hooks";

const browserFrameClock: AnimationFrameClock = {
  cancel: (handle) => cancelAnimationFrame(handle),
  request: (callback) => requestAnimationFrame(callback),
};

/** Binds one custom article visualization to persistent paths and one latest-point marker. */
export function mountTailLatency(root: HTMLElement): void {
  let current = tailLatencyProjectionSchema.parse(JSON.parse(root.dataset.projection ?? "null"));
  let expiryTimer: number | null = null;
  let active = true;
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const area = root.querySelector<SVGPathElement>("[data-area]");
  const line = root.querySelector<SVGPathElement>("[data-line]");
  const latestPoint = root.querySelector<SVGCircleElement>("[data-latest-point]");
  const latestValue = root.querySelector<HTMLElement>("[data-latest]");
  const p95 = root.querySelector<HTMLElement>("[data-p95]");
  const count = root.querySelector<HTMLElement>("[data-count]");
  const state = root.querySelector<HTMLElement>("[data-state]");
  const description = root.querySelector<SVGDescElement>("[data-chart-description]");
  const yMaximum = root.querySelector<SVGTextElement>("[data-y-maximum]");
  const frameLoop = new AnimationFrameLoop({
    clock: browserFrameClock,
    render: () => {
      const geometry = presentCurrent();
      if (!geometry || geometry.points.length === 0) frameLoop.pause();
    },
  });
  const subscription = subscribeToTailLatency((projection) => {
    current = projection;
    refreshPresentation();
  });
  const observer = new IntersectionObserver(([entry]) => {
    active = entry?.isIntersecting ?? false;
    subscription.setActive(active);
    if (active) refreshPresentation();
    else {
      frameLoop.pause();
      clearExpiryTimer();
    }
  }, { rootMargin: "200px" });
  const handleMotionPreference = () => {
    if (active) refreshPresentation();
  };
  const handlePageHide = (event: PageTransitionEvent) => {
    frameLoop.pause();
    clearExpiryTimer();
    subscription.setActive(false);
    if (!event.persisted) dispose();
  };
  const handlePageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    subscription.setActive(active);
    if (active) refreshPresentation();
  };
  const dispose = () => {
    active = false;
    clearExpiryTimer();
    frameLoop.dispose();
    observer.disconnect();
    subscription.unsubscribe();
    motionPreference.removeEventListener("change", handleMotionPreference);
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("pageshow", handlePageShow);
  };
  motionPreference.addEventListener("change", handleMotionPreference);
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", handlePageShow);
  observer.observe(root);
  refreshPresentation();
  recordTelemetryHydrationComplete();

  function refreshPresentation(): void {
    const geometry = presentCurrent();
    if (!geometry) return;
    frameLoop.pause();
    if (!motionPreference.matches && current.sequence > 0 && geometry.points.length > 0) {
      clearExpiryTimer();
      frameLoop.start();
    } else {
      scheduleExpiry(geometry);
    }
  }

  function presentCurrent(): TailLatencyGeometry | null {
    if (!active) return null;
    const now = projectionPresentationTime(current, Date.now());
    const geometry = createTailLatencyGeometry(current.points, now);
    updateProjectionText(geometry);
    renderGeometry(geometry);
    return geometry;
  }

  function renderGeometry(geometry: TailLatencyGeometry): void {
    if (!active) return;
    area?.setAttribute("d", geometry.areaPath);
    line?.setAttribute("d", geometry.linePath);
    updateLatestPoint(latestPoint, geometry.latest);
    if (yMaximum) yMaximum.textContent = formatMilliseconds(geometry.yMaximumMs);
  }

  function updateProjectionText(geometry: TailLatencyGeometry): void {
    if (latestValue) latestValue.textContent = geometry.latest ? formatMilliseconds(geometry.latest.durationMs) : "—";
    if (p95) p95.textContent = formatMilliseconds(geometry.p95Ms);
    if (count) count.textContent = String(geometry.points.length);
    if (state) state.textContent = current.sequence === 0 ? "static snapshot" : "live";
    if (description) {
      description.textContent = geometry.latest
        ? `The latest request took ${formatMilliseconds(geometry.latest.durationMs)} milliseconds. It is the amber point at the right of ${Math.max(0, geometry.points.length - 1)} preceding requests in the last 60 seconds.`
        : "No request timings remain in the current 60-second presentation window.";
    }
  }

  function scheduleExpiry(geometry: TailLatencyGeometry): void {
    clearExpiryTimer();
    const now = projectionPresentationTime(current, Date.now());
    const expiresAt = current.sequence === 0
      ? null
      : nextPresentationExpiry(TAIL_LATENCY_STREAM, geometry.points, now);
    if (expiresAt !== null) {
      expiryTimer = window.setTimeout(refreshPresentation, Math.max(0, expiresAt - Date.now()));
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
