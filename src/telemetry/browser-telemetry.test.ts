import { describe, expect, it } from "vitest";
import {
  MAX_PARENTED_STREAM_CONNECTIONS,
  shouldParentStreamConnection,
} from "./browser-telemetry";

describe("browser telemetry budgets", () => {
  it("leaves room for four interactions and two complete stream attempts", () => {
    const baseSpans = 1 + 2 + 3;
    const interactionSpans = 4;
    const streamAttemptSpans = 3;

    expect(baseSpans + interactionSpans + MAX_PARENTED_STREAM_CONNECTIONS * streamAttemptSpans)
      .toBeLessThanOrEqual(16);
  });

  it("moves later reconnects into separately rooted server traces", () => {
    expect([1, 2, 3, 4].map(shouldParentStreamConnection)).toEqual([true, true, false, false]);
  });
});
