/**
 * Claude and ChatGPT usage accounting — the vocabulary and pure helpers (spec mcp-usage-accounting, kaptionai
 * features/mcp/mcp-usage-accounting.feature.yaml).
 *
 * Each account has one ledger (UsageLedger, usage-ledger.ts). The relay counts every cloud tool call itself; the
 * extension reports local-hub calls as batched counters. Only counters are kept: the account reference, an opaque
 * connection id, the app, the tool (and an enum sub-type), the outcome, a latency bucket and the hour. Never the
 * arguments, message text, chat ids, contacts or media (mcp-usage-accounting.PRIVACY.1).
 */

export type UsagePath = "cloud" | "local";
export type UsageOutcome = "ok" | "error" | "refused" | "offline" | "timeout";
export type LatencyBucket = "<1s" | "1-3s" | "3-10s" | "10-30s" | ">30s";

export const OUTCOMES: readonly UsageOutcome[] = ["ok", "error", "refused", "offline", "timeout"];
export const LATENCY_BUCKETS: readonly LatencyBucket[] = ["<1s", "1-3s", "3-10s", "10-30s", ">30s"];

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** One counted cell: `calls` calls of one tool, with one outcome, in one hour, on one connection. */
export interface UsageCell {
  /** Epoch ms, a whole UTC hour. */
  hour: number;
  path: UsagePath;
  /** Opaque: the OAuth grant id (cloud) or `local-<app slug>` (local). */
  connection: string;
  /** Normalized app name (normalizeCloudApp / normalizeLocalApp). */
  app: string;
  tool: string;
  /** Enum sub-type (usageKind), "" when none. */
  kind: string;
  outcome: UsageOutcome;
  latency: LatencyBucket;
  calls: number;
  /** Calls that repeated the same tool with identical arguments on the same connection within 2 minutes. */
  repeats: number;
}

/** mcp-usage-accounting.RECORD.4 — the app as people know it, from the OAuth client registration's name. */
export function normalizeCloudApp(clientName: string | null | undefined): string {
  const name = (clientName ?? "").trim();
  if (/chat\s*gpt|openai/i.test(name)) return "ChatGPT";
  if (/claude[\s-]*code/i.test(name)) return "Claude Code";
  if (/claude|anthropic/i.test(name)) return "Claude";
  if (/codex/i.test(name)) return "Codex";
  if (/cursor/i.test(name)) return "Cursor";
  if (/gemini/i.test(name)) return "Gemini";
  return "Other";
}

/** mcp-usage-accounting.RECORD.4 — a local app, from the hub's MCP `initialize` clientInfo.name. */
export function normalizeLocalApp(clientName: string | null | undefined): string {
  const name = (clientName ?? "").trim();
  if (!name) return "Local app";
  if (/claude[\s-]*code/i.test(name)) return "Claude Code (local)";
  if (/claude/i.test(name)) return "Claude Desktop (local)";
  if (/cursor/i.test(name)) return "Cursor (local)";
  if (/codex/i.test(name)) return "Codex (local)";
  if (/visual studio code|vscode|vs code|copilot/i.test(name)) return "VS Code (local)";
  return "Other (local)";
}

