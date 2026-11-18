/**
 * Claude and ChatGPT overage paid at the end of the cycle (kaptionai features/mcp/mcp-overage-billing.feature.yaml).
 *
 * rest-api's plan answer carries `overage` only for an account that turned "Keep going past my plan" on (and is
 * eligible). The ledger then lets an action past the plan's allowance run while the cycle's overage stays within the
 * cap, recording it here (one row per action id); rest-api reads a cycle's billable total after the cycle ended and
 * bills it once, claiming the cycle here first (mcp-overage-billing.LEDGER.7-8). No phone is stored (PRIVACY.2).
 *
 * OverageStore is the storage logic (no Durable Object runtime, so tests run it on node:sqlite).
 */
import { DAY_MS } from "./usage";
import type { SqlLike } from "./usage-ledger";

/** What the plan answer says about postpaid overage (null: off). */
export interface PlanOverage {
  /** Price of one extra action, millicents (Pro 1000 = US$0.01, Business 500, Lifetime 1250). */
  priceMc: number;
  /** The monthly cap, millicents (> 0). */
  capMc: number;
  /** mcp-overage-billing.CYCLE.1-4 — the cycle anchor, epoch ms (UTC). */
  anchorMs: number;
  /** The refusal words past the cap (rest-api's, the plans link inside), or null. */
  message: string | null;
}

/** mcp-overage-billing.LEDGER.9 */
export const OVERAGE_RETENTION_DAYS = 400;
/** mcp-overage-billing.LEDGER.8 — a claim nobody finished is given back after this long. */
export const BILL_CLAIM_STALE_MS = 30 * 60_000;

const whole = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** rest-api's `overage` block read defensively; null when absent or not one. */
export function parseOverage(v: unknown): PlanOverage | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!whole(o.price_millicents, 1, 1_000_000) || !whole(o.cap_millicents, 1, 100_000_000) || !whole(o.anchor_ms, 0, 8_640_000_000_000)) return null;
  const message = typeof o.message === "string" && o.message.trim() ? o.message.slice(0, 2000) : null;
  return { priceMc: o.price_millicents, capMc: o.cap_millicents, anchorMs: o.anchor_ms, message };
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The anchor's day and time of day placed in month (y, m), clamped to the month's last day (CYCLE.3). */
function placed(anchor: Date, y: number, m: number): number {
  const day = Math.min(anchor.getUTCDate(), daysIn(y, m));
  return Date.UTC(y, m, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds());
}

/**
 * mcp-overage-billing.CYCLE.1-4 — the monthly cycle holding `at`, anchored on the anchor's day of the month and time of
 * day (UTC). Kept identical to rest-api's src/services/mcpOverage/cycle.ts (the shared fixture is replayed in both).
 */
export function overageCycle(anchorMs: number, at: number): { from: number; to: number } {
  const anchor = new Date(anchorMs);
  const now = new Date(at);
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  let from = placed(anchor, y, m);
  if (from > at) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
    from = placed(anchor, y, m);
  }
  const ny = m === 11 ? y + 1 : y;
  const nm = (m + 1) % 12;
  return { from, to: placed(anchor, ny, nm) };
}

export interface CycleOverage {
  from: number;
  to: number;
  /** Recorded (answered) overage actions: what is billed (LEDGER.7). */
  calls: number;
  amountMc: number;
  /** Reserved, not recorded yet (never billed if they never are). */
  pending: number;
  pendingMc: number;
  /** The largest cap in force for an action of this cycle (BILL.2), millicents; 0 when none. */
  capMc: number;
  /** Amounts carried from earlier cycles below Stripe's minimum (BILL.5), millicents. */
  carriedMc: number;
  bill: BillMark | null;
}

export type BillState = "claimed" | "billed" | "carried" | "carried_billed" | "none" | "failed";

export interface BillMark {
  from: number;
  to: number;
  state: BillState;
  at: number;
  amountMc: number;
  calls: number;
  invoice: string | null;
}

const SCHEMA = [
  // mcp-overage-billing.LEDGER.2, LEDGER.4 — live: 1 reserved, 2 recorded (answered), 0 given back.
  `CREATE TABLE IF NOT EXISTS overage_call (id TEXT PRIMARY KEY, at INTEGER NOT NULL, price_mc INTEGER NOT NULL, cap_mc INTEGER NOT NULL, live INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS overage_call_at ON overage_call (at)`,
  // mcp-overage-billing.LEDGER.8, BILL.5 — one mark per cycle.
  `CREATE TABLE IF NOT EXISTS overage_bill (cycle_from INTEGER PRIMARY KEY, cycle_to INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL,
     amount_mc INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, invoice TEXT)`,
];

const markOf = (r: Record<string, unknown> | undefined): BillMark | null =>
  r
    ? {
        from: Number(r.cycle_from), to: Number(r.cycle_to), state: String(r.state) as BillState, at: Number(r.at),
        amountMc: Number(r.amount_mc), calls: Number(r.calls), invoice: r.invoice == null ? null : String(r.invoice),
      }
    : null;

export class OverageStore {
  constructor(private sql: SqlLike) {
    for (const s of SCHEMA) sql.exec(s);
  }

  /** mcp-overage-billing.LEDGER.2-3 — overage already spent (reserved or recorded) in the cycle, millicents. */
  spentMc(range: { from: number; to: number }): number {
    const r = this.sql.exec(`SELECT COALESCE(SUM(price_mc), 0) AS mc FROM overage_call WHERE live > 0 AND at >= ? AND at < ?`, range.from, range.to).toArray()[0];
    return Number(r?.mc ?? 0);
  }

