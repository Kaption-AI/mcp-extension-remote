/**
 * Claude and ChatGPT overage on the account's usage ledger (kaptionai features/pricing/business-plans.feature.yaml,
 * MCP_LEDGER and MCP_PAY; design docs/mcp-usage/ARCHITECTURE.md "Limits and billing on the ledger").
 *
 * The ledger (usage-ledger.ts) is the one count of an account's calls. With the switches on, every cloud call and
 * every local-hub call of a metered account takes a slot in the same ledger before it runs: included while this
 * month's counted calls plus the calls still running are below the allowance, otherwise charged first through rest-api
 * (keyed by the action id, so a retry is charged once). A call that fails gives its slot back and, when it was
 * charged, its charge. The phone is never stored here (business-plans.MCP_LEDGER.16): the caller passes it in.
 *
 * MeterStore is the storage logic (no Durable Object runtime, so tests run it on node:sqlite); the rest-api client
 * and the decision flow (meterCall) live below it.
 */
import {
  DAY_MS,
  dayOf,
  hourOf,
  isToolName,
  localConnectionId,
  monthOf,
  monthRange,
  type LatencyBucket,
  type UsageCell,
  type UsageOutcome,
  type UsagePath,
} from "./usage";
import type { SqlLike } from "./usage-ledger";

/** business-plans.MCP_LEDGER.3 — the allowance answer is kept this long unless rest-api says otherwise. */
export const DEFAULT_ALLOWANCE_TTL_S = 600;
/** business-plans.MCP_LEDGER.12 — a hold nobody settled is resolved after this long. */
export const HOLD_STALE_MS = 15 * 60_000;
const ACTION_ID = /^[A-Za-z0-9_:.-]{8,96}$/;

export const isActionId = (v: unknown): v is string => typeof v === "string" && ACTION_ID.test(v);

export interface Allowance {
  metered: boolean;
  plan: string | null;
  /** Calls a month the plan includes; null = not counted. */
  allowance: number | null;
  priceMillicents: number | null;
  ttlSeconds: number;
  /**
   * business-plans.TEST_ACCOUNT.3 — a test account: metered exactly the same, but rest-api charges its separate test
   * balance (never real money). Kept so the usage report can say so.
   */
  test?: boolean;
}

export interface HoldInput {
  actionId: string;
  path: UsagePath;
  connection: string;
  app: string;
  tool: string;
  kind: string;
}

/** What the ledger decided about one call. */
export type Reservation =
  /** No allowance known (or it went stale): ask rest-api, store it, reserve again. */
  | { state: "unknown" }
  /** Not metered: nothing held, the call runs as before (for ttlMs more). */
  | { state: "off"; ttlMs?: number }
  /** Held, within the allowance. business-plans.MCP_ASYNC.2 — with the price and the last known headroom. */
  | { state: "included"; used: number; allowance: number; priceMc?: number | null; headroomMc?: number | null }
  /** Held, past the allowance: charge it before it runs. */
  | { state: "charge"; used: number; allowance: number; charged: boolean; priceMc?: number | null; headroomMc?: number | null };

/** business-plans.MCP_ASYNC.2 — the ledger as a session sees it, without taking a slot. */
export type Peek =
  | { state: "unknown" }
  | { state: "off"; ttlMs: number }
  | { state: "metered"; used: number; allowance: number; priceMc: number | null; headroomMc: number | null };

/** business-plans.MCP_ASYNC.10 — the local bridge's lease (MCP_ASYNC.10-15). */
export const LEASE_SLOTS = 20;
/** business-plans.MCP_ASYNC.11 */
export const LEASE_EXTRA_MAX = 10;
export const LEASE_EXTRA_MARGIN = 4;
/** business-plans.MCP_ASYNC.15 */
export const LEASE_TTL_MS = 600_000;
export const LEASE_SETTLE_MAX = 100;

/** One local call the device ran under its lease (business-plans.MCP_ASYNC.13-14). */
export interface LeaseItem {
  actionId: string;
  tool: string;
  kind: string;
  app: string;
  outcome: UsageOutcome;
  latency: LatencyBucket;
  /** Run on the lease's extra budget (past its included slots). */
  extra: boolean;
}

export interface LeaseRequest {
  leaseId: string;
  app: string;
  items: LeaseItem[];
  /** false closes the lease (business-plans.MCP_ASYNC.14). */
  keep: boolean;
}

export interface LeaseGrant {
  id: string;
  /** Totals for this lease id: the device keeps its own used counters. */
  included: number;
  extra: number;
  priceMc: number | null;
  expiresInS: number;
  allowance: number;
  used: number;
}

export type LeaseAnswer =
  | { state: "unknown" }
  | { state: "off"; ttlMs: number; settled: number }
  /** `charge`: the action ids (local:…) answered past the allowance, to charge in the background. */
  | { state: "lease"; lease: LeaseGrant | null; settled: number; charge: string[] };

