import { z } from "zod";
import { publicSpanBatchSchema, type PublicSpan } from "./public-span";

const otlpAttributeSchema = z.object({
  key: z.string().min(1).max(64),
  value: z.object({ stringValue: z.string().max(64) }).strict(),
}).strict();

const otlpSpanSchema = z.object({
  attributes: z.array(otlpAttributeSchema).max(8),
  endTimeUnixNano: z.string().regex(/^\d{1,20}$/),
  kind: z.enum(["SPAN_KIND_CLIENT", "SPAN_KIND_INTERNAL"]),
  name: z.enum([
    "browser.document-load",
    "browser.hydration",
    "browser.snapshot-fetch",
    "browser.stream-connect",
    "browser.article-interaction",
  ]),
  parentSpanId: z.string().optional(),
  spanId: z.string(),
  startTimeUnixNano: z.string().regex(/^\d{1,20}$/),
  status: z.object({ code: z.enum(["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"]) }).strict(),
  traceId: z.string(),
}).strict();

const otlpJsonTraceRequestSchema = z.object({
  resourceSpans: z.array(z.object({
    resource: z.object({ attributes: z.array(otlpAttributeSchema).max(4) }).strict(),
    scopeSpans: z.array(z.object({
      scope: z.object({ name: z.literal("live-dashblog-browser"), version: z.literal("1") }).strict(),
      spans: z.array(otlpSpanSchema).min(1).max(32),
    }).strict()).length(1),
  }).strict()).length(1),
}).strict();

/** Converts the browser's bounded OTLP/HTTP JSON subset into the public privacy contract. */
export function parsePublicOtlpJson(candidate: unknown): PublicSpan[] | null {
  const parsed = otlpJsonTraceRequestSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const resource = parsed.data.resourceSpans[0]!;
  const serviceName = attributeMap(resource.resource.attributes).get("service.name");
  if (serviceName !== "live-dashblog-browser") return null;

  const spans = resource.scopeSpans[0]!.spans.map((span) => {
    const attributes = attributeMap(span.attributes);
    const startedAtUnixMs = nanosToMilliseconds(span.startTimeUnixNano);
    const endedAtUnixMs = nanosToMilliseconds(span.endTimeUnixNano);
    const identity = {
      durationMs: Math.min(60_000, Math.max(0, endedAtUnixMs - startedAtUnixMs)),
      parentSpanId: span.parentSpanId === undefined ? null : base64IdToHex(span.parentSpanId, 8),
      spanId: base64IdToHex(span.spanId, 8),
      startedAtUnixMs,
      status: span.status.code === "STATUS_CODE_ERROR"
        ? "error"
        : span.status.code === "STATUS_CODE_OK" ? "ok" : "unset",
      traceId: base64IdToHex(span.traceId, 16),
      version: 1,
    } as const;

    if (span.name === "browser.article-interaction") {
      return {
        ...identity,
        attributes: {
          interactionClass: attributes.get("app.interaction_class"),
          routeClass: attributes.get("app.route_class"),
        },
        kind: span.kind === "SPAN_KIND_CLIENT" ? "CLIENT" : "INTERNAL",
        name: span.name,
        runtimeSide: "browser",
        serviceName,
      };
    }
    return {
      ...identity,
      attributes: { routeClass: attributes.get("app.route_class") },
      kind: span.kind === "SPAN_KIND_CLIENT" ? "CLIENT" : "INTERNAL",
      name: span.name,
      runtimeSide: "browser",
      serviceName,
    };
  });

  const publicBatch = publicSpanBatchSchema.safeParse(spans);
  return publicBatch.success ? publicBatch.data : null;
}

function attributeMap(attributes: readonly z.infer<typeof otlpAttributeSchema>[]): Map<string, string> {
  return new Map(attributes.map((attribute) => [attribute.key, attribute.value.stringValue]));
}

function nanosToMilliseconds(value: string): number {
  return Number(BigInt(value) / 1_000_000n);
}

function base64IdToHex(value: string, expectedBytes: number): string {
  try {
    const binary = atob(value);
    if (binary.length !== expectedBytes) return "";
    return [...binary].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}
