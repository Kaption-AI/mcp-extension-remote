/**
 * Claude and ChatGPT usage ledgers (spec mcp-usage-accounting).
 *
 * UsageLedger — one Durable Object per account (named `usage:<accountRef>`), SQLite storage. The single source of
 * truth for an account's usage: the relay writes every cloud tool call into it, the extension's local-hub counters
 * land in it, and the account's dashboard, a future limit and a future bill all read it (mcp-usage-accounting.STORE.1).
 * One object per account means every increment is serialized and exact (STORE.2) and an account can only ever read
 * its own rows (PRIVACY.3).
 *
 * UsageTotals — one Durable Object (named `global`) with the same counts summed over every account, without any
 * account or connection (PRIVACY.4), for the owner's aggregate view.
 *
 * Retention (RETAIN.1-3): hourly rows 45 days, daily rows ~13 months (400 days), local batch ids 40 days; a daily
 * alarm deletes older rows.
 */
import { DurableObject } from "cloudflare:workers";
import {
  DAY_MS,
  dayOf,
  monthRange,
  type ConnectionRow,
  type DayRow,
  type UsageCell,
  type UsagePath,
} from "./usage";
import type { Env } from "./types";

export const HOURLY_RETENTION_DAYS = 45;
export const DAILY_RETENTION_DAYS = 400;
export const BATCH_RETENTION_DAYS = 40;
export const ACTIVE_RETENTION_DAYS = 45;

