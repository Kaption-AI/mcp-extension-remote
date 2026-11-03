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
import { DAY_MS, dayOf, isToolName, monthOf, monthRange, type UsageCell, type UsagePath } from "./usage";
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
  /** Not metered: nothing held, the call runs as before. */
  | { state: "off" }
  /** Held, within the allowance. */
  | { state: "included"; used: number; allowance: number }
  /** Held, past the allowance: charge it before it runs. */
  | { state: "charge"; used: number; allowance: number; charged: boolean };

const METER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meter_allowance (
     id INTEGER PRIMARY KEY CHECK (id = 1), month TEXT NOT NULL, fetched_at INTEGER NOT NULL, ttl_s INTEGER NOT NULL,
     metered INTEGER NOT NULL, plan TEXT, allowance INTEGER, price_mc INTEGER)`,
  `CREATE TABLE IF NOT EXISTS meter_hold (
     action_id TEXT PRIMARY KEY, month TEXT NOT NULL, at INTEGER NOT NULL, path TEXT NOT NULL, conn TEXT NOT NULL,
     app TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL, charged INTEGER NOT NULL DEFAULT 0, past INTEGER NOT NULL DEFAULT 0)`,
];

export class MeterStore {
  constructor(private sql: SqlLike) {
    for (const statement of METER_SCHEMA) sql.exec(statement);
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

  held(month: string): number {
    const row = this.sql.exec(`SELECT COUNT(*) AS n FROM meter_hold WHERE month = ?`, month).toArray()[0];
    return Number(row?.n ?? 0);
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
    };
  }

  setAllowance(a: Allowance, now: number): void {
    this.sql.exec(
      `INSERT INTO meter_allowance (id, month, fetched_at, ttl_s, metered, plan, allowance, price_mc) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET month = excluded.month, fetched_at = excluded.fetched_at, ttl_s = excluded.ttl_s,
         metered = excluded.metered, plan = excluded.plan, allowance = excluded.allowance, price_mc = excluded.price_mc`,
      monthOf(now), now, a.ttlSeconds, a.metered ? 1 : 0, a.plan, a.allowance, a.priceMillicents,
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
    if (!a.metered || a.allowance == null) return { state: "off" };
    const month = monthOf(now);
    const existing = this.hold(input.actionId);
    const used = this.counted(month) + this.held(month);
    if (existing) {
      return Number(existing.past) === 1
        ? { state: "charge", used, allowance: a.allowance, charged: Number(existing.charged) === 1 }
        : { state: "included", used, allowance: a.allowance };
    }
    const past = used >= a.allowance;
    this.sql.exec(
      `INSERT INTO meter_hold (action_id, month, at, path, conn, app, tool, kind, charged, past) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      input.actionId, month, now, input.path, input.connection, input.app, input.tool, input.kind, past ? 1 : 0,
    );
    return past ? { state: "charge", used: used + 1, allowance: a.allowance, charged: false } : { state: "included", used: used + 1, allowance: a.allowance };
  }

  /** business-plans.MCP_LEDGER.5 — rest-api charged this held call. */
  markCharged(actionId: string): void {
    this.sql.exec(`UPDATE meter_hold SET charged = 1 WHERE action_id = ?`, actionId);
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
  }
}

// ─── rest-api (business-plans.MCP_LEDGER.2, .5, .8) ────────────────────

export type ChargeRefusal = "no_credit" | "cap_reached" | "cap_zero" | "overage_off" | "ineligible" | "unavailable";

export type ChargeAnswer =
  | { allowed: true; duplicate: boolean }
  // business-plans.MCP_LEDGER.18, NOT_ENFORCED.2 — a switch went off after the allowance was cached: nothing is charged
  // or refused, and the account is not metered again until the answer's ttl ends.
  | { allowed: true; off: true; ttlSeconds: number }
  | { allowed: false; reason: ChargeRefusal };

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
  };
}

/** business-plans.MCP_LEDGER.5-7 — one charge; anything but a clear answer is "unavailable" (fails closed). */
export async function chargeAction(env: MeterRestEnv, phone: string, actionId: string, fetchImpl: typeof fetch = fetch): Promise<ChargeAnswer> {
  const r = await restPost(env, "charge", { phone, actionId }, fetchImpl);
  if (r?.status === 200 && r.data?.allowed === true && r.data.metered === false) {
    const ttl = r.data.ttl_seconds;
    return { allowed: true, off: true, ttlSeconds: typeof ttl === "number" && Number.isInteger(ttl) && ttl >= 30 && ttl <= 86_400 ? ttl : DEFAULT_ALLOWANCE_TTL_S };
  }
  if (r?.status === 200 && r.data?.allowed === true) return { allowed: true, duplicate: r.data.duplicate === true };
  const reason = r?.data?.reason ?? r?.data?.error;
  if (r && r.status >= 400 && r.status < 500 && REFUSALS.includes(reason)) return { allowed: false, reason };
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
  meterCharged(actionId: string): Promise<void>;
  meterDrop(actionId: string): Promise<{ charged: boolean } | null>;
}

export type MeterDecision =
  | { metered: false }
  | { metered: true; allowed: true; charged: boolean; used: number; allowance: number }
  | { metered: true; allowed: false; reason: ChargeRefusal; allowance: number };

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
  if (r.state === "unknown" || r.state === "off") return { metered: false };
  if (r.state === "included") return { metered: true, allowed: true, charged: false, used: r.used, allowance: r.allowance };
  if (r.charged) return { metered: true, allowed: true, charged: true, used: r.used, allowance: r.allowance };
  const p = await phoneOnce();
  const answer: ChargeAnswer = p ? await chargeAction(env, p, input.actionId, fetchImpl) : { allowed: false, reason: "unavailable" };
  if (answer.allowed && "off" in answer) {
    await ledger.meterDrop(input.actionId);
    await ledger.meterSetAllowance({ metered: false, plan: null, allowance: null, priceMillicents: null, ttlSeconds: answer.ttlSeconds }, now);
    return { metered: false };
  }
  if (answer.allowed) {
    await ledger.meterCharged(input.actionId);
    return { metered: true, allowed: true, charged: true, used: r.used, allowance: r.allowance };
  }
  await ledger.meterDrop(input.actionId);
  return { metered: true, allowed: false, reason: answer.reason, allowance: r.allowance };
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
