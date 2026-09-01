import type { TraceSql } from "./public-trace-sql";
import {
  fixedWindowStart,
  type FixedWindowBudget,
  type PublicRequestBudgetName,
} from "./public-telemetry-budget";

interface BudgetRow {
  accepted_count: number;
  rejection_recorded: number;
  window_started_at: number;
}

interface ColumnRow {
  name: string;
}

interface CountRow {
  count: number;
}

export function initializePublicRequestBudgetSchema(sql: TraceSql): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS public_request_budgets (
      kind TEXT PRIMARY KEY CHECK (kind IN ('intake', 'root-trace', 'snapshot', 'websocket')),
      window_started_at INTEGER NOT NULL,
      accepted_count INTEGER NOT NULL CHECK (accepted_count >= 0),
      rejection_recorded INTEGER NOT NULL DEFAULT 0 CHECK (rejection_recorded IN (0, 1))
    );
  `);
  const columns = sql.exec<ColumnRow>("PRAGMA table_info(public_request_budgets)").toArray();
  if (!columns.some((column) => column.name === "rejection_recorded")) {
    sql.exec(
      "ALTER TABLE public_request_budgets ADD COLUMN rejection_recorded INTEGER NOT NULL DEFAULT 0",
    );
  }
}

/**
 * Persists one fixed-window counter per optional public operation. The caller owns
 * any wider transaction that must combine admission with another state change.
 */
export class SqlPublicRequestBudgetStore {
  constructor(private readonly sql: TraceSql) {}

  tryConsume(kind: PublicRequestBudgetName, budget: FixedWindowBudget, now: number): boolean {
    const windowStartedAt = fixedWindowStart(now, budget);
    const row = this.sql.exec<BudgetRow>(`
      SELECT window_started_at, accepted_count, rejection_recorded
      FROM public_request_budgets WHERE kind = ?
    `, kind).toArray()[0];
    const acceptedCount = row?.window_started_at === windowStartedAt ? Number(row.accepted_count) : 0;
    if (acceptedCount >= budget.limit) return false;

    this.sql.exec(`
      INSERT INTO public_request_budgets (kind, window_started_at, accepted_count)
      VALUES (?, ?, 1)
      ON CONFLICT(kind) DO UPDATE SET
        window_started_at = excluded.window_started_at,
        accepted_count = CASE
          WHEN public_request_budgets.window_started_at = excluded.window_started_at
            THEN public_request_budgets.accepted_count + 1
          ELSE 1
        END,
        rejection_recorded = CASE
          WHEN public_request_budgets.window_started_at = excluded.window_started_at
            THEN public_request_budgets.rejection_recorded
          ELSE 0
        END
    `, kind, windowStartedAt);
    return true;
  }

  /** Returns true only for the first rejected request in a budget window. */
  recordRejectionOnce(
    kind: PublicRequestBudgetName,
    budget: FixedWindowBudget,
    now: number,
  ): boolean {
    const windowStartedAt = fixedWindowStart(now, budget);
    const row = this.sql.exec<BudgetRow>(`
      SELECT window_started_at, accepted_count, rejection_recorded
      FROM public_request_budgets WHERE kind = ?
    `, kind).toArray()[0];
    if (row?.window_started_at === windowStartedAt && row.rejection_recorded === 1) return false;

    this.sql.exec(`
      INSERT INTO public_request_budgets
        (kind, window_started_at, accepted_count, rejection_recorded)
      VALUES (?, ?, 0, 1)
      ON CONFLICT(kind) DO UPDATE SET
        window_started_at = excluded.window_started_at,
        accepted_count = CASE
          WHEN public_request_budgets.window_started_at = excluded.window_started_at
            THEN public_request_budgets.accepted_count
          ELSE 0
        END,
        rejection_recorded = 1
    `, kind, windowStartedAt);
    return true;
  }

  rowCount(): number {
    return Number(this.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM public_request_budgets",
    ).toArray()[0]?.count ?? 0);
  }
}