const METER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meter_allowance (
     id INTEGER PRIMARY KEY CHECK (id = 1), month TEXT NOT NULL, fetched_at INTEGER NOT NULL, ttl_s INTEGER NOT NULL,
     metered INTEGER NOT NULL, plan TEXT, allowance INTEGER, price_mc INTEGER)`,
  `CREATE TABLE IF NOT EXISTS meter_hold (
     action_id TEXT PRIMARY KEY, month TEXT NOT NULL, at INTEGER NOT NULL, path TEXT NOT NULL, conn TEXT NOT NULL,
     app TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL, charged INTEGER NOT NULL DEFAULT 0, past INTEGER NOT NULL DEFAULT 0)`,
  // business-plans.MCP_ASYNC.2 — the last known headroom (min of balance and what is left under the cap), millicents.
  `CREATE TABLE IF NOT EXISTS meter_headroom (id INTEGER PRIMARY KEY CHECK (id = 1), month TEXT NOT NULL, mc INTEGER NOT NULL, at INTEGER NOT NULL)`,
  // business-plans.MCP_ASYNC.8 — actions that ran and whose background charge was refused.
  `CREATE TABLE IF NOT EXISTS meter_uncharged (action_id TEXT PRIMARY KEY, month TEXT NOT NULL, at INTEGER NOT NULL)`,
  // business-plans.MCP_ASYNC.10-15 — local leases: totals granted and used, per lease id.
  `CREATE TABLE IF NOT EXISTS meter_lease (
     lease_id TEXT PRIMARY KEY, month TEXT NOT NULL, at INTEGER NOT NULL, expires_at INTEGER NOT NULL, app TEXT NOT NULL,
     included INTEGER NOT NULL, used INTEGER NOT NULL, extra INTEGER NOT NULL, extra_used INTEGER NOT NULL)`,
  // business-plans.MCP_ASYNC.14 — settled lease calls, so a repeated settle records nothing.
  `CREATE TABLE IF NOT EXISTS meter_settled (action_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
];

interface LeaseRow {
  lease_id: string;
  month: string;
  at: number;
  expires_at: number;
  app: string;
  included: number;
  used: number;
  extra: number;
  extra_used: number;
}

export class MeterStore {
  constructor(private sql: SqlLike) {
    for (const statement of METER_SCHEMA) sql.exec(statement);
    // business-plans.TEST_ACCOUNT.3 — added after the table shipped: an older ledger gets the column once.
    let hasTest = false;
    try {
      hasTest = sql.exec(`PRAGMA table_info(meter_allowance)`).toArray().some((r) => String(r.name) === "test");
    } catch {
      /* no PRAGMA: try the ALTER, which fails harmlessly when the column is there */
    }
    if (!hasTest) {
      try {
        sql.exec(`ALTER TABLE meter_allowance ADD COLUMN test INTEGER NOT NULL DEFAULT 0`);
      } catch {
        /* already there */
      }
    }
  }

  /** business-plans.TEST_ACCOUNT.3 — the last allowance answer this month said test (kept past its ttl for the report). */
  isTest(month: string): boolean {
    const row = this.sql.exec(`SELECT test, month FROM meter_allowance WHERE id = 1`).toArray()[0];
    return !!row && String(row.month) === month && Number(row.test) === 1;
  }

  /** mcp-usage-accounting.COUNT.1 — this month's calls answered without error, both paths. */
  counted(month: string): number {
    const range = monthRange(month);
    if (!range) return 0;
    const row = this.sql
      .exec(
        `SELECT COALESCE(SUM(calls), 0) AS n FROM usage_day WHERE day >= ? AND day < ? AND outcome = 'ok'`,
        dayOf(range.from),
        dayOf(range.to),
      )
      .toArray()[0];
    return Number(row?.n ?? 0);
  }

  /** Running calls: holds, plus (business-plans.MCP_ASYNC.10) the unused included slots of live leases. */
  held(month: string, now = Date.now()): number {
    const row = this.sql.exec(`SELECT COUNT(*) AS n FROM meter_hold WHERE month = ?`, month).toArray()[0];
    const leased = this.sql
      .exec(`SELECT COALESCE(SUM(included - used), 0) AS n FROM meter_lease WHERE month = ? AND expires_at > ? AND included > used`, month, now)
      .toArray()[0];
    return Number(row?.n ?? 0) + Number(leased?.n ?? 0);
  }

  /** business-plans.MCP_ASYNC.2 — the last known headroom this month, or null. */
  headroom(month: string): number | null {
    const row = this.sql.exec(`SELECT mc, month FROM meter_headroom WHERE id = 1`).toArray()[0];
    return row && String(row.month) === month ? Math.max(0, Number(row.mc)) : null;
  }

  setHeadroom(mc: number | null, now: number): void {
    if (mc == null) {
      this.sql.exec(`DELETE FROM meter_headroom WHERE id = 1`);
      return;
    }
    this.sql.exec(
      `INSERT INTO meter_headroom (id, month, mc, at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET month = excluded.month, mc = excluded.mc, at = excluded.at`,
      monthOf(now), Math.max(0, Math.floor(mc)), now,
    );
  }

  /** business-plans.MCP_ASYNC.8 — once per action id. */
  markUncharged(actionId: string, now: number): void {
    this.sql.exec(`INSERT OR IGNORE INTO meter_uncharged (action_id, month, at) VALUES (?, ?, ?)`, actionId, monthOf(now), now);
  }

  uncharged(month: string): number {
    const row = this.sql.exec(`SELECT COUNT(*) AS n FROM meter_uncharged WHERE month = ?`, month).toArray()[0];
    return Number(row?.n ?? 0);
  }

  /** How long the cached allowance still holds (0 when none). */
  private allowanceTtlMs(now: number): number {
    const row = this.sql.exec(`SELECT fetched_at, ttl_s FROM meter_allowance WHERE id = 1`).toArray()[0];
    return row ? Math.max(0, Number(row.fetched_at) + Number(row.ttl_s) * 1000 - now) : 0;
  }

  /** business-plans.MCP_ASYNC.2 — what a session's view is seeded and refreshed from; takes no slot. */
  peek(now: number): Peek {
    const a = this.allowance(now);
    if (!a) return { state: "unknown" };
    if (!a.metered || a.allowance == null) return { state: "off", ttlMs: this.allowanceTtlMs(now) };
    const month = monthOf(now);
    return {
      state: "metered",
      used: this.counted(month) + this.held(month, now),
      allowance: a.allowance,
      priceMc: a.priceMillicents,
      headroomMc: this.headroom(month),
    };
  }

