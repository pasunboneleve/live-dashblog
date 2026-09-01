import { describe, expect, it } from "vitest";
import { describeTraceSelection } from "./observability-selection";

describe("observability trace selection labels", () => {
  it("distinguishes selected, empty, and unretained populated intervals", () => {
    const common = {
      projectionIsEmbedded: false,
      selectedTraceId: "trace-a",
      traceIsEmbeddedFallback: false,
    };

    expect(describeTraceSelection({
      ...common,
      selectedBucket: { sampleTraceIds: ["trace-a"], traceCount: 2 },
    })).toBe("selected interval");
    expect(describeTraceSelection({
      ...common,
      selectedBucket: { sampleTraceIds: [], traceCount: 0 },
    })).toBe("previous selection · selected interval is empty");
    expect(describeTraceSelection({
      ...common,
      selectedBucket: { sampleTraceIds: [], traceCount: 3 },
    })).toBe("previous selection · no retained detail for selected interval");
  });
});
