import { describe, expect, it } from "vitest";
import { createTraceContext, formatTraceparent, parseTraceparent } from "./trace-context";

const VALID_TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01";

describe("W3C trace context", () => {
  it("continues a valid browser parent with a new local span", () => {
    const context = createTraceContext(VALID_TRACEPARENT, fillWith(0x33));

    expect(context).toEqual({
      parentSpanId: "2222222222222222",
      spanId: "3333333333333333",
      traceFlags: "01",
      traceId: "11111111111111111111111111111111",
    });
    expect(formatTraceparent(context))
      .toBe("00-11111111111111111111111111111111-3333333333333333-01");
  });

  it.each([
    null,
    "",
    "00-11111111111111111111111111111111-2222222222222222",
    "00-00000000000000000000000000000000-2222222222222222-01",
    "00-11111111111111111111111111111111-0000000000000000-01",
    "00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-2222222222222222-01",
    "01-11111111111111111111111111111111-2222222222222222-01",
  ])("rejects unsupported or invalid traceparent %s", (value) => {
    expect(parseTraceparent(value)).toBeNull();
  });

  it("starts a new sampled trace when no valid remote parent exists", () => {
    const values = [0x44, 0x55];
    const context = createTraceContext(null, (target) => target.fill(values.shift()!));

    expect(context).toEqual({
      parentSpanId: null,
      spanId: "4444444444444444",
      traceFlags: "01",
      traceId: "55555555555555555555555555555555",
    });
  });

  it("never emits an all-zero identity", () => {
    const values = [0x00, 0x66, 0x00, 0x77];
    const context = createTraceContext(null, (target) => target.fill(values.shift()!));

    expect(context.spanId).toBe("6666666666666666");
    expect(context.traceId).toBe("77777777777777777777777777777777");
  });
});

function fillWith(value: number) {
  return (target: Uint8Array): Uint8Array => target.fill(value);
}
