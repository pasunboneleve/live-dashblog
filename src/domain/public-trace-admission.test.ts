import { describe, expect, it } from "vitest";
import { admissionMatchesBatch, publicTraceAdmissionSchema } from "./public-trace-admission";
import type { PublicSpan } from "./public-span";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const browserSpan = {
  attributes: { routeClass: "article" },
  durationMs: 8,
  kind: "INTERNAL",
  name: "browser.document-load",
  parentSpanId: "b7ad6b7169203331",
  runtimeSide: "browser",
  serviceName: "live-dashblog-browser",
  spanId: "00f067aa0ba902b7",
  startedAtUnixMs: 1_800_000_000_000,
  status: "ok",
  traceId,
  version: 1,
} satisfies PublicSpan;
const workerSpan = {
  attributes: { cacheClass: "unknown", routeClass: "article", statusClass: "2xx" },
  durationMs: 10,
  kind: "SERVER",
  name: "worker.article-request",
  parentSpanId: null,
  runtimeSide: "worker",
  serviceName: "live-dashblog-worker",
  spanId: "b7ad6b7169203331",
  startedAtUnixMs: 1_800_000_000_000,
  status: "ok",
  traceId,
  version: 1,
} satisfies PublicSpan;

describe("public trace admission", () => {
  it("accepts only a bounded opaque token and non-zero trace ID", () => {
    expect(publicTraceAdmissionSchema.safeParse({
      token: "a".repeat(32),
      traceId,
    }).success).toBe(true);
    expect(publicTraceAdmissionSchema.safeParse({ token: "public", traceId }).success).toBe(false);
  });

  it("binds every browser span in a batch to the admitted trace", () => {
    expect(admissionMatchesBatch(traceId, [browserSpan])).toBe(true);
    expect(admissionMatchesBatch("1".repeat(32), [browserSpan])).toBe(false);
    expect(admissionMatchesBatch(traceId, [workerSpan])).toBe(false);
    expect(admissionMatchesBatch(traceId, [])).toBe(false);
  });
});
