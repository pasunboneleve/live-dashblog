import { describe, expect, it } from "vitest";
import {
  LatestValueAnimator,
  type AnimationFrameClock,
} from "./latest-value-animator";

class FakeFrameClock implements AnimationFrameClock {
  cancelled: number[] = [];
  currentTime = 0;
  pending = new Map<number, (now: number) => void>();
  requested = 0;

  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.pending.delete(handle);
  }

  now(): number {
    return this.currentTime;
  }

  request(callback: (now: number) => void): number {
    const handle = ++this.requested;
    this.pending.set(handle, callback);
    return handle;
  }

  advanceTo(now: number): void {
    this.currentTime = now;
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback(now);
  }
}

describe("latest value animator", () => {
  it("coalesces an in-flight update into one frame and the newest target", () => {
    const clock = new FakeFrameClock();
    const rendered: number[] = [];
    const animator = new LatestValueAnimator({
      clock,
      durationMs: 100,
      interpolate: (from: number, to: number, progress: number) => from + (to - from) * progress,
      render: (value) => rendered.push(value),
    });

    animator.setTarget(0, false);
    animator.setTarget(10, true);
    animator.setTarget(20, true);
    expect(clock.pending.size).toBe(1);
    expect(clock.requested).toBe(1);

    clock.advanceTo(50);
    expect(rendered.at(-1)).toBe(10);
    expect(clock.pending.size).toBe(1);

    clock.advanceTo(100);
    expect(rendered.at(-1)).toBe(20);
    expect(clock.pending.size).toBe(0);
  });

  it("cancels work while paused and snaps without a frame for reduced motion", () => {
    const clock = new FakeFrameClock();
    const rendered: number[] = [];
    const animator = new LatestValueAnimator({
      clock,
      durationMs: 100,
      interpolate: (from: number, to: number, progress: number) => from + (to - from) * progress,
      render: (value) => rendered.push(value),
    });

    animator.setTarget(0, false);
    animator.setTarget(10, true);
    animator.pause();
    expect(clock.cancelled).toEqual([1]);
    expect(clock.pending.size).toBe(0);

    animator.setTarget(20, false);
    expect(rendered.at(-1)).toBe(20);
    expect(clock.requested).toBe(1);
  });
});