  /** business-plans.MCP_LEDGER.3 — the cached answer, or null when missing, expired or from another month. */
  allowance(now: number): Allowance | null {
    const row = this.sql.exec(`SELECT * FROM meter_allowance WHERE id = 1`).toArray()[0];
    if (!row) return null;
    if (String(row.month) !== monthOf(now)) return null;
    if (now - Number(row.fetched_at) >= Number(row.ttl_s) * 1000) return null;
    return {
      metered: Number(row.metered) === 1,
      plan: row.plan == null ? null : String(row.plan),
      allowance: row.allowance == null ? null : Number(row.allowance),
      priceMillicents: row.price_mc == null ? null : Number(row.price_mc),
      ttlSeconds: Number(row.ttl_s),
      ...(Number(row.test) === 1 ? { test: true } : {}),
    };
  }

  setAllowance(a: Allowance, now: number): void {
    this.sql.exec(
      `INSERT INTO meter_allowance (id, month, fetched_at, ttl_s, metered, plan, allowance, price_mc, test) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET month = excluded.month, fetched_at = excluded.fetched_at, ttl_s = excluded.ttl_s,
         metered = excluded.metered, plan = excluded.plan, allowance = excluded.allowance, price_mc = excluded.price_mc, test = excluded.test`,
      monthOf(now), now, a.ttlSeconds, a.metered ? 1 : 0, a.plan, a.allowance, a.priceMillicents, a.test === true ? 1 : 0,
    );
  }

  private hold(actionId: string): Record<string, unknown> | undefined {
    return this.sql.exec(`SELECT * FROM meter_hold WHERE action_id = ?`, actionId).toArray()[0];
  }

