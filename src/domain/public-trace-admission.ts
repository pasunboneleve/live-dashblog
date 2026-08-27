import { z } from "zod";
import type { PublicSpan } from "./public-span";

export const PUBLIC_TRACE_ADMISSION_HEADER = "x-live-dashblog-trace-admission";
export const PUBLIC_TRACE_ADMISSION_TTL_MS = 5 * 60_000;
export const PUBLIC_TRACE_ADMISSION_BATCH_LIMIT = 8;
export const PUBLIC_TRACE_ADMISSION_RATE_LIMIT = 10;
export const PUBLIC_TRACE_ADMISSION_RATE_WINDOW_MS = 1_000;

export const publicTraceAdmissionSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{32}$/),
  traceId: z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/),
}).strict();

/** Browser intake may add spans only to the single trace named by its admission. */
export function admissionMatchesBatch(
  admissionTraceId: string,
  spans: readonly PublicSpan[],
): boolean {
  return spans.length > 0 && spans.every((span) =>
    span.runtimeSide === "browser" && span.traceId === admissionTraceId
  );
}
