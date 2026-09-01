/** A budget rejection must not recursively spend the telemetry budget it protects. */
export function shouldRecordPublicRuntimeSpan(responseStatus: number): boolean {
  return responseStatus !== 429;
}