  /**
   * business-plans.MCP_LEDGER.4 — one slot for this call, decided and taken in one go (the caller runs it inside the
   * Durable Object, so two calls never interleave). A repeated action id answers what was decided the first time.
   */
  reserve(input: HoldInput, now: number): Reservation {
    const a = this.allowance(now);
    if (!a) return { state: "unknown" };
    if (!a.metered || a.allowance == null) return { state: "off", ttlMs: this.allowanceTtlMs(now) };
    const month = monthOf(now);
    const existing = this.hold(input.actionId);
    const used = this.counted(month) + this.held(month, now);
    // business-plans.MCP_ASYNC.2 — every answer carries the price and the last known headroom.
    const view = { priceMc: a.priceMillicents, headroomMc: this.headroom(month) };
    if (existing) {
      return Number(existing.past) === 1
        ? { state: "charge", used, allowance: a.allowance, charged: Number(existing.charged) === 1, ...view }
        : { state: "included", used, allowance: a.allowance, ...view };
    }
    const past = used >= a.allowance;
    this.sql.exec(
      `INSERT INTO meter_hold (action_id, month, at, path, conn, app, tool, kind, charged, past) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      input.actionId, month, now, input.path, input.connection, input.app, input.tool, input.kind, past ? 1 : 0,
    );
    return past
      ? { state: "charge", used: used + 1, allowance: a.allowance, charged: false, ...view }
      : { state: "included", used: used + 1, allowance: a.allowance, ...view };
  }

  /** business-plans.MCP_LEDGER.5 — rest-api charged this held call. */
  markCharged(actionId: string): void {
    this.sql.exec(`UPDATE meter_hold SET charged = 1 WHERE action_id = ?`, actionId);
  }

  private leaseRow(leaseId: string): LeaseRow | null {
    const row = this.sql.exec(`SELECT * FROM meter_lease WHERE lease_id = ?`, leaseId).toArray()[0];
    if (!row) return null;
    return {
      lease_id: String(row.lease_id),
      month: String(row.month),
      at: Number(row.at),
      expires_at: Number(row.expires_at),
      app: String(row.app),
      included: Number(row.included),
      used: Number(row.used),
      extra: Number(row.extra),
      extra_used: Number(row.extra_used),
    };
  }

  private saveLease(l: LeaseRow): void {
    this.sql.exec(
      `INSERT INTO meter_lease (lease_id, month, at, expires_at, app, included, used, extra, extra_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (lease_id) DO UPDATE SET month = excluded.month, at = excluded.at, expires_at = excluded.expires_at, app = excluded.app,
         included = excluded.included, used = excluded.used, extra = excluded.extra, extra_used = excluded.extra_used`,
      l.lease_id, l.month, l.at, l.expires_at, l.app, l.included, l.used, l.extra, l.extra_used,
    );
  }

  /**
   * business-plans.MCP_ASYNC.10-15 — one lease request, inside one transaction: the calls the device ran are recorded
   * (each once), the ones answered past the allowance are returned to be charged in the background, then the lease is
   * topped up (or closed with keep false). `add` records cells into the same ledger (LedgerStore.add).
   */
  lease(req: LeaseRequest, now: number, add: (cells: UsageCell[]) => void): LeaseAnswer {
    const a = this.allowance(now);
    if (!a) return { state: "unknown" };
    const month = monthOf(now);
    const metered = a.metered && a.allowance != null;
    const allowance = a.allowance ?? 0;
    let lease = this.leaseRow(req.leaseId);
    if (lease && lease.month !== month) lease = null;
    const live = (l: LeaseRow | null) => !!l && l.expires_at > now;
    const cells: UsageCell[] = [];
    const charge: string[] = [];
    let settled = 0;
    let okSoFar = 0;
    for (const item of req.items) {
      const id = `local:${item.actionId}`;
      if (this.sql.exec(`SELECT 1 AS x FROM meter_settled WHERE action_id = ?`, id).toArray().length) continue;
      this.sql.exec(`INSERT INTO meter_settled (action_id, at) VALUES (?, ?)`, id, now);
      settled++;
      let tookSlot = false;
      if (lease && live(lease) && !item.extra && lease.used < lease.included) {
        lease.used++;
        tookSlot = true;
      } else if (lease && item.extra && lease.extra_used < lease.extra) {
        lease.extra_used++;
      }
      cells.push({
        hour: hourOf(now), path: "local", connection: localConnectionId(item.app), app: item.app, tool: item.tool, kind: item.kind,
        outcome: item.outcome, latency: item.latency, calls: 1, repeats: 0,
      });
      if (item.outcome !== "ok") continue;
      // business-plans.MCP_ASYNC.14 — an answered call that took no included slot is charged when the account is past
      // its allowance at this moment (a slot freed since is used first).
      if (metered && !tookSlot) {
        if (lease) this.saveLease(lease);
        const used = this.counted(month) + okSoFar + this.held(month, now);
        if (used >= allowance) charge.push(id);
      }
      okSoFar++;
    }
    if (cells.length) add(cells);
    if (!metered) {
      this.sql.exec(`DELETE FROM meter_lease WHERE lease_id = ?`, req.leaseId);
      return { state: "off", ttlMs: this.allowanceTtlMs(now), settled };
    }
    if (!req.keep) {
      this.sql.exec(`DELETE FROM meter_lease WHERE lease_id = ?`, req.leaseId);
      return { state: "lease", lease: null, settled, charge };
    }
    // business-plans.MCP_ASYNC.15 — an expired lease gave its unused slots and budget back; it starts again from there.
    if (!lease) lease = { lease_id: req.leaseId, month, at: now, expires_at: now, app: req.app, included: 0, used: 0, extra: 0, extra_used: 0 };
    if (!live(lease)) {
      lease.included = lease.used;
      lease.extra = lease.extra_used;
    }
    lease.at = now;
    lease.expires_at = now + LEASE_TTL_MS;
    lease.app = req.app || lease.app;
    this.saveLease(lease);
    const unused = lease.included - lease.used;
    const usedAll = this.counted(month) + this.held(month, now);
    const pool = Math.max(0, allowance - usedAll);
    const more = Math.max(0, Math.min(LEASE_SLOTS - unused, pool));
    lease.included += more;
    // business-plans.MCP_ASYNC.11 — an extra budget only for the lease holding the last included slots, from the known
    // headroom less every other live lease's unused budget and a margin.
    const price = a.priceMillicents;
    const headroom = this.headroom(month);
    let budget = 0;
    if (pool - more <= 0 && price && headroom != null) {
      const other = this.sql
        .exec(
          `SELECT COALESCE(SUM(extra - extra_used), 0) AS n FROM meter_lease WHERE month = ? AND expires_at > ? AND lease_id != ? AND extra > extra_used`,
          month, now, req.leaseId,
        )
        .toArray()[0];
      budget = Math.max(0, Math.min(LEASE_EXTRA_MAX, Math.floor(headroom / price) - Number(other?.n ?? 0) - LEASE_EXTRA_MARGIN));
    }
    lease.extra = lease.extra_used + budget;
    this.saveLease(lease);
    return {
      state: "lease",
      settled,
      charge,
      lease: {
        id: lease.lease_id,
        included: lease.included,
        extra: lease.extra,
        priceMc: price,
        expiresInS: Math.round(LEASE_TTL_MS / 1000),
        allowance,
        used: this.counted(month) + this.held(month, now),
      },
    };
  }

  /** business-plans.MCP_LEDGER.6-7 — the slot given back (a refused or unreachable charge). */
  drop(actionId: string): { charged: boolean } | null {
    const h = this.hold(actionId);
    if (!h) return null;
    this.sql.exec(`DELETE FROM meter_hold WHERE action_id = ?`, actionId);
    return { charged: Number(h.charged) === 1 };
  }

  /**
   * business-plans.MCP_LEDGER.8, MCP_LEDGER.12 — the call finished: its hold goes away in the same transaction that
   * records its cell, so the count moves from "running" to "counted" (ok) or back down (failed). Returns the hold.
   */
  settle(actionId: string): { charged: boolean; tool: string; kind: string; path: UsagePath; conn: string; app: string } | null {
    const h = this.hold(actionId);
    if (!h) return null;
    this.sql.exec(`DELETE FROM meter_hold WHERE action_id = ?`, actionId);
    return {
      charged: Number(h.charged) === 1,
      tool: String(h.tool),
      kind: String(h.kind),
      path: String(h.path) as UsagePath,
      conn: String(h.conn),
      app: String(h.app),
    };
  }

  /**
   * business-plans.MCP_LEDGER.12 — holds nobody settled within 15 minutes. A local one becomes an answered call of its
   * tool (the device ran it and its settle was lost); a cloud one (the relay lost its own answer) is dropped.
   * Returns the cells to record.
   */
  sweep(now: number): UsageCell[] {
    const stale = this.sql.exec(`SELECT * FROM meter_hold WHERE at < ?`, now - HOLD_STALE_MS).toArray();
    const cells: UsageCell[] = [];
    for (const h of stale) {
      this.sql.exec(`DELETE FROM meter_hold WHERE action_id = ?`, h.action_id);
      if (String(h.path) !== "local" || !isToolName(h.tool)) continue;
      const at = Number(h.at);
      cells.push({
        hour: Math.floor(at / 3_600_000) * 3_600_000,
        path: "local",
        connection: String(h.conn),
        app: String(h.app),
        tool: String(h.tool),
        kind: String(h.kind),
        outcome: "ok",
        latency: ">30s",
        calls: 1,
        repeats: 0,
      });
    }
    return cells;
  }

  prune(now: number): void {
    this.sql.exec(`DELETE FROM meter_hold WHERE at < ?`, now - DAY_MS);
    this.sql.exec(`DELETE FROM meter_lease WHERE expires_at < ?`, now - DAY_MS);
    this.sql.exec(`DELETE FROM meter_settled WHERE at < ?`, now - 40 * DAY_MS);
    this.sql.exec(`DELETE FROM meter_uncharged WHERE at < ?`, now - 400 * DAY_MS);
  }
}

// ─── rest-api (business-plans.MCP_LEDGER.2, .5, .8) ────────────────────

export type ChargeRefusal = "no_credit" | "cap_reached" | "cap_zero" | "overage_off" | "ineligible" | "unavailable";

export type ChargeAnswer =
  /** business-plans.MCP_ASYNC.2 — headroomMc: what is left after this charge (null when rest-api did not say). */
  | { allowed: true; duplicate: boolean; headroomMc?: number | null }
  // business-plans.MCP_LEDGER.18, NOT_ENFORCED.2 — a switch went off after the allowance was cached: nothing is charged
  // or refused, and the account is not metered again until the answer's ttl ends.
  | { allowed: true; off: true; ttlSeconds: number }
  | { allowed: false; reason: ChargeRefusal; headroomMc?: number | null };

/**
 * business-plans.MCP_ASYNC.2 — the headroom a charge answer shows: the smaller of the balance (exact millicents from
 * the worker, else the rounded cents less one cent) and what is left under the monthly cap; null when it says neither.
 */
export function headroomOf(d: any): number | null {
  if (!d || typeof d !== "object") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const balanceMc = num(d.balance_millicents) ?? (num(d.balance_cents) != null ? (num(d.balance_cents)! - 1) * 1000 : null);
  const cap = num(d.cap_cents);
  const spent = num(d.month_spent_millicents);
  const capLeft = cap != null && spent != null ? cap * 1000 - spent : null;
  const parts = [balanceMc, capLeft].filter((v): v is number => v != null);
  return parts.length ? Math.max(0, Math.min(...parts)) : null;
}

export interface MeterRestEnv {
  INTERNAL_API_BASE_URL: string;
  INTERNAL_API_KEY: string;
}

const REFUSALS: readonly ChargeRefusal[] = ["no_credit", "cap_reached", "cap_zero", "overage_off", "ineligible"];

async function restPost(env: MeterRestEnv, path: string, body: unknown, fetchImpl: typeof fetch): Promise<{ status: number; data: any } | null> {
  if (!env.INTERNAL_API_BASE_URL || !env.INTERNAL_API_KEY) return null;
  try {
    const res = await fetchImpl(`${env.INTERNAL_API_BASE_URL.replace(/\/$/, "")}/__internal/mcp-ledger/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": env.INTERNAL_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

/** business-plans.MCP_LEDGER.2 — the account's allowance from rest-api, or null when it cannot answer. */
export async function fetchAllowance(env: MeterRestEnv, phone: string, fetchImpl: typeof fetch = fetch): Promise<Allowance | null> {
  const r = await restPost(env, "allowance", { phone }, fetchImpl);
  if (!r || r.status !== 200 || !r.data || typeof r.data.metered !== "boolean") return null;
  const d = r.data;
  const whole = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
  const allowance = whole(d.allowance, 0, 10_000_000) ? d.allowance : null;
  return {
    metered: d.metered === true && allowance !== null,
    plan: typeof d.plan === "string" ? d.plan : null,
    allowance,
    priceMillicents: whole(d.price_millicents, 1, 1_000_000) ? d.price_millicents : null,
    ttlSeconds: whole(d.ttl_seconds, 30, 86_400) ? d.ttl_seconds : DEFAULT_ALLOWANCE_TTL_S,
    ...(d.test === true ? { test: true } : {}),
  };
}

/** business-plans.MCP_LEDGER.5-7 — one charge; anything but a clear answer is "unavailable" (fails closed). */
export async function chargeAction(env: MeterRestEnv, phone: string, actionId: string, fetchImpl: typeof fetch = fetch): Promise<ChargeAnswer> {
  const r = await restPost(env, "charge", { phone, actionId }, fetchImpl);
  if (r?.status === 200 && r.data?.allowed === true && r.data.metered === false) {
    const ttl = r.data.ttl_seconds;
    return { allowed: true, off: true, ttlSeconds: typeof ttl === "number" && Number.isInteger(ttl) && ttl >= 30 && ttl <= 86_400 ? ttl : DEFAULT_ALLOWANCE_TTL_S };
  }
  if (r?.status === 200 && r.data?.allowed === true) return { allowed: true, duplicate: r.data.duplicate === true, headroomMc: headroomOf(r.data) };
  const reason = r?.data?.reason ?? r?.data?.error;
  if (r && r.status >= 400 && r.status < 500 && REFUSALS.includes(reason)) {
    // business-plans.MCP_ASYNC.6 — a known refusal: nothing more can be charged until something changes.
    return { allowed: false, reason, headroomMc: ["no_credit", "cap_reached", "cap_zero"].includes(reason) ? 0 : null };
  }
  return { allowed: false, reason: "unavailable" };
}

/** business-plans.MCP_LEDGER.8 — gives a failed call's charge back (keyed by the action id, so once). */
export async function releaseCharge(env: MeterRestEnv, phone: string, actionId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const r = await restPost(env, "release", { phone, actionId }, fetchImpl);
  return r?.status === 200;
}

// ─── The decision for one call ─────────────────────────────────────────

/** The parts of UsageLedger the flow needs (a Durable Object stub in the worker, a plain object in tests). */
export interface MeterLedger {
  meterReserve(input: HoldInput, now: number): Promise<Reservation>;
  meterSetAllowance(a: Allowance, now: number): Promise<void>;
  /** business-plans.MCP_ASYNC.2 — with the headroom the charge answer showed (undefined: leave it). */
  meterCharged(actionId: string, headroomMc?: number | null): Promise<void>;
  meterDrop(actionId: string, headroomMc?: number | null): Promise<{ charged: boolean } | null>;
}

/** The parts of UsageLedger the asynchronous paths need besides MeterLedger (business-plans.MCP_ASYNC). */
export interface AsyncMeterLedger extends MeterLedger {
  meterPeek(now: number): Promise<Peek>;
  meterLease(req: LeaseRequest, now: number): Promise<LeaseAnswer>;
  /** After a background charge: the headroom it showed and, refused, the action kept as uncharged. */
  meterAfterCharge(actionId: string, headroomMc: number | null | undefined, uncharged: boolean): Promise<void>;
  record(
    cells: UsageCell[],
    options?: { batchId?: string; accountTag?: string; settle?: string; uncharged?: string },
  ): Promise<{ accepted: number; duplicate: boolean; settled?: { charged: boolean } | null }>;
}

export type MeterDecision =
  /** ttlSeconds: how long "not metered" holds when the ledger knows it. */
  | { metered: false; ttlSeconds?: number }
  | { metered: true; allowed: true; charged: boolean; used: number; allowance: number; priceMc?: number | null; headroomMc?: number | null }
  | { metered: true; allowed: false; reason: ChargeRefusal; allowance: number; used?: number; headroomMc?: number | null };

/**
 * business-plans.MCP_LEDGER.2-7 — reserve a slot for one call in the account's ledger, asking rest-api for the
 * allowance when the ledger has none and for the charge when the call is past it. `phone` is asked only when needed;
 * without one nothing is metered (MCP_LEDGER.16). rest-api unable to say the allowance: not metered (the gate fails
 * open only on the allowance lookup; a charge it cannot make refuses the call).
 */
export async function meterCall(
  env: MeterRestEnv,
  ledger: MeterLedger,
  input: HoldInput,
  phone: () => Promise<string | null>,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<MeterDecision> {
  let known: string | null | undefined;
  const phoneOnce = async () => (known === undefined ? (known = await phone().catch(() => null)) : known);
  let r = await ledger.meterReserve(input, now);
  if (r.state === "unknown") {
    const p = await phoneOnce();
    if (!p) return { metered: false };
    const a = await fetchAllowance(env, p, fetchImpl);
    if (!a) return { metered: false };
    await ledger.meterSetAllowance(a, now);
    r = await ledger.meterReserve(input, now);
  }
  if (r.state === "unknown") return { metered: false };
  if (r.state === "off") return r.ttlMs ? { metered: false, ttlSeconds: Math.max(1, Math.round(r.ttlMs / 1000)) } : { metered: false };
  const view = { priceMc: r.priceMc ?? null, headroomMc: r.headroomMc ?? null };
  if (r.state === "included") return { metered: true, allowed: true, charged: false, used: r.used, allowance: r.allowance, ...view };
  if (r.charged) return { metered: true, allowed: true, charged: true, used: r.used, allowance: r.allowance, ...view };
  const p = await phoneOnce();
  const answer: ChargeAnswer = p ? await chargeAction(env, p, input.actionId, fetchImpl) : { allowed: false, reason: "unavailable" };
  if (answer.allowed && "off" in answer) {
    await ledger.meterDrop(input.actionId);
    await ledger.meterSetAllowance({ metered: false, plan: null, allowance: null, priceMillicents: null, ttlSeconds: answer.ttlSeconds }, now);
    return { metered: false, ttlSeconds: answer.ttlSeconds };
  }
  if (answer.allowed) {
    await ledger.meterCharged(input.actionId, answer.headroomMc);
    return { metered: true, allowed: true, charged: true, used: r.used, allowance: r.allowance, priceMc: view.priceMc, headroomMc: answer.headroomMc ?? view.headroomMc };
  }
  await ledger.meterDrop(input.actionId, answer.headroomMc);
  return { metered: true, allowed: false, reason: answer.reason, allowance: r.allowance, used: r.used - 1, headroomMc: answer.headroomMc ?? null };
}

/** JSON-RPC code of a plan refusal — the code the extension already answers and every client understands. */
export const REFUSED_CODE = -32003;

/** business-plans.MCP_LEDGER.6-7, MCP_PAY.5-6 — what the assistant reads when the relay refuses an extra action. */
export function meterRefusalText(reason: ChargeRefusal, allowance: number): string {
  const used = `You've used the ${allowance.toLocaleString("en-US")} Claude and ChatGPT actions your Kaption plan includes this month.`;
  const buy = "Tell the user to open Kaption on WhatsApp Web, Your Plan → Kaption credits, to buy more credit or turn on \"Keep going past my plan\".";
  switch (reason) {
    case "no_credit":
      return `${used} There is no Kaption credit left for extra actions. ${buy} The count starts again on the 1st (UTC).`;
    case "cap_reached":
      return `${used} The monthly limit for extra actions is reached. Tell the user they can raise it in Kaption on WhatsApp Web, Your Plan → Kaption credits. The count starts again on the 1st (UTC).`;
    case "cap_zero":
      return `${used} Extra actions are turned off. Tell the user to turn on "Keep going past my plan" in Kaption on WhatsApp Web, Your Plan → Kaption credits. The count starts again on the 1st (UTC).`;
    case "overage_off":
    case "ineligible":
      return `${used} Extra actions are not available on this account. The count starts again on the 1st (UTC).`;
    default:
      return "Kaption could not check this account's Claude and ChatGPT actions just now. Try again in a minute.";
  }
}

// ─── Metering without waiting (business-plans.MCP_ASYNC) ───────────────

/** business-plans.MCP_ASYNC.5, business-plans.MCP_ASYNC.7 — calls of one session that may run before their reservation answered. */
export const FAST_IN_FLIGHT_MAX = 4;
/** business-plans.MCP_ASYNC.3-4 — slots (or prices) kept in hand before a call runs without waiting. */
export const FAST_MARGIN = 4;
/** A "not metered" view the ledger could not date (no phone, rest-api down) is asked again this soon. */
const UNKNOWN_OFF_MS = 30_000;

/** business-plans.MCP_ASYNC.2 — a session's view of its account's ledger. */
export interface MeterView {
  month: string;
  metered: boolean;
  /** Not metered: until when (epoch ms) that answer holds. */
  until: number;
  allowance: number;
  used: number;
  priceMc: number | null;
  headroomMc: number | null;
}

/** What the gate decided for one cloud call. */
export interface CloudGate {
  actionId: string;
  /** Mark the call metered for the extension (business-plans.MCP_LEDGER.9). */
  metered: boolean;
  /** A known refusal: answer it, do not relay (business-plans.MCP_ASYNC.6). */
  refusal: { reason: ChargeRefusal; allowance: number } | null;
  /** Relayed before its reservation answered (business-plans.MCP_ASYNC.3-4). */
  fast: boolean;
  /** How long the gate held the call, ms (business-plans.MCP_ASYNC.17). */
  waitedMs: number;
  /** The reservation; already answered when the gate waited for it. */
  decision: Promise<MeterDecision>;
}

export interface CloudMeterDeps {
  env: MeterRestEnv;
  ledger: () => AsyncMeterLedger;
  phone: () => Promise<string | null>;
  now?: () => number;
  fetch?: typeof fetch;
  /** Keeps background work alive (the Durable Object's waitUntil). */
  background?: (p: Promise<unknown>) => void;
}

/**
 * business-plans.MCP_ASYNC.2-9 — one relay session's meter. The ledger stays the authority (every call still takes
 * its slot there and is charged there, keyed by its action id); the view only decides whether the call has to wait.
 */
export class CloudMeter {
  view: MeterView | null = null;
  inFlight = 0;
  private seeding: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private lastPhone: string | null = null;

  constructor(private deps: CloudMeterDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async phone(): Promise<string | null> {
    const p = await this.deps.phone().catch(() => null);
    if (p) this.lastPhone = p;
    return p;
  }

  /** business-plans.MCP_ASYNC.2 — seeds the view at session start, in the background. */
  seed(): Promise<void> {
    if (!this.seeding) {
      this.seeding = this.refresh().catch((e) => console.error("[meter] seed failed:", e instanceof Error ? e.message : e));
      this.deps.background?.(this.seeding);
    }
    return this.seeding;
  }

  private async refresh(): Promise<void> {
    const ledger = this.deps.ledger();
    const now = this.now();
    let p = await ledger.meterPeek(now);
    if (p.state === "unknown") {
      const phone = await this.phone();
      if (!phone) return;
      const a = await fetchAllowance(this.deps.env, phone, this.deps.fetch ?? fetch);
      if (!a) return;
      await ledger.meterSetAllowance(a, now);
      p = await ledger.meterPeek(now);
    }
    const month = monthOf(now);
    if (p.state === "off") this.view = { month, metered: false, until: now + (p.ttlMs || UNKNOWN_OFF_MS), allowance: 0, used: 0, priceMc: null, headroomMc: null };
    else if (p.state === "metered") this.view = { month, metered: true, until: 0, allowance: p.allowance, used: p.used, priceMc: p.priceMc, headroomMc: p.headroomMc };
  }

  /** business-plans.MCP_ASYNC.1 — a dated "not metered" view refreshes in the background, never holding a call. */
  private refreshSoon(): void {
    if (this.refreshing) return;
    this.refreshing = this.refresh()
      .catch(() => undefined)
      .finally(() => (this.refreshing = null));
    this.deps.background?.(this.refreshing);
  }

  /** business-plans.MCP_ASYNC.3-5 — may this call run before its reservation answers? */
  private canRunNow(v: MeterView): boolean {
    if (this.inFlight >= FAST_IN_FLIGHT_MAX) return false;
    const projected = v.used + this.inFlight + 1;
    if (projected + FAST_MARGIN <= v.allowance) return true;
    return v.priceMc != null && v.priceMc > 0 && v.headroomMc != null && v.headroomMc >= (this.inFlight + 1 + FAST_MARGIN) * v.priceMc;
  }

  private learn(d: MeterDecision, now: number): void {
    const month = monthOf(now);
    if (!d.metered) {
      this.view = { month, metered: false, until: now + (d.ttlSeconds ? d.ttlSeconds * 1000 : UNKNOWN_OFF_MS), allowance: 0, used: 0, priceMc: null, headroomMc: null };
      return;
    }
    const prev = this.view && this.view.month === month && this.view.metered ? this.view : null;
    if (d.allowed) {
      this.view = {
        month, metered: true, until: 0, allowance: d.allowance, used: d.used,
        priceMc: d.priceMc ?? prev?.priceMc ?? null,
        headroomMc: d.headroomMc !== undefined ? d.headroomMc : prev?.headroomMc ?? null,
      };
    } else {
      // business-plans.MCP_ASYNC.6 — a refusal: the next extra action waits (headroom 0, or unknown after "try again").
      this.view = {
        month, metered: true, until: 0, allowance: d.allowance, used: Math.max(d.used ?? 0, prev?.used ?? 0, d.allowance),
        priceMc: prev?.priceMc ?? null, headroomMc: d.headroomMc ?? null,
      };
    }
  }

  private async reserve(input: HoldInput): Promise<MeterDecision> {
    const now = this.now();
    try {
      const d = await meterCall(this.deps.env, this.deps.ledger(), input, () => this.phone(), now, this.deps.fetch ?? fetch);
      this.learn(d, now);
      return d;
    } catch (error) {
      console.error("[meter] reserve failed:", error instanceof Error ? error.message : error);
      return { metered: false };
    }
  }

  /** business-plans.MCP_ASYNC.3-6 — the gate for one cloud call. */
  async begin(input: HoldInput): Promise<CloudGate> {
    const started = this.now();
    const month = monthOf(started);
    const waited = () => Math.max(0, this.now() - started);
    if (!this.view && this.seeding) await this.seeding;
    const v = this.view && this.view.month === month ? this.view : null;
    if (v && !v.metered) {
      if (started >= v.until) this.refreshSoon();
      return { actionId: input.actionId, metered: false, refusal: null, fast: false, waitedMs: waited(), decision: Promise.resolve({ metered: false }) };
    }
    if (v && this.canRunNow(v)) {
      this.inFlight++;
      const decision = this.reserve(input).finally(() => this.inFlight--);
      this.deps.background?.(decision);
      return { actionId: input.actionId, metered: true, refusal: null, fast: true, waitedMs: waited(), decision };
    }
    // business-plans.MCP_ASYNC.5 — no view, the month changed, or the headroom does not clearly cover it: wait.
    const d = await this.reserve(input);
    return {
      actionId: input.actionId,
      metered: d.metered,
      refusal: d.metered && !d.allowed ? { reason: d.reason, allowance: d.allowance } : null,
      fast: false,
      waitedMs: waited(),
      decision: Promise.resolve(d),
    };
  }

  /**
   * business-plans.MCP_ASYNC.8-9, MCP_LEDGER.8 — records the call once its reservation is known: a held call settles
   * its hold in the same transaction (a failed charged one is credited back once); a call that ran and whose charge
   * was refused afterwards counts and is kept as uncharged.
   */
  async finish(gate: CloudGate, cell: UsageCell, accountTag: string): Promise<{ charged: boolean; uncharged: boolean }> {
    const d = await gate.decision;
    const ledger = this.deps.ledger();
    if (d.metered && d.allowed) {
      const recorded = await ledger.record([cell], { accountTag, settle: gate.actionId });
      if (cell.outcome !== "ok" && recorded.settled?.charged) {
        const phone = this.lastPhone ?? (await this.phone());
        if (!phone || !(await releaseCharge(this.deps.env, phone, gate.actionId, this.deps.fetch ?? fetch))) {
          console.error("[meter] release failed for a charged call that failed");
        }
        return { charged: false, uncharged: false };
      }
      return { charged: !!recorded.settled?.charged, uncharged: false };
    }
    const uncharged = d.metered && !d.allowed && gate.fast && cell.outcome === "ok";
    await ledger.record([cell], { accountTag, ...(uncharged ? { uncharged: gate.actionId } : {}) });
    return { charged: false, uncharged };
  }
}

// ─── The local bridge's lease (business-plans.MCP_ASYNC.10-15) ─────────

export type LeaseDecision =
  | { metered: false; ttlSeconds: number; settled: number }
  | { metered: true; lease: LeaseGrant | null; settled: number; charging: Promise<void> }
  /** The allowance could not be learned: nothing was recorded, the device keeps its settles. */
  | { unavailable: true };

/**
 * business-plans.MCP_ASYNC.10-15 — one lease request: records the settled calls and tops the lease up in the ledger,
 * then charges the answered calls past the allowance in the background (keyed local:{actionId}, once).
 */
export async function leaseCall(
  env: MeterRestEnv,
  ledger: AsyncMeterLedger,
  req: LeaseRequest,
  phone: () => Promise<string | null>,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<LeaseDecision> {
  let r = await ledger.meterLease(req, now);
  if (r.state === "unknown") {
    const p = await phone().catch(() => null);
    const a = p ? await fetchAllowance(env, p, fetchImpl) : null;
    if (!a) return { unavailable: true };
    await ledger.meterSetAllowance(a, now);
    r = await ledger.meterLease(req, now);
  }
  if (r.state === "unknown") return { unavailable: true };
  if (r.state === "off") return { metered: false, ttlSeconds: Math.max(1, Math.round((r.ttlMs || DEFAULT_ALLOWANCE_TTL_S * 1000) / 1000)), settled: r.settled };
  const ids = r.charge;
  const charging = ids.length ? chargeInBackground(env, ledger, ids, phone, fetchImpl) : Promise.resolve();
  return { metered: true, lease: r.lease, settled: r.settled, charging };
}

/** business-plans.MCP_ASYNC.4, .8, .14 — background charges; a refused one is kept as uncharged. */
export async function chargeInBackground(
  env: MeterRestEnv,
  ledger: AsyncMeterLedger,
  actionIds: string[],
  phone: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const p = await phone().catch(() => null);
  for (const id of actionIds) {
    try {
      const answer: ChargeAnswer = p ? await chargeAction(env, p, id, fetchImpl) : { allowed: false, reason: "unavailable" };
      if (answer.allowed && "off" in answer) continue;
      await ledger.meterAfterCharge(id, answer.headroomMc, !answer.allowed);
    } catch (error) {
      console.error("[meter] background charge failed:", error instanceof Error ? error.message : error);
    }
  }
}
