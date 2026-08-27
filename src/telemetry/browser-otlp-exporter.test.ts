import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { describe, expect, it } from "vitest";
import { parsePublicOtlpJson } from "../domain/public-otlp";
import { PublicOtlpHttpExporter } from "./browser-otlp-exporter";

describe("browser OTLP/HTTP exporter", () => {
  it("round-trips an actual OpenTelemetry client span through the public sanitizer", async () => {
    let exported: unknown;
    let admissionHeader: string | null = null;
    const exporter = new PublicOtlpHttpExporter("a".repeat(32), "/intake", async (_input, init) => {
      exported = JSON.parse(String(init?.body)) as unknown;
      admissionHeader = new Headers(init?.headers).get("x-live-dashblog-trace-admission");
      return Response.json({});
    });
    const provider = new WebTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("live-dashblog-browser", "1");
    const remoteParent = trace.setSpanContext(ROOT_CONTEXT, {
      isRemote: true,
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    });
    const span = tracer.startSpan("browser.snapshot-fetch", {
      attributes: { "app.route_class": "snapshot", "url.full": "https://private.test/token" },
      kind: SpanKind.CLIENT,
      startTime: 1_800_000_000_081,
    }, remoteParent);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end(1_800_000_000_099);
    await provider.forceFlush();

    expect(parsePublicOtlpJson(exported)).toEqual([expect.objectContaining({
      attributes: { routeClass: "snapshot" },
      durationMs: 18,
      parentSpanId: "b7ad6b7169203331",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    })]);
    expect(JSON.stringify(exported)).not.toContain("private.test");
    expect(admissionHeader).toBe("a".repeat(32));
    await provider.shutdown();
  });

  it("does not export local-only or rendering spans", async () => {
    let calls = 0;
    const exporter = new PublicOtlpHttpExporter("a".repeat(32), "/intake", async () => {
      calls += 1;
      return Response.json({});
    });
    const provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const tracer = provider.getTracer("live-dashblog-browser", "1");
    tracer.startSpan("browser.final-paint.local-only").end();
    tracer.startSpan("browser.telemetry-render").end();
    await provider.forceFlush();

    expect(calls).toBe(0);
    await provider.shutdown();
  });
});
