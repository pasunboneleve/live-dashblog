import { describe, expect, it } from "vitest";
import { shouldRecordPublicRuntimeSpan } from "./public-runtime-span-policy";

describe("public runtime span policy", () => {
  it("suppresses budget-generated rejection spans", () => {
    expect(shouldRecordPublicRuntimeSpan(429)).toBe(false);
    expect(shouldRecordPublicRuntimeSpan(200)).toBe(true);
    expect(shouldRecordPublicRuntimeSpan(101)).toBe(true);
    expect(shouldRecordPublicRuntimeSpan(500)).toBe(true);
  });
});