/** The opaque connection id of a local app (one per app on the account). */
export function localConnectionId(app: string): string {
  const slug = app.toLowerCase().replace(/\(local\)/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `local-${slug || "app"}`;
}

/** mcp-usage-accounting.RECORD.3 — coarse latency only. */
export function latencyBucket(ms: number): LatencyBucket {
  if (!(ms >= 0)) return "<1s";
  if (ms < 1000) return "<1s";
  if (ms < 3000) return "1-3s";
  if (ms < 10_000) return "3-10s";
  if (ms < 30_000) return "10-30s";
  return ">30s";
}

/**
 * mcp-usage-accounting.RECORD.2 — the enum argument that says what kind of call it was. Only values from the tools'
 * fixed enums are kept; anything else (free text, ids) becomes "".
 */
const KIND_FIELDS: Record<string, { field: string; values: readonly string[] }> = {
  query: {
    field: "entity",
    values: ["conversations", "contacts", "messages", "transcriptions", "labels", "communities", "session"],
  },
  get_analytics: {
    field: "section",
    values: [
      "overview", "kpis", "activity", "rankings", "response_times", "calls", "labels", "emojis", "words", "countries",
      "silences", "channels", "communities", "conversation_starters", "streaks", "gaps", "organization",
      "chat_detail", "export_chat", "export_contacts", "community_growth", "channel_growth",
    ],
  },
  manage_labels: { field: "action", values: ["add", "remove", "create", "delete"] },
  manage_notes: { field: "action", values: ["get", "set"] },
  manage_chat: {
    field: "action",
    values: ["archive", "unarchive", "mark_read", "mark_unread", "pin", "unpin", "mute", "unmute", "set_draft", "clear_draft"],
  },
  manage_reminders: { field: "action", values: ["list", "get", "create", "update", "delete", "complete", "uncomplete"] },
  manage_scheduled_messages: {
    field: "action",
    values: ["list", "get", "create", "update", "delete", "cancel", "remove", "send_now"],
  },
  manage_lists: { field: "action", values: ["list", "get", "create", "edit", "delete", "add_chat", "remove_chat"] },
  call_recordings: { field: "action", values: ["list", "get", "search"] },
};

export function usageKind(tool: string, args: unknown): string {
  const spec = KIND_FIELDS[tool];
  if (!spec || !args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>)[spec.field];
  return typeof value === "string" && spec.values.includes(value) ? value : "";
}

/** A kind reported by the extension, kept only when it is one of the tool's enum values. */
export function knownKind(tool: string, kind: unknown): string {
  const spec = KIND_FIELDS[tool];
  return spec && typeof kind === "string" && spec.values.includes(kind) ? kind : "";
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;

/** Tool names as the relay registers them; anything else is not a tool call. */
export function isToolName(tool: unknown): tool is string {
  return typeof tool === "string" && TOOL_NAME.test(tool) && !tool.startsWith("debug_");
}

/**
 * mcp-usage-accounting.RECORD.5 — the outcome of a relayed call. `code` is the JSON-RPC error code the extension
 * answered with (when it answered with an error); -32003 is a plan-limit refusal.
 */
export function outcomeOf(error: unknown): UsageOutcome {
  if (!error) return "ok";
  const code = (error as { code?: unknown })?.code;
  if (code === -32003 || code === "refused") return "refused";
  if (code === "offline") return "offline";
  if (code === "timeout") return "timeout";
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
  if (/^Extension not connected/.test(message)) return "offline";
  if (/^Request timed out/.test(message)) return "timeout";
  return "error";
}

export const hourOf = (at: number): number => Math.floor(at / HOUR_MS) * HOUR_MS;

export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** `YYYY-MM` of a time (UTC). */
export const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7);

/** mcp-usage-accounting.MONTH.1 — [start, end) of a UTC calendar month `YYYY-MM`, or null when invalid. */
export function monthRange(month: string): { from: number; to: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12 || year < 2020 || year > 2100) return null;
  return { from: Date.UTC(year, mon - 1, 1), to: Date.UTC(year, mon, 1) };
}

// ─── Local batches (POST /ext/usage/local) ─────────────────────────────

export const LOCAL_MAX_ROWS = 500;
export const LOCAL_MAX_BODY_BYTES = 64 * 1024;
export const LOCAL_MAX_AGE_MS = 35 * DAY_MS;
const BATCH_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface LocalBatch {
  batchId: string;
  cells: UsageCell[];
}

/**
 * mcp-usage-accounting.LOCAL.8 — validates a local batch as a whole: one bad row refuses the batch (the client must
 * not resend it unchanged). Returns the cells to add, or the reason it was refused.
 */
