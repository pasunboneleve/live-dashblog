export interface FixedWindowBudget {
  limit: number;
  windowMs: number;
}

export const PUBLIC_TELEMETRY_BUDGET = Object.freeze({
  intake: Object.freeze({
    maxBatchesPerTrace: 8,
    maxPayloadBytes: 64 * 1024,
    requests: Object.freeze({ limit: 40, windowMs: 1_000 }),
  }),
  rootTraces: Object.freeze({
    maxActive: 120,
    requests: Object.freeze({ limit: 10, windowMs: 1_000 }),
  }),
  snapshots: Object.freeze({
    requests: Object.freeze({ limit: 30, windowMs: 1_000 }),
  }),
  webSockets: Object.freeze({
    maxActive: 64,
    requests: Object.freeze({ limit: 10, windowMs: 1_000 }),
  }),
});

export type PublicRequestBudgetName = "intake" | "root-trace" | "snapshot" | "websocket";

export function fixedWindowStart(now: number, budget: FixedWindowBudget): number {
  return Math.floor(now / budget.windowMs) * budget.windowMs;
}

export function retryAfterSeconds(now: number, budget: FixedWindowBudget): number {
  const nextWindowAt = fixedWindowStart(now, budget) + budget.windowMs;
  return Math.max(1, Math.ceil((nextWindowAt - now) / 1_000));
}

export function hasPublicWebSocketCapacity(activeConnections: number): boolean {
  return Number.isSafeInteger(activeConnections)
    && activeConnections >= 0
    && activeConnections < PUBLIC_TELEMETRY_BUDGET.webSockets.maxActive;
}
