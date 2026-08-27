import { describe, expect, it } from "vitest";
import { parsePublicOtlpJson } from "./public-otlp";

const validPayload = {
  resourceSpans: [{
    resource: { attributes: [attribute("service.name", "live-dashblog-browser")] },
    scopeSpans: [{
      scope: { name: "live-dashblog-browser", version: "1" },
      spans: [{
        attributes: [attribute("app.route_class", "snapshot")],
        endTimeUnixNano: "1800000000099000000",
        kind: "SPAN_KIND_CLIENT",
        name: "browser.snapshot-fetch",
        parentSpanId: hexToBase64("b7ad6b7169203331"),
        spanId: hexToBase64("a2fb4a1d1a96d312"),
        startTimeUnixNano: "1800000000081000000",
        status: { code: "STATUS_CODE_OK" },
        traceId: hexToBase64("4bf92f3577b34da6a3ce929d0e0e4736"),
      }],
    }],
  }],
};

describe("public OTLP/HTTP JSON intake", () => {
  it("converts the bounded browser subset into the public span contract", () => {
    expect(parsePublicOtlpJson(validPayload)).toEqual([{
      attributes: { routeClass: "snapshot" },
      durationMs: 18,
      kind: "CLIENT",
      name: "browser.snapshot-fetch",
      parentSpanId: "b7ad6b7169203331",
      runtimeSide: "browser",
      serviceName: "live-dashblog-browser",
      spanId: "a2fb4a1d1a96d312",
      startedAtUnixMs: 1_800_000_000_081,
      status: "ok",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      version: 1,
    }]);
  });

  it.each([
    ["unknown resource", { ...validPayload, resourceSpans: [{ ...validPayload.resourceSpans[0], resource: {
      attributes: [attribute("service.name", "forged-worker")],
    } }] }],
    ["server kind", mutateSpan({ kind: "SPAN_KIND_SERVER" })],
    ["server operation", mutateSpan({ name: "worker.snapshot-request" })],
    ["unknown attribute", mutateSpan({ attributes: [attribute("url.full", "https://private.test/")] })],
    ["malformed identity", mutateSpan({ traceId: "not-base64" })],
    ["oversized batch", mutateSpans(Array.from({ length: 33 }, () => validPayload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!))],
  ])("rejects %s", (_label, payload) => {
    expect(parsePublicOtlpJson(payload)).toBeNull();
  });
});

function attribute(key: string, stringValue: string) {
  return { key, value: { stringValue } };
}

function mutateSpan(changes: Record<string, unknown>): unknown {
  return mutateSpans([{ ...validPayload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!, ...changes }]);
}

function mutateSpans(spans: unknown[]): unknown {
  return {
    resourceSpans: [{
      ...validPayload.resourceSpans[0],
      scopeSpans: [{ ...validPayload.resourceSpans[0]!.scopeSpans[0], spans }],
    }],
  };
}

function hexToBase64(value: string): string {
  return btoa(String.fromCharCode(...value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16))));
}