export function parseLocalBatch(body: unknown, now: number): LocalBatch | { error: string } {
  if (!body || typeof body !== "object") return { error: "Body must be a JSON object." };
  const { batchId, rows } = body as { batchId?: unknown; rows?: unknown };
  if (typeof batchId !== "string" || !BATCH_ID.test(batchId)) return { error: "batchId must be 8–64 letters, digits, _ or -." };
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > LOCAL_MAX_ROWS) {
    return { error: `rows must hold 1–${LOCAL_MAX_ROWS} rows.` };
  }
  const cells: UsageCell[] = [];
  for (const [i, raw] of rows.entries()) {
    if (!raw || typeof raw !== "object") return { error: `rows[${i}] is not an object.` };
    const row = raw as Record<string, unknown>;
    const hour = row.hour;
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour % HOUR_MS !== 0) {
      return { error: `rows[${i}].hour must be a whole UTC hour in epoch ms.` };
    }
    if (hour < now - LOCAL_MAX_AGE_MS || hour > now + HOUR_MS) return { error: `rows[${i}].hour is out of range.` };
    const client = row.client ?? "";
    if (typeof client !== "string" || client.length > 64) return { error: `rows[${i}].client must be a short string.` };
    if (!isToolName(row.tool)) return { error: `rows[${i}].tool is not a tool name.` };
    const kind = row.kind ?? "";
    if (typeof kind !== "string" || !/^[a-z_]{0,32}$/.test(kind)) return { error: `rows[${i}].kind is invalid.` };
    if (!OUTCOMES.includes(row.outcome as UsageOutcome)) return { error: `rows[${i}].outcome is invalid.` };
    if (!LATENCY_BUCKETS.includes(row.latency as LatencyBucket)) return { error: `rows[${i}].latency is invalid.` };
    const calls = row.calls;
    if (typeof calls !== "number" || !Number.isInteger(calls) || calls < 1 || calls > 10_000) {
      return { error: `rows[${i}].calls must be 1–10000.` };
    }
    const repeats = row.repeats ?? 0;
    if (typeof repeats !== "number" || !Number.isInteger(repeats) || repeats < 0 || repeats > calls) {
      return { error: `rows[${i}].repeats must be 0–calls.` };
    }
    const app = normalizeLocalApp(client);
    cells.push({
      hour,
      path: "local",
      connection: localConnectionId(app),
      app,
      tool: row.tool,
      kind: knownKind(row.tool, kind),
      outcome: row.outcome as UsageOutcome,
      latency: row.latency as LatencyBucket,
      calls,
      repeats,
    });
  }
  return { batchId, cells };
}

// ─── Repeats (in memory only) ──────────────────────────────────────────

export const REPEAT_WINDOW_MS = 2 * 60_000;
const REPEAT_MEMORY = 64;

/**
 * mcp-usage-accounting.RECORD.6 — notices a call that repeats the same tool with identical arguments within 2 minutes.
 * Keeps only SHA-256 digests in memory, for at most 2 minutes; nothing here is stored or logged.
 */
export class RepeatDetector {
  private seen = new Map<string, number>();

