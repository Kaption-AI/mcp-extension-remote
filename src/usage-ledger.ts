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
  hourOf,
  monthRange,
  type ConnectionRow,
  type DayRow,
  type UsageCell,
  type UsagePath,
} from "./usage";
import type { Env } from "./types";
import { MeterStore, type Allowance, type HoldInput, type LeaseAnswer, type LeaseRequest, type Peek, type Reservation } from "./meter";
import {
  countWindow,
  currentWindow,
  fetchPlan,
  planFresh,
  shadowOf,
  windowRange,
  type LedgerPlan,
  type PlanTier,
  type ShadowWindow,
  type WindowCount,
  type WindowKind,
  type WindowRange,
  type WindowRow,
} from "./ledger-windows";

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
  // mcp-usage-ledger.PLAN.4 — the last plan answer rest-api gave this account (one row).
  `CREATE TABLE IF NOT EXISTS plan_cache (
     id INTEGER PRIMARY KEY CHECK (id = 1), fetched_at INTEGER NOT NULL, ttl_s INTEGER NOT NULL, tier TEXT NOT NULL,
     period TEXT, lim INTEGER, pool_ref TEXT, pool_numbers INTEGER, enforced_by TEXT NOT NULL)`,
  // mcp-usage-ledger.SHADOW.1, SHADOW.3 — when a window's count first passed the plan's limit (no call data).
  `CREATE TABLE IF NOT EXISTS shadow_window (win TEXT PRIMARY KEY, lim INTEGER NOT NULL, crossed_at INTEGER NOT NULL)`,
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

  /** mcp-usage-ledger.MODEL.3-4 — a window's daily rows grouped by road, tool and outcome. */
  windowRows(range: WindowRange): WindowRow[] {
    return this.sql
      .exec(
        `SELECT path, tool, outcome, SUM(calls) AS calls FROM usage_day WHERE day >= ? AND day < ? GROUP BY path, tool, outcome`,
        dayOf(range.from), dayOf(range.to),
      )
      .toArray()
      .map((r) => ({ path: r.path as UsagePath, tool: String(r.tool), outcome: String(r.outcome), calls: Number(r.calls) }));
  }

  windowCount(range: WindowRange): WindowCount {
    return countWindow(range, this.windowRows(range));
  }

  /** mcp-usage-ledger.PLAN.4 — the cached plan and when it was fetched, or null. */
  plan(): { plan: LedgerPlan; fetchedAt: number } | null {
    const r = this.sql.exec(`SELECT * FROM plan_cache WHERE id = 1`).toArray()[0];
    if (!r) return null;
    return {
      fetchedAt: Number(r.fetched_at),
      plan: {
        tier: String(r.tier) as PlanTier,
        period: r.period === "week" || r.period === "month" ? (r.period as WindowKind) : null,
        limit: r.lim === null || r.lim === undefined ? null : Number(r.lim),
        pool: r.pool_ref ? { ref: String(r.pool_ref), numbers: Number(r.pool_numbers ?? 1) } : null,
        enforcedBy: (String(r.enforced_by) as LedgerPlan["enforcedBy"]) || "none",
        ttlSeconds: Number(r.ttl_s),
      },
    };
  }

  setPlan(plan: LedgerPlan, now: number): void {
    this.sql.exec(
      `INSERT INTO plan_cache (id, fetched_at, ttl_s, tier, period, lim, pool_ref, pool_numbers, enforced_by)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET fetched_at = excluded.fetched_at, ttl_s = excluded.ttl_s, tier = excluded.tier,
         period = excluded.period, lim = excluded.lim, pool_ref = excluded.pool_ref, pool_numbers = excluded.pool_numbers,
         enforced_by = excluded.enforced_by`,
      now, plan.ttlSeconds, plan.tier, plan.period, plan.limit, plan.pool?.ref ?? null, plan.pool?.numbers ?? null, plan.enforcedBy,
    );
  }

  /** mcp-usage-ledger.SHADOW.1 — the first time a window passed its limit is kept (later ones are ignored). */
  markCrossed(kind: WindowKind, period: string, limit: number, at: number): void {
    this.sql.exec(`INSERT OR IGNORE INTO shadow_window (win, lim, crossed_at) VALUES (?, ?, ?)`, `${kind}:${period}`, limit, at);
  }

  crossedAt(kind: WindowKind, period: string): number | null {
    const r = this.sql.exec(`SELECT crossed_at FROM shadow_window WHERE win = ?`, `${kind}:${period}`).toArray()[0];
    return r ? Number(r.crossed_at) : null;
  }

  /** mcp-usage-accounting.RETAIN.1-3, mcp-usage-ledger.RETAIN.2 */
  prune(now: number): void {
    this.sql.exec(`DELETE FROM shadow_window WHERE crossed_at < ?`, now - DAILY_RETENTION_DAYS * DAY_MS);
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
  private meter: MeterStore;
  private state: DoState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx as unknown as DoState;
    this.store = new LedgerStore(this.state.storage.sql);
    this.meter = new MeterStore(this.state.storage.sql);
  }

  /**
   * business-plans.MCP_LEDGER.4, MCP_LEDGER.12 — one slot for a call, decided and taken in one transaction (stale
   * local holds are recorded first, so the count is what it will be).
   */
  async meterReserve(input: HoldInput, now = Date.now()): Promise<Reservation> {
    return this.state.storage.transactionSync(() => {
      const stale = this.meter.sweep(now);
      if (stale.length) this.store.add(stale, now);
      return this.meter.reserve(input, now);
    });
  }

  /** business-plans.MCP_LEDGER.3 */
  async meterSetAllowance(a: Allowance, now = Date.now()): Promise<void> {
    this.meter.setAllowance(a, now);
  }

  /** business-plans.MCP_LEDGER.5, MCP_ASYNC.2 — with the headroom the charge answer showed. */
  async meterCharged(actionId: string, headroomMc?: number | null, now = Date.now()): Promise<void> {
    this.meter.markCharged(actionId);
    if (headroomMc !== undefined) this.meter.setHeadroom(headroomMc, now);
  }

  /** business-plans.MCP_LEDGER.6-7, MCP_ASYNC.6 */
  async meterDrop(actionId: string, headroomMc?: number | null, now = Date.now()): Promise<{ charged: boolean } | null> {
    if (headroomMc !== undefined) this.meter.setHeadroom(headroomMc, now);
    return this.meter.drop(actionId);
  }

  /** business-plans.MCP_ASYNC.2 — a session's view, without taking a slot (stale local holds recorded first). */
  async meterPeek(now = Date.now()): Promise<Peek> {
    return this.state.storage.transactionSync(() => {
      const stale = this.meter.sweep(now);
      if (stale.length) this.store.add(stale, now);
      return this.meter.peek(now);
    });
  }

  /** business-plans.MCP_ASYNC.8, .14 — after a background charge. */
  async meterAfterCharge(actionId: string, headroomMc: number | null | undefined, uncharged: boolean, now = Date.now()): Promise<void> {
    this.state.storage.transactionSync(() => {
      if (headroomMc !== undefined) this.meter.setHeadroom(headroomMc, now);
      if (uncharged) this.meter.markUncharged(actionId, now);
    });
  }

  /** business-plans.MCP_ASYNC.10-15 — one lease request (settles, then the lease topped up or closed). */
  async meterLease(req: LeaseRequest, now = Date.now(), accountTag = ""): Promise<LeaseAnswer> {
    let added: UsageCell[] = [];
    const answer = this.state.storage.transactionSync(() => {
      const stale = this.meter.sweep(now);
      if (stale.length) this.store.add(stale, now);
      return this.meter.lease(req, now, (cells) => {
        this.store.add(cells, now);
        added = cells;
      });
    });
    const totals = this.env.USAGE_TOTALS;
    if (added.length && totals) {
      this.state.waitUntil(totalsFor(this.env, accountTag).add(added, accountTag.slice(0, 16)).catch(() => undefined));
    }
    return answer;
  }

  /**
   * business-plans.MCP_LEDGER.12 — a metered local call finished: its hold goes and the call is recorded (as the hold
   * says: tool, kind, app) in one transaction. null when there was no hold (already settled or swept).
   */
  async meterSettle(
    actionId: string,
    outcome: UsageCell["outcome"],
    latency: UsageCell["latency"],
    accountTag: string,
  ): Promise<{ charged: boolean } | null> {
    const now = Date.now();
    let cell: UsageCell | null = null;
    const hold = this.state.storage.transactionSync(() => {
      const h = this.meter.settle(actionId);
      if (!h) return null;
      cell = { hour: hourOf(now), path: h.path, connection: h.conn, app: h.app, tool: h.tool, kind: h.kind, outcome, latency, calls: 1, repeats: 0 };
      this.store.add([cell], now);
      return h;
    });
    const totals = this.env.USAGE_TOTALS;
    if (cell && totals) {
      this.state.waitUntil(
        totalsFor(this.env, accountTag).add([cell], accountTag.slice(0, 16)).catch(() => undefined),
      );
    }
    return hold ? { charged: hold.charged } : null;
  }

  /** business-plans.MCP_LEDGER.11 — the cached allowance (the meter's "not metered" answer carries its ttl). */
  async meterAllowance(now = Date.now()): Promise<Allowance | null> {
    return this.meter.allowance(now);
  }

  /**
   * mcp-usage-accounting.RECORD.1, LOCAL.6 — adds cells (one call, or a local batch). With a batch id, a batch seen
   * before is not added again. `accountTag` feeds the global totals' distinct-account count. With `settle`, the
   * metered call's hold goes away in the same transaction (business-plans.MCP_LEDGER.8) and is answered back.
   */
  async record(
    cells: UsageCell[],
    options: { batchId?: string; accountTag?: string; settle?: string; uncharged?: string } = {},
  ): Promise<{ accepted: number; duplicate: boolean; settled?: { charged: boolean } | null }> {
    const now = Date.now();
    let settled: { charged: boolean } | null = null;
    const accepted = this.state.storage.transactionSync(() => {
      if (options.batchId && !this.store.claimBatch(options.batchId, now)) return -1;
      if (options.settle) {
        const hold = this.meter.settle(options.settle);
        settled = hold ? { charged: hold.charged } : null;
      }
      // business-plans.MCP_ASYNC.8 — ran before its reservation answered, and the charge was refused afterwards.
      if (options.uncharged) this.meter.markUncharged(options.uncharged, now);
      this.store.add(cells, now);
      return cells.length;
    });
    if (accepted < 0) return { accepted: 0, duplicate: true };
    // PRIVACY.4 — the global totals get the same counts without account or connection.
    const totals = this.env.USAGE_TOTALS;
    if (totals) {
      this.state.waitUntil(
        totalsFor(this.env, options.accountTag ?? "")
          .add(cells, (options.accountTag ?? "").slice(0, 16))
          .catch((error: unknown) => console.error("[usage] totals failed:", error instanceof Error ? error.message : error)),
      );
    }
    this.state.waitUntil(ensureDailyAlarm(this.state, now).catch(() => undefined));
    return { accepted, duplicate: false, ...(options.settle ? { settled } : {}) };
  }

  /**
   * mcp-usage-ledger.MODEL.3, READ.3 — this account's week and month (the current ones unless named), the cached plan
   * and when each window passed it (SHADOW.3). Read only.
   */
  async windows(opts: { week?: string; month?: string } = {}, now = Date.now()): Promise<LedgerWindows> {
    const week = opts.week ? windowRange("week", opts.week) : currentWindow("week", now);
    const month = opts.month ? windowRange("month", opts.month) : currentWindow("month", now);
    const cached = this.store.plan();
    return {
      week: week ? this.store.windowCount(week) : null,
      month: month ? this.store.windowCount(month) : null,
      since: this.store.since(),
      plan: cached ? { ...cached.plan, fetchedAt: cached.fetchedAt } : null,
      crossed: {
        week: week ? this.store.crossedAt("week", week.period) : null,
        month: month ? this.store.crossedAt("month", month.period) : null,
      },
    };
  }

  /**
   * mcp-usage-ledger.SHADOW.1-2, PLAN.4-5 — after a recorded call or batch (always from waitUntil, never before a call):
   * refresh the plan when it is stale and keep when the plan's window first passed its limit. Never throws, never
   * refuses anything.
   */
  async shadowAfter(phone: string, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<ShadowWindow | null> {
    try {
      let cached = this.store.plan();
      if (!cached || !planFresh(cached.fetchedAt, cached.plan.ttlSeconds, now, cached.plan.period)) {
        const fresh = await fetchPlan(this.env, phone, fetchImpl);
        if (fresh) {
          this.store.setPlan(fresh, now);
          cached = { plan: fresh, fetchedAt: now };
        }
      }
      const plan = cached?.plan;
      if (!plan || plan.limit === null || !plan.period) return null;
      const range = currentWindow(plan.period, now);
      const counted = this.store.windowCount(range).counted;
      if (counted > plan.limit) this.store.markCrossed(plan.period, range.period, plan.limit, now);
      return shadowOf(plan.limit, counted, this.store.crossedAt(plan.period, range.period));
    } catch (error) {
      console.error("[ledger] shadow failed:", error instanceof Error ? error.message : error);
      return null;
    }
  }

  /** mcp-usage-accounting.REPORT.1 — the month's rows, the account's connections and the first counted day. */
  async report(month: string): Promise<{ rows: DayRow[]; connections: ConnectionRow[]; since: string | null; uncharged: number; test: boolean }> {
    // business-plans.MCP_ASYNC.8 — the month's actions that ran and could not be charged.
    // business-plans.TEST_ACCOUNT.3 — and whether rest-api said this is a test account (charged on a test balance).
    return { rows: this.store.monthRows(month), connections: this.store.connections(), since: this.store.since(), uncharged: this.meter.uncharged(month), test: this.meter.isTest(month) };
  }

  async hours(from: number, to: number): Promise<Record<string, unknown>[]> {
    return this.store.hours(from, to);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.store.prune(now);
    this.state.storage.transactionSync(() => {
      const stale = this.meter.sweep(now);
      if (stale.length) this.store.add(stale, now);
      this.meter.prune(now);
    });
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

export interface LedgerWindows {
  week: WindowCount | null;
  month: WindowCount | null;
  since: string | null;
  plan: (LedgerPlan & { fetchedAt: number }) | null;
  crossed: { week: number | null; month: number | null };
}

/** mcp-usage-ledger.TOTALS.1 — how many global totals objects calls are spread over (1 = the old single "global"). */
export const DEFAULT_TOTALS_SHARDS = 16;

export function totalsShards(env: Pick<Env, "USAGE_TOTALS_SHARDS">): number {
  const n = Number(env.USAGE_TOTALS_SHARDS ?? DEFAULT_TOTALS_SHARDS);
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : DEFAULT_TOTALS_SHARDS;
}

/** mcp-usage-ledger.TOTALS.1, TOTALS.3 — an account always lands in the same shard (FNV-1a of its tag). */
export function totalsShardName(accountTag: string, shards: number): string {
  if (shards <= 1) return "global";
  let h = 0x811c9dc5;
  for (let i = 0; i < accountTag.length; i++) {
    h ^= accountTag.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `global:${h % shards}`;
}

/** Every totals object /admin/usage reads: the old "global" (days before the split) and every shard (TOTALS.2). */
export function totalsNames(env: Pick<Env, "USAGE_TOTALS_SHARDS">): string[] {
  const shards = totalsShards(env);
  return shards <= 1 ? ["global"] : ["global", ...Array.from({ length: shards }, (_, i) => `global:${i}`)];
}

function totalsFor(env: Env, accountTag: string) {
  const ns = env.USAGE_TOTALS!;
  return ns.get(ns.idFromName(totalsShardName(accountTag.slice(0, 16), totalsShards(env))));
}

/** The ledger of an account. */
export function ledgerFor(env: Pick<Env, "USAGE_LEDGER">, accountRef: string) {
  if (!env.USAGE_LEDGER) throw new Error("Usage ledger not bound");
  return env.USAGE_LEDGER.get(env.USAGE_LEDGER.idFromName(`usage:${accountRef}`));
}
