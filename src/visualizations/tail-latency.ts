import { nextPresentationExpiry } from "../domain/public-stream";
import {
  TAIL_LATENCY_STREAM,
  tailLatencyProjectionSchema,
} from "../domain/tail-latency";
import { subscribeToTailLatency } from "./page-stream";
import {
  createTailLatencyGeometry,
  interpolateTailLatencyGeometry,
  projectionPresentationTime,
  type TailLatencyGeometry,
} from "./tail-latency-geometry";
import {
  LatestValueAnimator,
  type AnimationFrameClock,
} from "./latest-value-animator";
import { recordTelemetryHydrationComplete } from "../telemetry/browser-telemetry-hooks";

const ANIMATION_DURATION_MS = 800;
const browserFrameClock: AnimationFrameClock = {
  cancel: (handle) => cancelAnimationFrame(handle),
  now: () => performance.now(),
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
  const animator = new LatestValueAnimator<TailLatencyGeometry>({
    clock: browserFrameClock,
    durationMs: ANIMATION_DURATION_MS,
    interpolate: interpolateTailLatencyGeometry,
    render: renderGeometry,
  });
  const subscription = subscribeToTailLatency((projection) => {
    current = projection;
    presentCurrent(true);
  });
  const observer = new IntersectionObserver(([entry]) => {
    active = entry?.isIntersecting ?? false;
    subscription.setActive(active);
    if (active) presentCurrent(false);
    else {
      animator.pause();
      clearExpiryTimer();
    }
  }, { rootMargin: "200px" });
  const handleMotionPreference = (event: MediaQueryListEvent) => {
    if (event.matches && active) presentCurrent(false);
  };
  const handlePageHide = (event: PageTransitionEvent) => {
    animator.pause();
    clearExpiryTimer();
    subscription.setActive(false);
    if (!event.persisted) dispose();
  };
  const handlePageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    subscription.setActive(active);
    if (active) presentCurrent(false);
  };
  const dispose = () => {
    active = false;
    clearExpiryTimer();
    animator.dispose();
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
  presentCurrent(false);
  recordTelemetryHydrationComplete();

  function presentCurrent(animate: boolean): void {
    if (!active) return;
    const now = projectionPresentationTime(current, Date.now());
    const geometry = createTailLatencyGeometry(current.points, now);
    updateProjectionText(geometry);
    animator.setTarget(geometry, animate && !motionPreference.matches);
    scheduleExpiry(geometry, now);
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
    if (state) state.textContent = current.sequence === 0 ? "static snapshot" : `live · sequence ${current.sequence}`;
    if (description) {
      description.textContent = geometry.latest
        ? `The latest request took ${formatMilliseconds(geometry.latest.durationMs)} milliseconds. It is the amber point at the right of ${Math.max(0, geometry.points.length - 1)} preceding requests in the last 60 seconds.`
        : "No request timings remain in the current 60-second presentation window.";
    }
  }

  function scheduleExpiry(geometry: TailLatencyGeometry, now: number): void {
    clearExpiryTimer();
    const expiresAt = current.sequence === 0
      ? null
      : nextPresentationExpiry(TAIL_LATENCY_STREAM, geometry.points, now);
    if (expiresAt !== null) {
      expiryTimer = window.setTimeout(() => presentCurrent(true), Math.max(0, expiresAt - Date.now()));
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