  async isRepeat(tool: string, args: unknown, now: number): Promise<boolean> {
    for (const [key, at] of this.seen) if (now - at > REPEAT_WINDOW_MS) this.seen.delete(key);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${tool}\u0000${stableJson(args)}`));
    const key = Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
    const repeat = this.seen.has(key);
    this.seen.delete(key);
    this.seen.set(key, now);
    while (this.seen.size > REPEAT_MEMORY) this.seen.delete(this.seen.keys().next().value as string);
    return repeat;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

// ─── The answer of GET /ext/usage ──────────────────────────────────────

export interface UsageTotals {
  calls: number;
  ok: number;
  error: number;
  refused: number;
  offline: number;
  timeout: number;
  repeats: number;
}

export interface UsageReport {
  month: string;
  from: string;
  to: string;
  updatedAt: number;
  since: string | null;
  /** mcp-usage-accounting.COUNT.1 — answered calls of both paths: the number any limit or bill uses. */
  counted: number;
  totals: UsageTotals;
  apps: { app: string; path: UsagePath; calls: number; ok: number }[];
  connections: {
    id: string;
    app: string;
    path: UsagePath;
    calls: number;
    ok: number;
    lastAt: number | null;
    active: boolean;
  }[];
  tools: { tool: string; calls: number; ok: number }[];
  kinds: { tool: string; kind: string; calls: number; ok: number }[];
  days: { day: string; app: string; calls: number; ok: number }[];
}

export const emptyTotals = (): UsageTotals => ({ calls: 0, ok: 0, error: 0, refused: 0, offline: 0, timeout: 0, repeats: 0 });

/** One daily row of a ledger, as UsageLedger.report() returns it. */
export interface DayRow {
  day: string;
  path: UsagePath;
  connection: string;
  app: string;
  tool: string;
  kind: string;
  outcome: UsageOutcome;
  calls: number;
  repeats: number;
}

export interface ConnectionRow {
  id: string;
  path: UsagePath;
  app: string;
  lastAt: number;
}

/**
 * mcp-usage-accounting.REPORT.1-4 — the month's report from the daily rows of one or more ledgers (a Brazilian line's
 * two forms are two ledgers). `activeGrants` names the cloud connections that still exist.
 */
export function buildReport(
  month: string,
  rows: DayRow[],
  connections: ConnectionRow[],
  since: string | null,
  activeGrants: Set<string>,
  now: number,
): UsageReport {
  const range = monthRange(month)!;
  const totals = emptyTotals();
  const apps = new Map<string, { app: string; path: UsagePath; calls: number; ok: number }>();
  const conns = new Map<string, UsageReport["connections"][number]>();
  const tools = new Map<string, { tool: string; calls: number; ok: number }>();
  const kinds = new Map<string, { tool: string; kind: string; calls: number; ok: number }>();
  const days = new Map<string, { day: string; app: string; calls: number; ok: number }>();
  const lastAt = new Map(connections.map((c) => [c.id, c.lastAt]));
  const bump = <T extends { calls: number; ok: number }>(map: Map<string, T>, key: string, make: () => T, row: DayRow) => {
    let entry = map.get(key);
    if (!entry) map.set(key, (entry = make()));
    entry.calls += row.calls;
    if (row.outcome === "ok") entry.ok += row.calls;
  };
  for (const row of rows) {
    totals.calls += row.calls;
    totals[row.outcome] += row.calls;
    totals.repeats += row.repeats;
    bump(apps, `${row.path}\u0000${row.app}`, () => ({ app: row.app, path: row.path, calls: 0, ok: 0 }), row);
    bump(
      conns,
      row.connection,
      () => ({
        id: row.connection,
        app: row.app,
        path: row.path,
        calls: 0,
        ok: 0,
        lastAt: lastAt.get(row.connection) ?? null,
        active: row.path === "local" || activeGrants.has(row.connection),
      }),
      row,
    );
    bump(tools, row.tool, () => ({ tool: row.tool, calls: 0, ok: 0 }), row);
    if (row.kind) bump(kinds, `${row.tool}\u0000${row.kind}`, () => ({ tool: row.tool, kind: row.kind, calls: 0, ok: 0 }), row);
    bump(days, `${row.day}\u0000${row.app}`, () => ({ day: row.day, app: row.app, calls: 0, ok: 0 }), row);
  }
  const byCalls = <T extends { calls: number }>(map: Map<string, T>) => [...map.values()].sort((a, b) => b.calls - a.calls);
  return {
    month,
    from: new Date(range.from).toISOString(),
    to: new Date(range.to).toISOString(),
    updatedAt: now,
    since,
    counted: totals.ok,
    totals,
    apps: byCalls(apps),
    connections: byCalls(conns),
    tools: byCalls(tools),
    kinds: byCalls(kinds),
    days: [...days.values()].sort((a, b) => (a.day === b.day ? b.calls - a.calls : a.day < b.day ? -1 : 1)),
  };
}
