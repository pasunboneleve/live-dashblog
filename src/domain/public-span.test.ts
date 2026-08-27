import { describe, expect, it } from "vitest";
import { JOINED_PUBLIC_TRACE } from "./fixtures/public-spans";
import {
  PUBLIC_RUNTIME_SIDES,
  PUBLIC_SPAN_KINDS,
  PUBLIC_SPAN_NAMES,
  publicSpanSchema,
  validateCompleteTrace,
} from "./public-span";

const workerRoot = JOINED_PUBLIC_TRACE[0]!;

describe("public span privacy boundary", () => {
  it("accepts the deterministic client-server trace without leaking arbitrary telemetry", () => {
    expect(JOINED_PUBLIC_TRACE.map((span) => publicSpanSchema.safeParse(span).success))
      .toEqual([true, true, true, true, true]);
    expect(new Set(JOINED_PUBLIC_TRACE.map((span) => span.runtimeSide)))
      .toEqual(new Set(["browser", "worker", "durable-object"]));
    expect(PUBLIC_RUNTIME_SIDES).toEqual(["browser", "durable-object", "worker"]);
    expect(PUBLIC_SPAN_KINDS).toEqual(["CLIENT", "INTERNAL", "SERVER"]);
    expect(PUBLIC_SPAN_NAMES).toEqual([
      "browser.document-load",
      "browser.hydration",
      "browser.snapshot-fetch",
      "browser.stream-connect",
      "browser.article-interaction",
      "worker.article-request",
      "worker.snapshot-request",
      "worker.stream-request",
      "durable-object.snapshot",
      "durable-object.stream-connect",
    ]);
    expect(Object.isFrozen(JOINED_PUBLIC_TRACE)).toBe(true);
    expect(JOINED_PUBLIC_TRACE.every((span) => Object.isFrozen(span) && Object.isFrozen(span.attributes)))
      .toBe(true);
  });

  it.each([
    ["URL", { ...workerRoot, url: "https://example.test/private?token=secret" }],
    ["headers", { ...workerRoot, headers: { authorization: "Bearer secret" } }],
    ["user identifier", { ...workerRoot, userId: "customer-42" }],
    ["arbitrary root attribute", { ...workerRoot, arbitrary: "value" }],
    ["arbitrary nested attribute", {
      ...workerRoot,
      attributes: { ...workerRoot.attributes, arbitrary: "value" },
    }],
  ])("rejects a %s", (_label, candidate) => {
    expect(publicSpanSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects unknown operations, malformed trace identities, and mismatched operation metadata", () => {
    expect(publicSpanSchema.safeParse({ ...workerRoot, name: "worker.secret-route" }).success).toBe(false);
    expect(publicSpanSchema.safeParse({ ...workerRoot, traceId: "not-a-trace-id" }).success).toBe(false);
    expect(publicSpanSchema.safeParse({ ...workerRoot, traceId: "0".repeat(32) }).success).toBe(false);
    expect(publicSpanSchema.safeParse({ ...workerRoot, spanId: "0".repeat(16) }).success).toBe(false);
    expect(publicSpanSchema.safeParse({ ...workerRoot, runtimeSide: "browser" }).success).toBe(false);
    expect(publicSpanSchema.safeParse({ ...workerRoot, serviceName: "private-backend" }).success).toBe(false);
    expect(publicSpanSchema.safeParse({ ...workerRoot, kind: "CLIENT" }).success).toBe(false);
    expect(publicSpanSchema.safeParse({ ...workerRoot, parentSpanId: workerRoot.spanId }).success).toBe(false);
    expect(publicSpanSchema.safeParse({ ...workerRoot, durationMs: -1 }).success).toBe(false);
    expect(publicSpanSchema.safeParse({ ...workerRoot, durationMs: 60_001 }).success).toBe(false);
    expect(publicSpanSchema.safeParse({ ...workerRoot, startedAtUnixMs: 1.5 }).success).toBe(false);
    expect(publicSpanSchema.safeParse({
      ...workerRoot,
      attributes: { routeClass: "article", statusClass: "2xx" },
    }).success).toBe(false);
  });
});

describe("complete trace identity rules", () => {
  it("rejects an empty trace", () => {
    expect(validateCompleteTrace([])).toEqual({
      issues: ["A complete trace must contain exactly one traceId."],
      valid: false,
    });
  });

  it("joins the browser client span to a Worker server child and Durable Object descendant", () => {
    expect(validateCompleteTrace(JOINED_PUBLIC_TRACE)).toEqual({ issues: [], valid: true });
    const snapshotClient = JOINED_PUBLIC_TRACE.find((span) => span.name === "browser.snapshot-fetch")!;
    const snapshotServer = JOINED_PUBLIC_TRACE.find((span) => span.name === "worker.snapshot-request")!;
    const snapshotStorage = JOINED_PUBLIC_TRACE.find((span) => span.name === "durable-object.snapshot")!;

    expect(workerRoot.parentSpanId).toBeNull();
    expect(JOINED_PUBLIC_TRACE[1]!.parentSpanId).toBe(workerRoot.spanId);
    expect(snapshotServer.parentSpanId).toBe(snapshotClient.spanId);
    expect(snapshotStorage.parentSpanId).toBe(snapshotServer.spanId);
    expect(snapshotClient.traceId).toBe(snapshotServer.traceId);
    expect(snapshotServer.traceId).toBe(snapshotStorage.traceId);
  });

  it("rejects inverted cross-runtime parentage", () => {
    const documentLoad = JOINED_PUBLIC_TRACE.find((span) => span.name === "browser.document-load")!;
    const snapshotClient = JOINED_PUBLIC_TRACE.find((span) => span.name === "browser.snapshot-fetch")!;
    const snapshotServer = JOINED_PUBLIC_TRACE.find((span) => span.name === "worker.snapshot-request")!;
    const snapshotStorage = JOINED_PUBLIC_TRACE.find((span) => span.name === "durable-object.snapshot")!;

    expect(validateCompleteTrace(JOINED_PUBLIC_TRACE.map((span) =>
      span.spanId === snapshotServer.spanId ? { ...span, parentSpanId: workerRoot.spanId } : span,
    )).issues).toContain(`Server span ${snapshotServer.spanId} must continue a client span.`);

    expect(validateCompleteTrace(JOINED_PUBLIC_TRACE.map((span) =>
      span.spanId === snapshotStorage.spanId ? { ...span, parentSpanId: snapshotClient.spanId } : span,
    )).issues).toContain(
      `Durable Object span ${snapshotStorage.spanId} must be a child of a Worker server span.`,
    );

    expect(validateCompleteTrace(JOINED_PUBLIC_TRACE.map((span) =>
      span.spanId === snapshotClient.spanId ? { ...span, parentSpanId: workerRoot.spanId } : span,
    )).issues).toContain(`Browser client span ${snapshotClient.spanId} must be a child of a browser span.`);

    const storageBelowRoot = { ...snapshotStorage, parentSpanId: workerRoot.spanId };
    const browserBelowStorage = { ...documentLoad, parentSpanId: snapshotStorage.spanId };
    expect(validateCompleteTrace([workerRoot, storageBelowRoot, browserBelowStorage]).issues)
      .toContain(`Durable Object span ${snapshotStorage.spanId} cannot parent another public span.`);
  });

  it("rejects duplicate identities, missing parents, cross-trace members, and cycles", () => {
    const duplicate = { ...JOINED_PUBLIC_TRACE[1]!, parentSpanId: null };
    expect(validateCompleteTrace([...JOINED_PUBLIC_TRACE, duplicate]).issues).toEqual(expect.arrayContaining([
      `Duplicate spanId: ${duplicate.spanId}.`,
      "A complete trace must contain exactly one root span.",
    ]));

    const missingParent = { ...JOINED_PUBLIC_TRACE[1]!, parentSpanId: "1111111111111111" };
    expect(validateCompleteTrace([workerRoot, missingParent]).issues)
      .toContain(`Span ${missingParent.spanId} has a parent outside the complete trace.`);

    const crossTrace = { ...JOINED_PUBLIC_TRACE[1]!, traceId: "11111111111111111111111111111111" };
    expect(validateCompleteTrace([workerRoot, crossTrace]).issues)
      .toContain("A complete trace must contain exactly one traceId.");

    const first = { ...workerRoot, parentSpanId: JOINED_PUBLIC_TRACE[1]!.spanId };
    const second = { ...JOINED_PUBLIC_TRACE[1]!, parentSpanId: workerRoot.spanId };
    expect(validateCompleteTrace([first, second]).issues)
      .toContain(`Span ${first.spanId} participates in a parent cycle.`);
  });
});
