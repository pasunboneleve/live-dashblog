import { tailLatencyProjectionSchema, type TailLatencyProjection } from "../domain/tail-latency";
import { subscribeToTailLatency } from "./page-stream";

/** Binds one custom article visualization to persistent, server-rendered SVG nodes. */
export function mountTailLatency(root: HTMLElement): void {
  const fallback = tailLatencyProjectionSchema.parse(JSON.parse(root.dataset.projection ?? "null"));
  const bars = new Map([...root.querySelectorAll<SVGRectElement>("[data-bucket]")].map((bar) => [bar.dataset.bucket ?? "", bar]));
  const p95 = root.querySelector<HTMLElement>("[data-p95]");
  const count = root.querySelector<HTMLElement>("[data-count]");
  const state = root.querySelector<HTMLElement>("[data-state]");
  render(fallback);
  const subscription = subscribeToTailLatency(render);
  const observer = new IntersectionObserver(([entry]) => subscription.setActive(entry?.isIntersecting ?? false), { rootMargin: "200px" });
  observer.observe(root);

  function render(projection: TailLatencyProjection): void {
    const tallest = Math.max(1, ...projection.histogram.map((bucket) => bucket.count));
    for (const bucket of projection.histogram) {
      const bar = bars.get(bucket.key);
      if (!bar) continue;
      const height = 148 * (bucket.count / tallest);
      bar.setAttribute("y", String(160 - height));
      bar.setAttribute("height", String(height));
      bar.setAttribute("aria-label", `${bucket.label}: ${bucket.count} requests`);
    }
    if (p95) p95.textContent = `${formatMilliseconds(projection.p95Ms)} ms`;
    if (count) count.textContent = String(projection.sampleCount);
    if (state) state.textContent = projection.sequence === 0 ? "static snapshot" : `live · sequence ${projection.sequence}`;
  }
}

function formatMilliseconds(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString();
}
