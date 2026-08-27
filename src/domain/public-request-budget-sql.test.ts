import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqlPublicRequestBudgetStore,
  initializePublicRequestBudgetSchema,
} from "./public-request-budget-sql";
import type { TraceSql, TraceSqlCursor, TraceSqlValue } from "./public-trace-sql";
import {
  PUBLIC_TELEMETRY_BUDGET,
  hasPublicWebSocketCapacity,
  retryAfterSeconds,
} from "./public-telemetry-budget";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("public request budgets", () => {
  it("sheds a burst at the exact limit and admits again in the next window", () => {
    const { store } = createStore();
    const budget = { limit: 3, windowMs: 1_000 };

    expect([0, 1, 2].map(() => store.tryConsume("snapshot", budget, 10_999)))
      .toEqual([true, true, true]);
    expect(store.tryConsume("snapshot", budget, 10_999)).toBe(false);
    expect(store.recordRejectionOnce("snapshot", budget, 10_999)).toBe(true);
    expect(store.recordRejectionOnce("snapshot", budget, 10_999)).toBe(false);
    expect(store.tryConsume("snapshot", budget, 11_000)).toBe(true);
    expect(store.recordRejectionOnce("snapshot", budget, 11_000)).toBe(true);
    expect(store.rowCount()).toBe(1);
  });

  it("keeps one persisted row per independent budget", () => {
    const { store } = createStore();
    expect(store.tryConsume("intake", PUBLIC_TELEMETRY_BUDGET.intake.requests, 20_000)).toBe(true);
    expect(store.tryConsume("root-trace", PUBLIC_TELEMETRY_BUDGET.rootTraces.requests, 20_000)).toBe(true);
    expect(store.tryConsume("snapshot", PUBLIC_TELEMETRY_BUDGET.snapshots.requests, 20_000)).toBe(true);
    expect(store.tryConsume("websocket", PUBLIC_TELEMETRY_BUDGET.webSockets.requests, 20_000)).toBe(true);
    expect(store.rowCount()).toBe(4);
  });

  it("reports a conservative Retry-After value", () => {
    expect(retryAfterSeconds(10_001, { limit: 1, windowMs: 1_000 })).toBe(1);
    expect(retryAfterSeconds(10_001, { limit: 1, windowMs: 5_000 })).toBe(5);
  });

  it("rejects the WebSocket that would exceed the active connection ceiling", () => {
    expect(hasPublicWebSocketCapacity(63)).toBe(true);
    expect(hasPublicWebSocketCapacity(64)).toBe(false);
    expect(hasPublicWebSocketCapacity(-1)).toBe(false);
  });
});

function createStore(): { database: DatabaseSync; store: SqlPublicRequestBudgetStore } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = nodeSql(database);
  initializePublicRequestBudgetSchema(sql);
  return { database, store: new SqlPublicRequestBudgetStore(sql) };
}

function nodeSql(database: DatabaseSync): TraceSql {
  return {
    exec<Row>(query: string, ...bindings: TraceSqlValue[]): TraceSqlCursor<Row> {
      if (bindings.length === 0 && query.includes(";")) {
        database.exec(query);
        return { rowsWritten: 0, toArray: () => [] };
      }
      const statement = database.prepare(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
        return { rowsWritten: 0, toArray: () => statement.all(...bindings) as Row[] };
      }
      const result = statement.run(...bindings);
      return { rowsWritten: Number(result.changes), toArray: () => [] };
    },
  };
}
