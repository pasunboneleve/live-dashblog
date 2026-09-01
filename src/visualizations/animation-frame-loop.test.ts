import { describe, expect, it } from "vitest";
import {
  AnimationFrameLoop,
  type AnimationFrameClock,
} from "./animation-frame-loop";

class FakeFrameClock implements AnimationFrameClock {
  cancelled: number[] = [];
  pending = new Map<number, (now: number) => void>();
  requested = 0;

  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.pending.delete(handle);
  }

  request(callback: (now: number) => void): number {
    const handle = ++this.requested;
    this.pending.set(handle, callback);
    return handle;
  }

  advanceTo(now: number): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback(now);
  }
}

describe("animation frame loop", () => {
  it("keeps one frame pending while rendering continuously", () => {
    const clock = new FakeFrameClock();
    const rendered: number[] = [];
    const loop = new AnimationFrameLoop({ clock, render: (now) => rendered.push(now) });

    loop.start();
    loop.start();
    expect(clock.pending.size).toBe(1);

    clock.advanceTo(16);
    expect(rendered).toEqual([16]);
    expect(clock.pending.size).toBe(1);

    clock.advanceTo(32);
    expect(rendered).toEqual([16, 32]);
    expect(clock.pending.size).toBe(1);
  });

  it("cancels the pending frame when paused", () => {
    const clock = new FakeFrameClock();
    const loop = new AnimationFrameLoop({ clock, render: () => undefined });

    loop.start();
    loop.pause();

    expect(clock.cancelled).toEqual([1]);
    expect(clock.pending.size).toBe(0);
  });
});