/** The part of Durable Object SQLite storage the ledgers use (node:sqlite stands in for it in tests). */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const LEDGER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS usage_hour (
     hour INTEGER NOT NULL, path TEXT NOT NULL, conn TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL,
     outcome TEXT NOT NULL, latency TEXT NOT NULL, calls INTEGER NOT NULL, repeats INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (hour, path, conn, tool, kind, outcome, latency)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS usage_day (
     day TEXT NOT NULL, path TEXT NOT NULL, conn TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL,
     outcome TEXT NOT NULL, calls INTEGER NOT NULL, repeats INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, path, conn, tool, kind, outcome)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS conn (
     id TEXT PRIMARY KEY, path TEXT NOT NULL, app TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS batch (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
];

/** The ledger's storage logic, independent of the Durable Object runtime. */
export class LedgerStore {
  constructor(private sql: SqlLike) {
    for (const statement of LEDGER_SCHEMA) sql.exec(statement);
  }

  /** mcp-usage-accounting.STORE.2 — adds the cells; the caller runs it inside one transaction. */
  add(cells: UsageCell[], now: number): void {
    for (const c of cells) {
      if (!(c.calls > 0)) continue;
      this.sql.exec(
        `INSERT INTO usage_hour (hour, path, conn, tool, kind, outcome, latency, calls, repeats)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hour, path, conn, tool, kind, outcome, latency)
         DO UPDATE SET calls = calls + excluded.calls, repeats = repeats + excluded.repeats`,
        c.hour, c.path, c.connection, c.tool, c.kind, c.outcome, c.latency, c.calls, c.repeats,
      );
      this.sql.exec(
        `INSERT INTO usage_day (day, path, conn, tool, kind, outcome, calls, repeats)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day, path, conn, tool, kind, outcome)
         DO UPDATE SET calls = calls + excluded.calls, repeats = repeats + excluded.repeats`,
        dayOf(c.hour), c.path, c.connection, c.tool, c.kind, c.outcome, c.calls, c.repeats,
      );
      const seen = Math.min(now, c.hour + 3_599_999);
      this.sql.exec(
        `INSERT INTO conn (id, path, app, first_at, last_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET app = excluded.app, last_at = MAX(last_at, excluded.last_at),
           first_at = MIN(first_at, excluded.first_at)`,
        c.connection, c.path, c.app, seen, seen,
      );
    }
  }

  /** mcp-usage-accounting.LOCAL.6 — true the first time a batch id is seen (and remembers it). */
  claimBatch(batchId: string, now: number): boolean {
    if (this.sql.exec(`SELECT 1 AS x FROM batch WHERE id = ?`, batchId).toArray().length > 0) return false;
    this.sql.exec(`INSERT INTO batch (id, at) VALUES (?, ?)`, batchId, now);
    return true;
  }

  /** The month's daily rows, with each row's app (from its connection). */
  monthRows(month: string): DayRow[] {
    const range = monthRange(month);
    if (!range) return [];
    return this.sql
      .exec(
        `SELECT d.day AS day, d.path AS path, d.conn AS connection, COALESCE(c.app, 'Other') AS app, d.tool AS tool,
                d.kind AS kind, d.outcome AS outcome, d.calls AS calls, d.repeats AS repeats
         FROM usage_day d LEFT JOIN conn c ON c.id = d.conn
         WHERE d.day >= ? AND d.day < ?`,
        dayOf(range.from), dayOf(range.to),
      )
      .toArray()
      .map((r) => ({
        day: String(r.day),
        path: r.path as UsagePath,
        connection: String(r.connection),
        app: String(r.app),
        tool: String(r.tool),
        kind: String(r.kind),
        outcome: r.outcome as DayRow["outcome"],
        calls: Number(r.calls),
        repeats: Number(r.repeats),
      }));
  }

  connections(): ConnectionRow[] {
    return this.sql
      .exec(`SELECT id, path, app, last_at FROM conn`)
      .toArray()
      .map((r) => ({ id: String(r.id), path: r.path as UsagePath, app: String(r.app), lastAt: Number(r.last_at) }));
  }

  /** The first day this ledger has any row for, or null. */
  since(): string | null {
    const row = this.sql.exec(`SELECT MIN(day) AS day FROM usage_day`).toArray()[0];
    return row?.day ? String(row.day) : null;
  }

  /** Hourly cells of a time range — for the owner's investigation tools and tests. */
  hours(from: number, to: number): Record<string, unknown>[] {
    return this.sql
      .exec(
        `SELECT h.hour AS hour, h.path AS path, h.conn AS connection, COALESCE(c.app, 'Other') AS app, h.tool AS tool,
                h.kind AS kind, h.outcome AS outcome, h.latency AS latency, h.calls AS calls, h.repeats AS repeats
         FROM usage_hour h LEFT JOIN conn c ON c.id = h.conn WHERE h.hour >= ? AND h.hour < ? ORDER BY h.hour`,
        from, to,
      )
      .toArray();
  }

  /** mcp-usage-accounting.RETAIN.1-3 */
  prune(now: number): void {
    this.sql.exec(`DELETE FROM usage_hour WHERE hour < ?`, now - HOURLY_RETENTION_DAYS * DAY_MS);
    this.sql.exec(`DELETE FROM usage_day WHERE day < ?`, dayOf(now - DAILY_RETENTION_DAYS * DAY_MS));
    this.sql.exec(`DELETE FROM batch WHERE at < ?`, now - BATCH_RETENTION_DAYS * DAY_MS);
    this.sql.exec(`DELETE FROM conn WHERE last_at < ?`, now - DAILY_RETENTION_DAYS * DAY_MS);
  }
}

const TOTALS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS total_day (
     day TEXT NOT NULL, path TEXT NOT NULL, app TEXT NOT NULL, tool TEXT NOT NULL, outcome TEXT NOT NULL,
     calls INTEGER NOT NULL, repeats INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, path, app, tool, outcome)) WITHOUT ROWID`,
  // A truncated tag of the account (itself an HMAC), only to count distinct accounts per day and app.
  `CREATE TABLE IF NOT EXISTS active_day (
     day TEXT NOT NULL, app TEXT NOT NULL, acct TEXT NOT NULL, PRIMARY KEY (day, app, acct)) WITHOUT ROWID`,
];

export interface TotalsRow {
  day: string;
  path: UsagePath;
  app: string;
  tool: string;
  outcome: string;
  calls: number;
  repeats: number;
}

/** The global totals' storage logic (no account, no connection). */
export class TotalsStore {
  constructor(private sql: SqlLike) {
    for (const statement of TOTALS_SCHEMA) sql.exec(statement);
  }

  add(cells: UsageCell[], accountTag: string): void {
    for (const c of cells) {
      if (!(c.calls > 0)) continue;
      const day = dayOf(c.hour);
      this.sql.exec(
        `INSERT INTO total_day (day, path, app, tool, outcome, calls, repeats) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day, path, app, tool, outcome)
         DO UPDATE SET calls = calls + excluded.calls, repeats = repeats + excluded.repeats`,
        day, c.path, c.app, c.tool, c.outcome, c.calls, c.repeats,
      );
      this.sql.exec(`INSERT OR IGNORE INTO active_day (day, app, acct) VALUES (?, ?, ?)`, day, c.app, accountTag);
    }
  }

  report(fromDay: string, toDay: string): { rows: TotalsRow[]; accounts: { day: string; app: string; accounts: number }[] } {
    const rows = this.sql
      .exec(
        `SELECT day, path, app, tool, outcome, calls, repeats FROM total_day WHERE day >= ? AND day < ? ORDER BY day`,
        fromDay, toDay,
      )
      .toArray()
      .map((r) => ({
        day: String(r.day),
        path: r.path as UsagePath,
        app: String(r.app),
        tool: String(r.tool),
        outcome: String(r.outcome),
        calls: Number(r.calls),
        repeats: Number(r.repeats),
      }));
    const accounts = this.sql
      .exec(
        `SELECT day, app, COUNT(*) AS n FROM active_day WHERE day >= ? AND day < ? GROUP BY day, app ORDER BY day`,
        fromDay, toDay,
      )
      .toArray()
      .map((r) => ({ day: String(r.day), app: String(r.app), accounts: Number(r.n) }));
    return { rows, accounts };
  }

  prune(now: number): void {
    this.sql.exec(`DELETE FROM total_day WHERE day < ?`, dayOf(now - DAILY_RETENTION_DAYS * DAY_MS));
    this.sql.exec(`DELETE FROM active_day WHERE day < ?`, dayOf(now - ACTIVE_RETENTION_DAYS * DAY_MS));
  }
}

interface DoState {
  storage: {
    sql: SqlLike;
    transactionSync<T>(fn: () => T): T;
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
  };
  waitUntil(promise: Promise<unknown>): void;
}

async function ensureDailyAlarm(state: DoState, now: number): Promise<void> {
  if ((await state.storage.getAlarm()) == null) await state.storage.setAlarm(now + DAY_MS);
}

export class UsageLedger extends DurableObject<Env> {
  private store: LedgerStore;
  private state: DoState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx as unknown as DoState;
    this.store = new LedgerStore(this.state.storage.sql);
  }

  /**
   * mcp-usage-accounting.RECORD.1, LOCAL.6 — adds cells (one call, or a local batch). With a batch id, a batch seen
   * before is not added again. `accountTag` feeds the global totals' distinct-account count.
   */
  async record(
    cells: UsageCell[],
    options: { batchId?: string; accountTag?: string } = {},
  ): Promise<{ accepted: number; duplicate: boolean }> {
    const now = Date.now();
    const accepted = this.state.storage.transactionSync(() => {
      if (options.batchId && !this.store.claimBatch(options.batchId, now)) return -1;
      this.store.add(cells, now);
      return cells.length;
    });
    if (accepted < 0) return { accepted: 0, duplicate: true };
    // PRIVACY.4 — the global totals get the same counts without account or connection.
    const totals = this.env.USAGE_TOTALS;
    if (totals) {
      this.state.waitUntil(
        totals
          .get(totals.idFromName("global"))
          .add(cells, (options.accountTag ?? "").slice(0, 16))
          .catch((error: unknown) => console.error("[usage] totals failed:", error instanceof Error ? error.message : error)),
      );
    }
    this.state.waitUntil(ensureDailyAlarm(this.state, now).catch(() => undefined));
    return { accepted, duplicate: false };
  }

  /** mcp-usage-accounting.REPORT.1 — the month's rows, the account's connections and the first counted day. */
  async report(month: string): Promise<{ rows: DayRow[]; connections: ConnectionRow[]; since: string | null }> {
    return { rows: this.store.monthRows(month), connections: this.store.connections(), since: this.store.since() };
  }

  async hours(from: number, to: number): Promise<Record<string, unknown>[]> {
    return this.store.hours(from, to);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.store.prune(now);
    await this.state.storage.setAlarm(now + DAY_MS);
  }
}

export class UsageTotals extends DurableObject<Env> {
  private store: TotalsStore;
  private state: DoState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx as unknown as DoState;
    this.store = new TotalsStore(this.state.storage.sql);
  }

  async add(cells: UsageCell[], accountTag: string): Promise<void> {
    this.state.storage.transactionSync(() => this.store.add(cells, accountTag || "unknown"));
    await ensureDailyAlarm(this.state, Date.now());
  }

  async report(fromDay: string, toDay: string) {
    return this.store.report(fromDay, toDay);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.store.prune(now);
    await this.state.storage.setAlarm(now + DAY_MS);
  }
}

/** The ledger of an account. */
export function ledgerFor(env: Pick<Env, "USAGE_LEDGER">, accountRef: string) {
  if (!env.USAGE_LEDGER) throw new Error("Usage ledger not bound");
  return env.USAGE_LEDGER.get(env.USAGE_LEDGER.idFromName(`usage:${accountRef}`));
}
