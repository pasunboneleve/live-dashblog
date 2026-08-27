export interface TraceContext {
  parentSpanId: string | null;
  spanId: string;
  traceFlags: string;
  traceId: string;
}

export type RandomBytes = (target: Uint8Array) => Uint8Array;

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parses the strict W3C version emitted by the browser SDK. Invalid input starts a new trace. */
export function parseTraceparent(value: string | null): Omit<TraceContext, "spanId"> | null {
  const match = value?.match(TRACEPARENT_PATTERN);
  if (!match || isAllZero(match[1]!) || isAllZero(match[2]!)) return null;
  return {
    parentSpanId: match[2]!,
    traceFlags: match[3]!,
    traceId: match[1]!,
  };
}

/** Creates a local span context that continues a valid remote parent or begins a new trace. */
export function createTraceContext(
  traceparent: string | null,
  randomBytes: RandomBytes = crypto.getRandomValues.bind(crypto),
): TraceContext {
  const remote = parseTraceparent(traceparent);
  return {
    parentSpanId: remote?.parentSpanId ?? null,
    spanId: randomHex(8, randomBytes),
    traceFlags: remote?.traceFlags ?? "01",
    traceId: remote?.traceId ?? randomHex(16, randomBytes),
  };
}

/** Formats the current span as the remote parent for the next runtime hop. */
export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

function randomHex(byteLength: number, randomBytes: RandomBytes): string {
  for (;;) {
    const bytes = randomBytes(new Uint8Array(byteLength));
    const value = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!isAllZero(value)) return value;
  }
}

function isAllZero(value: string): boolean {
  return /^0+$/.test(value);
}
