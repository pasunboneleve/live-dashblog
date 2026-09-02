export interface AnimationFrameClock {
  cancel(handle: number): void;
  request(callback: (now: number) => void): number;
}

interface AnimationFrameLoopOptions {
  clock: AnimationFrameClock;
  render(now: number): void;
}

/** Owns exactly one animation frame while a continuously changing view is active. */
export class AnimationFrameLoop {
  private frameHandle: number | null = null;
  private running = false;

  constructor(private readonly options: AnimationFrameLoopOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleFrame();
  }

  pause(): void {
    this.running = false;
    if (this.frameHandle === null) return;
    this.options.clock.cancel(this.frameHandle);
    this.frameHandle = null;
  }

  dispose(): void {
    this.pause();
  }

  private scheduleFrame(): void {
    if (!this.running || this.frameHandle !== null) return;
    this.frameHandle = this.options.clock.request((now) => {
      this.frameHandle = null;
      if (!this.running) return;
      this.options.render(now);
      this.scheduleFrame();
    });
  }
}
