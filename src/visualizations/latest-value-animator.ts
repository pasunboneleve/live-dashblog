export interface AnimationFrameClock {
  cancel(handle: number): void;
  now(): number;
  request(callback: (now: number) => void): number;
}

interface LatestValueAnimatorOptions<Value> {
  clock: AnimationFrameClock;
  durationMs: number;
  interpolate(from: Value, to: Value, progress: number): Value;
  render(value: Value): void;
}

/** Owns one animation frame while coalescing every in-flight update into the latest target. */
export class LatestValueAnimator<Value> {
  private displayed: Value | null = null;
  private frameHandle: number | null = null;
  private from: Value | null = null;
  private startedAt = 0;
  private target: Value | null = null;

  constructor(private readonly options: LatestValueAnimatorOptions<Value>) {
    if (options.durationMs <= 0) throw new RangeError("Animation duration must be positive.");
  }

  setTarget(target: Value, animate: boolean): void {
    this.target = target;
    if (!animate || this.displayed === null) {
      this.snapToTarget();
      return;
    }

    this.from = this.displayed;
    this.startedAt = this.options.clock.now();
    this.scheduleFrame();
  }

  pause(): void {
    this.cancelFrame();
    this.from = null;
  }

  dispose(): void {
    this.pause();
    this.displayed = null;
    this.target = null;
  }

  private snapToTarget(): void {
    this.cancelFrame();
    this.from = null;
    if (this.target === null) return;
    this.displayed = this.target;
    this.options.render(this.displayed);
  }

  private scheduleFrame(): void {
    if (this.frameHandle !== null) return;
    this.frameHandle = this.options.clock.request((now) => this.renderFrame(now));
  }

  private renderFrame(now: number): void {
    this.frameHandle = null;
    if (this.from === null || this.target === null) return;

    const elapsed = Math.max(0, now - this.startedAt);
    const progress = Math.min(1, elapsed / this.options.durationMs);
    this.displayed = this.options.interpolate(this.from, this.target, smoothStep(progress));
    this.options.render(this.displayed);

    if (progress < 1) this.scheduleFrame();
    else this.from = null;
  }

  private cancelFrame(): void {
    if (this.frameHandle === null) return;
    this.options.clock.cancel(this.frameHandle);
    this.frameHandle = null;
  }
}

function smoothStep(progress: number): number {
  return progress * progress * (3 - 2 * progress);
}
