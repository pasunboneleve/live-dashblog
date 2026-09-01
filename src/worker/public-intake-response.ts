/** Preserves intentional intake shedding while masking other storage failures. */
export function publicIntakeStorageFailure(stored: Response): Response | null {
  if (stored.ok) return null;
  if (stored.status === 403) return new Response("Trace admission rejected", { status: 403 });
  if (stored.status === 429) {
    const retryAfter = stored.headers.get("retry-after");
    return new Response("Optional telemetry budget reached", {
      headers: {
        "cache-control": "no-store",
        ...(retryAfter ? { "retry-after": retryAfter } : {}),
      },
      status: 429,
    });
  }
  return new Response("Telemetry storage unavailable", { status: 503 });
}
