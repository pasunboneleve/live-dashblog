import { describe, expect, it } from "vitest";
import { validateCompleteTrace, type PublicSpan } from "./public-span";
import {
  finishDurableObjectSpan,
  finishWorkerSpan,
  startPublicSpan,
} from "./public-runtime-span";

describe("public runtime spans", () => {
  it("hands the article server root to the browser document span", () => {
    const started = startPublicSpan(null, 1_799_999_999_990, fillWith(0x10));
    const article = finishWorkerSpan("article", started, 200, 1_800_000_000_000);
    const document = {
      ...rootBrowserSpan(),
      parentSpanId: article.spanId,
      traceId: article.traceId,
    };

    expect(started.traceparent).toBe(`00-${article.traceId}-${article.spanId}-01`);
    expect(validateCompleteTrace([article, document])).toEqual({ issues: [], valid: true });
  });

  it("joins a browser client through Worker and Durable Object spans", () => {
    const browser = browserClientSpan();
    const worker = startPublicSpan(
      `00-${browser.traceId}-${browser.spanId}-01`,
      browser.startedAtUnixMs + 2,
      fillWith(0x33),
    );
    const durableObject = startPublicSpan(worker.traceparent, browser.startedAtUnixMs + 4, fillWith(0x44));
    const workerSpan = finishWorkerSpan("snapshot", worker, 200, browser.startedAtUnixMs + 12);
    const durableObjectSpan = finishDurableObjectSpan(
      "snapshot",
      durableObject,
      200,
      browser.startedAtUnixMs + 9,
    );

    expect(workerSpan.parentSpanId).toBe(browser.spanId);
    expect(durableObjectSpan.parentSpanId).toBe(workerSpan.spanId);
    expect(new Set([browser.traceId, workerSpan.traceId, durableObjectSpan.traceId]).size).toBe(1);
    expect(validateCompleteTrace([rootBrowserSpan(), browser, workerSpan, durableObjectSpan]))
      .toEqual({ issues: [], valid: true });
  });

  it("represents the WebSocket handshake as a 1xx server span", () => {
    const started = startPublicSpan(
      "00-11111111111111111111111111111111-2222222222222222-01",
      1_000,
      fillWith(0x55),
    );

    expect(finishWorkerSpan("stream", started, 101, 1_004)).toMatchObject({
      attributes: { routeClass: "stream", statusClass: "1xx" },
      durationMs: 4,
      status: "ok",
    });
  });

  it("bounds duration and marks only server failures as errors", () => {
    const started = startPublicSpan(null, 10_000, fillWith(0x66));
    expect(finishWorkerSpan("article", started, 503, 80_001)).toMatchObject({
      durationMs: 60_000,
      status: "error",
    });
    expect(finishWorkerSpan("article", started, 404, 9_000)).toMatchObject({
      durationMs: 0,
      status: "ok",
    });
  });
});

function browserClientSpan(): PublicSpan {
  return {
    attributes: { routeClass: "snapshot" },
    durationMs: 20,
    kind: "CLIENT",
    name: "browser.snapshot-fetch",
    parentSpanId: rootBrowserSpan().spanId,
    runtimeSide: "browser",
    serviceName: "live-dashblog-browser",
    spanId: "2222222222222222",
    startedAtUnixMs: 1_800_000_000_000,
    status: "ok",
    traceId: "11111111111111111111111111111111",
    version: 1,
  };
}

function rootBrowserSpan(): PublicSpan {
  return {
    attributes: { routeClass: "article" },
    durationMs: 1,
    kind: "INTERNAL",
    name: "browser.document-load",
    parentSpanId: null,
    runtimeSide: "browser",
    serviceName: "live-dashblog-browser",
    spanId: "1111111111111111",
    startedAtUnixMs: 1_799_999_999_999,
    status: "ok",
    traceId: "11111111111111111111111111111111",
    version: 1,
  };
}

function fillWith(value: number) {
  return (target: Uint8Array): Uint8Array => target.fill(value);
}