  /**
   * mcp-overage-billing.LEDGER.2-3 — can `n` more extra actions run now? Within the cap of the cycle holding `now`.
   * The caller runs it inside the reservation's transaction.
   */
  room(o: PlanOverage, n: number, now: number): boolean {
    if (n <= 0) return true;
    const cycle = overageCycle(o.anchorMs, now);
    return this.spentMc(cycle) + n * o.priceMc <= o.capMc;
  }

  /** mcp-overage-billing.LEDGER.2, LEDGER.5 — records these action ids as extra actions (a known id is left as it is). */
  add(ids: string[], o: PlanOverage, now: number): void {
    for (const id of ids) {
      this.sql.exec(
        `INSERT INTO overage_call (id, at, price_mc, cap_mc, live) VALUES (?, ?, ?, ?, 1) ON CONFLICT (id) DO NOTHING`,
        id, now, o.priceMc, o.capMc,
      );
    }
  }

  /** mcp-overage-billing.LEDGER.4 — a given-back reservation is never billed. */
  refund(id: string): void {
    this.sql.exec(`UPDATE overage_call SET live = 0 WHERE id = ?`, id);
  }

  /** The action was answered and recorded: billable. */
  settle(id: string): void {
    this.sql.exec(`UPDATE overage_call SET live = 2 WHERE id = ? AND live = 1`, id);
  }

  /** A device batch recorded every call of its road made before `now` (mcp-usage-ledger.SINGLE.2). */
  settleRoad(path: string, now: number): void {
    this.sql.exec(`UPDATE overage_call SET live = 2 WHERE live = 1 AND at <= ? AND id LIKE ?`, now, `${path}:%`);
  }

  bill(from: number): BillMark | null {
    return markOf(this.sql.exec(`SELECT * FROM overage_bill WHERE cycle_from = ?`, from).toArray()[0]);
  }

  /** mcp-overage-billing.LEDGER.7, BILL.2, BILL.5 — the cycle's numbers (read only). */
  cycle(range: { from: number; to: number }): CycleOverage {
    const rows = this.sql
      .exec(
        `SELECT live, COUNT(*) AS n, COALESCE(SUM(price_mc), 0) AS mc, COALESCE(MAX(cap_mc), 0) AS cap FROM overage_call
         WHERE live > 0 AND at >= ? AND at < ? GROUP BY live`,
        range.from, range.to,
      )
      .toArray();
    const out: CycleOverage = { from: range.from, to: range.to, calls: 0, amountMc: 0, pending: 0, pendingMc: 0, capMc: 0, carriedMc: 0, bill: this.bill(range.from) };
    for (const r of rows) {
      out.capMc = Math.max(out.capMc, Number(r.cap));
      if (Number(r.live) === 2) {
        out.calls = Number(r.n);
        out.amountMc = Number(r.mc);
      } else {
        out.pending = Number(r.n);
        out.pendingMc = Number(r.mc);
      }
    }
    const carried = this.sql
      .exec(`SELECT COALESCE(SUM(amount_mc), 0) AS mc FROM overage_bill WHERE state = 'carried' AND cycle_from < ?`, range.from)
      .toArray()[0];
    out.carriedMc = Number(carried?.mc ?? 0);
    return out;
  }

  /**
   * mcp-overage-billing.LEDGER.8 — claim a cycle for billing: true once (again only after a stale claim or a failure).
   * The caller runs it inside one transaction.
   */
  claim(range: { from: number; to: number }, now: number): { ok: boolean; mark: BillMark | null } {
    const mark = this.bill(range.from);
    const reclaim = mark && (mark.state === "failed" || (mark.state === "claimed" && now - mark.at >= BILL_CLAIM_STALE_MS));
    if (mark && !reclaim) return { ok: false, mark };
    this.sql.exec(
      `INSERT INTO overage_bill (cycle_from, cycle_to, state, at) VALUES (?, ?, 'claimed', ?)
       ON CONFLICT (cycle_from) DO UPDATE SET state = 'claimed', at = excluded.at`,
      range.from, range.to, now,
    );
    return { ok: true, mark: this.bill(range.from) };
  }

  /**
   * mcp-overage-billing.BILL.5-7, BILL.9 — the claimed cycle's outcome. Billed: the earlier carried amounts went on this
   * bill too. Only a claimed cycle can be finished.
   */
  finish(from: number, state: "billed" | "carried" | "none" | "failed", detail: { amountMc?: number; calls?: number; invoice?: string | null }, now: number): BillMark | null {
    const mark = this.bill(from);
    if (!mark || mark.state !== "claimed") return mark;
    this.sql.exec(
      `UPDATE overage_bill SET state = ?, at = ?, amount_mc = ?, calls = ?, invoice = ? WHERE cycle_from = ?`,
      state, now, Math.max(0, Math.floor(detail.amountMc ?? 0)), Math.max(0, Math.floor(detail.calls ?? 0)), detail.invoice ?? null, from,
    );
    if (state === "billed") this.sql.exec(`UPDATE overage_bill SET state = 'carried_billed' WHERE state = 'carried' AND cycle_from < ?`, from);
    return this.bill(from);
  }

  prune(now: number): void {
    this.sql.exec(`DELETE FROM overage_call WHERE at < ?`, now - OVERAGE_RETENTION_DAYS * DAY_MS);
    this.sql.exec(`DELETE FROM overage_bill WHERE cycle_to < ? AND state != 'carried'`, now - OVERAGE_RETENTION_DAYS * DAY_MS);
  }
}
