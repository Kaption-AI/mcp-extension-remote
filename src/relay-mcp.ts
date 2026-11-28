/**
 * RelayMCP — McpAgent Durable Object that registers tools and relays
 * tool calls to the appropriate RelayRoom (by account reference).
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CARD_TOOL_OUTPUT_SCHEMA,
  CLOUD_TOOLS,
  PLANS_TOOL_OUTPUT_SCHEMA,
  PUBLIC_TOOL_OUTPUT_SCHEMA,
  routeToolCall,
  type ToolDefinition,
} from "./tools";
import { NO_ACCOUNT_TEXT, toolErrorText } from "./tool-errors";
import { INLINE_FILE_TOOLS, scrubInlineMedia } from "./media-scrub";
import { takeUsageNotice } from "./usage-notice";
import type { Env } from "./types";
import { manageFeaturesWithAlias, meteringPhoneWithAlias, relayWithAliasSettled } from "./phone-alias";
import { CloudMeter, REFUSED_CODE, meterRefusalText, type CloudGate } from "./meter";
import {
  installManageResources,
  MANAGE_TOOL_FEATURE,
  notifyResourcesAndPromptsChanged,
  plansStructuredContent,
  resourcesChanged,
  syncGatedTools,
  visibleManageTools,
} from "./manage-kaption";
import { withLiveGuide } from "./live-guide";
import { z } from "zod";
import {
  AVATARS_TOOL,
  AVATARS_TOOL_DESCRIPTION,
  AVATARS_TOOL_TITLE,
  avatarIds,
  avatarsAnswer,
  avatarsToolMeta,
  cardFor,
  cardToolMeta,
  errorCardFor,
  isCardTool,
} from "./cards";
import { CARDS_FLAG_TTL_MS, cardsOnForPhone } from "./cards-flag";
import {
  RepeatDetector,
  hourOf,
  latencyBucket,
  normalizeCloudApp,
  outcomeOf,
  usageKind,
  type UsageCell,
} from "./usage";
import { ledgerFor, type CloudBegin } from "./usage-ledger";
import { shadowPhone } from "./ledger-windows";
import { DISABLED_CODE, DisabledGate } from "./disabled-gate";
import { normalizeMcpClient, sanitizeClientInfo, sanitizeClientName, type McpClientId, type McpClientInfo } from "./client";
import { ledgerUsage, refusalFallback, usageLang, usageLine, usageMeta, usagePhone, type Usage, type UsageLang } from "./weekly-usage";

/** mcp-usage-ledger.SINGLE.4 — what the ledger said about one cloud call. */
interface LedgerGate {
  state: "run" | "refused";
  /** The reservation to settle with the record (or give back when the call fails). */
  reservation: string | null;
  message: string | null;
  usage: Usage | null;
  lang: UsageLang;
}

/** mcp-local-hub-growth.CLIENT.3 — where a session's clientInfo is kept across evictions (DO storage). */
const CLIENT_INFO_KEY = "mcpClientInfo";

export class RelayMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "Kaption WhatsApp MCP (Cloud)",
    version: "1.0.0",
  }) as any; // McpServer version compat between agents and @modelcontextprotocol/sdk

  /** mcp-manage-kaption.LIST.2 — the manage tools registered now, and the set they follow. */
  private manageTools = new Map<string, { remove(): void }>();
  private manageVisible = new Set<string>();
  private manageRefreshedAt = 0;

  /** mcp-apps-cards.FLAG.1-4 — MCP_APPS_CARDS for this session's account, when it was last asked, the card tools. */
  private cardsOn = false;
  private cardsCheckedAt = 0;
  private cardTools = new Map<string, { remove(): void }>();
  /** mcp-apps-cards.AVATAR.1 — the card-only picture tool, registered only while the flag is on. */
  private avatarsTool: { remove(): void } | null = null;

  async init() {
    // mcp-apps-cards.FLAG.1 — asked before the tools are registered, so the first tools/list already says it.
    this.cardsOn = await this.checkCards();
    // mcp.CLOUD_RELAY.6 — registers same ten tools; relays to RelayRoom, never executes locally
    // mcp-manage-kaption.LIST.2 — the manage tools only while this account's extension said so (refreshManageVisibility).
    for (const tool of CLOUD_TOOLS) {
      if (MANAGE_TOOL_FEATURE[tool.name]) continue;
      const registered = this.registerCloudTool(tool);
      if (isCardTool(tool.name)) this.cardTools.set(tool.name, registered);
    }
    this.syncAvatarsTool();
    await this.refreshManageVisibility();
    // business-plans.MCP_ASYNC.2 — the session's view of its ledger, seeded in the background (switch on only).
    const seedRef = this.getAccountRef();
    if (seedRef && this.meterOn()) this.cloudMeter(seedRef).seed();
    // mcp-manage-kaption.HELP.3, PROMPTS.2, UI.1 — guides and prompts through kaption_help, plus the plans page.
    installManageResources(this.server.server, {
      visible: async () => {
        await this.refreshManageVisibility();
        return this.manageVisible;
      },
      callHelp: async (args) => {
        const accountRef = this.getAccountRef();
        if (!accountRef) throw new Error(NO_ACCOUNT_TEXT);
        // mcp-manage-kaption.HELP.5 — a guide read answers its live page (kaption://guide/{topic}).
        return withLiveGuide(args, scrubInlineMedia(await this.relayToExtension(accountRef, "kaption_help", args)));
      },
      // mcp-apps-cards.FLAG.2-3 — the cards page is listed and readable only while the flag is on.
      cards: () => this.cardsOn,
    });
  }

  /** mcp-apps-cards.FLAG.1 — MCP_APPS_CARDS for this account's phone; anything that fails is off. */
  private async checkCards(): Promise<boolean> {
    this.cardsCheckedAt = Date.now();
    if (String(this.env.MCP_APPS_CARDS ?? "").trim().toLowerCase() !== "flags") return false;
    const accountRef = this.getAccountRef();
    if (!accountRef) return false;
    try {
      return await cardsOnForPhone(this.env, await meteringPhoneWithAlias(this.env, accountRef));
    } catch {
      return false;
    }
  }

  /**
   * mcp-apps-cards.FLAG.4 — at most every 5 minutes (with the manage refresh): a change re-registers the card tools with
   * or without _meta.ui (tools/list_changed) and announces the cards page (resources/list_changed).
   */
  private async refreshCards(): Promise<void> {
    if (Date.now() - this.cardsCheckedAt < CARDS_FLAG_TTL_MS) return;
    const on = await this.checkCards();
    if (on === this.cardsOn) return;
    this.cardsOn = on;
    for (const [name, registered] of this.cardTools) {
      registered.remove();
      this.cardTools.set(name, this.registerCloudTool(CLOUD_TOOLS.find((t) => t.name === name)!));
    }
    this.syncAvatarsTool();
    const connected = typeof this.server.isConnected === "function" && this.server.isConnected();
    if (connected) notifyResourcesAndPromptsChanged(this.server.server);
  }

  /**
   * mcp-manage-kaption.LIST.2 — lists the Kaption settings tools, kaption_help and report_bug only while the account's
   * extension said manage_kaption true in its auth message, the Business Agent tools for business_agent true,
   * kaption_plans for plans true (no extension, or one that said nothing: hidden). A hidden tool is not registered, so a
   * call answers the usual unknown-tool error. Registering or removing one sends notifications/tools/list_changed.
   * Called at session start, by the relay room when its extension's features change, before resources and prompts
   * lists, and after calls.
   */
  async refreshManageVisibility(): Promise<string[]> {
    const accountRef = this.getAccountRef();
    let features = null;
    if (accountRef) {
      try {
        features = await manageFeaturesWithAlias(this.env, accountRef, (this as any).ctx.id.toString());
      } catch {
        features = null;
      }
    }
    this.manageRefreshedAt = Date.now();
    await this.refreshCards().catch(() => undefined);
    const next = visibleManageTools([features]);
    syncGatedTools(next, this.manageTools, (name) => this.registerCloudTool(CLOUD_TOOLS.find((t) => t.name === name)!));
    const connected = typeof this.server.isConnected === "function" && this.server.isConnected();
    if (resourcesChanged(this.manageVisible, next) && connected) notifyResourcesAndPromptsChanged(this.server.server);
    this.manageVisible = next;
    return [...next];
  }

  /** After a call, at most every 30 s: catches a change the room could not tell this session about. */
  private refreshManageSoon(): void {
    if (Date.now() - this.manageRefreshedAt < 30_000) return;
    const work = this.refreshManageVisibility().catch(() => undefined);
    try {
      (this as any).ctx?.waitUntil?.(work);
    } catch {
      // The Durable Object stays alive while the promise runs.
    }
  }

  /**
   * mcp-apps-cards.AVATAR.1-5 — get_avatars, listed only while MCP_APPS_CARDS is on and only to the card (visibility
   * app / openai private). Forwarded to the account's extension, which reads the pictures in the WhatsApp page; never
   * metered, never counted, never in the usage ledger (the user didn't ask for it). A failure answers no pictures, so
   * the card keeps its initials.
   */
  private syncAvatarsTool(): void {
    if (!this.cardsOn) {
      this.avatarsTool?.remove();
      this.avatarsTool = null;
      return;
    }
    if (this.avatarsTool) return;
    this.avatarsTool = this.server.registerTool(
      AVATARS_TOOL,
      {
        title: AVATARS_TOOL_TITLE,
        description: AVATARS_TOOL_DESCRIPTION,
        inputSchema: z.object({ ids: z.array(z.string()).max(50) }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: avatarsToolMeta(),
      },
      async (args: Record<string, unknown>) => {
        const ids = avatarIds(args);
        const accountRef = this.getAccountRef();
        let answer = avatarsAnswer(ids, null);
        if (accountRef && ids.length) {
          try {
            answer = avatarsAnswer(ids, await this.relayToExtension(accountRef, AVATARS_TOOL, { ids }));
          } catch {
            // An older extension, or no WhatsApp tab: initials.
          }
        }
        const found = Object.values(answer.avatars).filter(Boolean).length;
        return {
          content: [{ type: "text" as const, text: `${found} of ${ids.length} profile pictures for the Kaption card.` }],
          structuredContent: answer,
        };
      },
    );
  }

  private registerCloudTool(tool: ToolDefinition): { remove(): void } {
    const isPlans = tool.name === "kaption_plans";
    // mcp-apps-cards.FLAG.2-3, DATA.4 — fixed for this registration: a flag change re-registers the tool.
    const isCard = this.cardsOn && isCardTool(tool.name);
    // Use registerTool() with explicit config object — server.tool() has
    // ambiguous overloads that misinterpret ZodObject schemas as annotations
    // (because ZodObject has _def so isZodRawShapeCompat returns false).
    return this.server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // mcp-manage-kaption.UI.2 — kaption_plans answers its own JSON as structuredContent (the plans page reads it).
        outputSchema: isPlans ? PLANS_TOOL_OUTPUT_SCHEMA : isCard ? CARD_TOOL_OUTPUT_SCHEMA : PUBLIC_TOOL_OUTPUT_SCHEMA,
        annotations: tool.annotations,
        // The installed MCP SDK predates the top-level securitySchemes
        // field, so mirror it in _meta for ChatGPT compatibility. Endpoint
        // authentication is still enforced by OAuthProvider.
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["kaption:access"] }],
          "openai/toolInvocation/invoking": `Running ${tool.title ?? tool.name}…`,
          "openai/toolInvocation/invoked": `${tool.title ?? tool.name} complete`,
          ...(tool._meta ?? {}),
          ...(isCard ? cardToolMeta() : {}),
        },
      },
      async (args: Record<string, unknown>) => {
        const accountRef = this.getAccountRef();
        if (!accountRef) {
          return {
            content: [{ type: "text" as const, text: NO_ACCOUNT_TEXT }],
            isError: true,
          };
        }

        // mcp-usage-accounting.RECORD.1 — every tool call is counted, whatever its outcome.
        // mcp.TOOLS.19 — a read-only tool reaches the extension as its manage_* method and action, and is counted as
        // that call, so usage reads the same for every Kaption version.
        const routed = routeToolCall(tool.name, args);
        const started = Date.now();
        const usage = this.usageContext(accountRef, routed.method, routed.params, started);
        let failure: unknown = null;
        // disabled-gating.MCP.1-2 — a blocked Kaption account's call is refused before it reaches the extension or the
        // meter; the plans, checkout and help tools keep answering. Unlisted phones: nothing asked (SWITCH.4).
        const disabledText = await this.disabledRefusal(tool.name);
        if (disabledText) {
          failure = { code: DISABLED_CODE };
          this.recordUsage(usage, failure, Date.now() - started);
          return {
            content: [{ type: "text" as const, text: `Error: ${disabledText}` }],
            isError: true,
          };
        }
        // mcp-usage-ledger.SINGLE.4 — an account rest-api holds to a weekly number has this call reserved in its ledger
        // before it runs and refused past the number; mcp-usage-pricing.USAGE.5 — a usage phone also learns what is left.
        // mcp-usage-ledger.CREDITS.3 — priced as the call the extension receives (a routed read is its manage_* read).
        const weekly = await this.ledgerGate(accountRef, routed.method, usage.kind);
        usage.reservation = weekly?.reservation ?? null;
        if (weekly?.state === "refused") {
          failure = { code: REFUSED_CODE };
          this.recordUsage(usage, failure, Date.now() - started);
          return {
            content: [{ type: "text" as const, text: `Error: ${weekly.message}` }],
            isError: true,
            ...(weekly.usage ? { _meta: usageMeta(weekly.usage)! } : {}),
          };
        }
        // business-plans.MCP_LEDGER.4-7, MCP_ASYNC.1-6 — with the switches on, the account's ledger takes this call's
        // slot (and charges it past the allowance). In the common case the call is relayed at once and the reservation
        // runs beside it; it waits only when the session's view cannot tell. A known refusal refuses the call here.
        usage.gate = this.meterOn() ? await this.meterCloudCall(usage, routed.method) : null;
        if (usage.gate?.refusal) {
          failure = { code: REFUSED_CODE };
          this.recordUsage(usage, failure, Date.now() - started);
          return {
            content: [{ type: "text" as const, text: `Error: ${meterRefusalText(usage.gate.refusal.reason, usage.gate.refusal.allowance)}` }],
            isError: true,
          };
        }
        try {
          // Sanitize args for DO RPC — the MCP SDK may inject non-serializable
          // properties (AbortSignal etc.) into the args object
          const cleanArgs = JSON.parse(JSON.stringify(routed.params));
          const { sanitizeAccountRefForLog } = await import("./otp");
          // mcp-local-hub-growth.CLIENT.9 — the log adds the normalized client id only.
          console.log(
            `[RelayMCP] Relaying ${tool.name} to account=${sanitizeAccountRefForLog(accountRef)} app=${await this.appName(accountRef)} client=${await this.normalizedClient(accountRef)}`,
          );
          let result = await this.relayToExtension(accountRef, routed.method, cleanArgs, usage.gate?.metered ?? false);

          // Inline media ONLY for an explicit download_media call.
          //   download_media (mcp.TOOLS.6 / mcp.CLOUD_RELAY.6): base64_data flows
          //     through intact (parity with the local hub + WebMCP; kext c42987d5).
          //     The 16MB inbound cap in relay-room.ts is already sized to carry
          //     base64 media, so the bytes have crossed it before we get here —
          //     there is nothing to "save".
          //   every other tool (mcp.TOOLS.7): scrub any base64/binary blob (e.g.
          //     thumbnail bodies leaked via conversations.lastMessage / search.text)
          //     so media never pollutes the model's context window.
          //   export_chat (chat-export.MCP.2): its file comes back as base64_data the same way.
          if (!INLINE_FILE_TOOLS.has(tool.name)) {
            result = scrubInlineMedia(result);
          }
          // mcp-manage-kaption.HELP.5 — kaption_help "read" answers the guide's live page on kaptionai.com.
          if (tool.name === "kaption_help") result = await withLiveGuide(cleanArgs, result);

          // mcp-usage-pricing.RELAY.1 — a usage warning from the extension becomes its own line after the result.
          const marked = takeUsageNotice(result);
          result = marked.result;
          // mcp-apps-cards.DATA.1-2 — with the flag on, the card beside the answer (the text below is unchanged).
          const card = isCard ? cardFor(tool.name, args, result) : null;

          return {
            content: [
              {
                type: "text" as const,
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
              ...(marked.notice ? [{ type: "text" as const, text: marked.notice }] : []),
              // mcp-usage-pricing.USAGE.7 — one short line when little is left or overage is being spent.
              ...(weekly?.usage && usageLine(weekly.usage, weekly.lang) ? [{ type: "text" as const, text: usageLine(weekly.usage, weekly.lang)! }] : []),
            ],
            structuredContent: {
              ...((isPlans ? plansStructuredContent(result) : undefined) ?? { result }),
              ...(card ? { card } : {}),
            },
            // mcp-usage-pricing.USAGE.6 — what is left, on every result (only while MCP_USAGE_IN_RESULTS is on).
            ...(weekly?.usage ? { _meta: usageMeta(weekly.usage)! } : {}),
          };
        } catch (err: any) {
          failure = err ?? new Error("Tool call failed");
          // weekly-plan-limits.LIMITS.14, mcp-usage-ledger.SINGLE.4 — a failed call gives its reservation back.
          if (weekly?.reservation) this.refundReservation(accountRef, weekly.reservation);
          const text = toolErrorText(tool.name, err);
          // mcp-apps-cards.SENT.3 — a refused send_message carries its card too (flag on only).
          const card = isCard ? errorCardFor(tool.name, args, text) : null;
          return {
            content: [{ type: "text" as const, text }],
            isError: true,
            ...(card ? { structuredContent: { card } } : {}),
          };
        } finally {
          this.recordUsage(usage, failure, Date.now() - started);
          this.refreshManageSoon();
        }
      },
    );
  }

  private repeats = new RepeatDetector();
  private app: string | null = null;
  /** The OAuth client registration's own name (raw), looked up with the app (CLIENT.3 fallback). */
  private oauthClientName: string | null = null;
  /** mcp-local-hub-growth.CLIENT.3 — this session's clientInfo once known (sanitized, CLIENT.5). */
  private sessionClientInfo: McpClientInfo | null = null;

  /** The OAuth grant this session was opened with (set by the MCP handlers, mcp-usage-accounting.RECORD.7). */
  private getGrantId(): string | null {
    const grantId = (this as any).props?.grantId;
    return typeof grantId === "string" && grantId ? grantId : null;
  }

  /**
   * mcp-usage-accounting.RECORD.4 — the app behind this session, from the OAuth client registration of its grant
   * (looked up once per session). "Other" when the grant or client is unknown.
   */
  private async appName(accountRef: string): Promise<string> {
    if (this.app) return this.app;
    const grantId = this.getGrantId();
    let clientName: string | null = null;
    if (grantId) {
      try {
        const grant = await this.env.OAUTH_KV.get<{ clientId?: string }>(`grant:${accountRef}:${grantId}`, "json");
        const client = grant?.clientId
          ? await this.env.OAUTH_KV.get<{ clientName?: string }>(`client:${grant.clientId}`, "json")
          : null;
        clientName = client?.clientName ?? null;
      } catch {
        clientName = null;
      }
    }
    this.oauthClientName = clientName;
    this.app = normalizeCloudApp(clientName);
    return this.app;
  }

  /**
   * mcp-local-hub-growth.CLIENT.3 — the MCP `initialize` clientInfo of this session. The SDK server knows it after
   * initialize; an evicted and rehydrated Durable Object may not (yet), so it is kept in DO storage the first time it is
   * seen and read back from there (or from the initialize request the agent stored) when absent. Null when the session
   * never said one.
   */
  async sessionClient(): Promise<McpClientInfo | null> {
    if (this.sessionClientInfo) return this.sessionClientInfo;
    const storage = (this as any).ctx?.storage;
    let live: unknown = null;
    try {
      live = this.server?.server?.getClientVersion?.() ?? null;
    } catch {
      live = null;
    }
    let info = sanitizeClientInfo(live);
    if (info) {
      try {
        await storage?.put?.(CLIENT_INFO_KEY, info);
      } catch {
        // Kept in memory for this life of the object; the next one asks the server again.
      }
    } else {
      try {
        info = sanitizeClientInfo(await storage?.get?.(CLIENT_INFO_KEY));
        if (!info) {
          const init = (await storage?.get?.("initializeRequest")) as { params?: { clientInfo?: unknown } } | undefined;
          info = sanitizeClientInfo(init?.params?.clientInfo);
        }
      } catch {
        info = null;
      }
    }
    this.sessionClientInfo = info;
    return info;
  }

  /**
   * mcp-local-hub-growth.CLIENT.3 — the client sent beside every relayed call: the session's clientInfo, else the OAuth
   * client registration's name with version ''. Null when neither says a name.
   */
  private async callClient(accountRef: string): Promise<McpClientInfo | null> {
    const own = await this.sessionClient();
    if (own) return own;
    await this.appName(accountRef);
    const name = sanitizeClientName(this.oauthClientName);
    return name ? { name, version: "" } : null;
  }

  /** mcp-local-hub-growth.CLIENT.4, CLIENT.8 — this session's normalized client id (cloud). */
  private async normalizedClient(accountRef: string): Promise<McpClientId> {
    const client = await this.callClient(accountRef).catch(() => null);
    return normalizeMcpClient(client?.name, client?.version, "cloud").mcpClient;
  }

  private usageContext(accountRef: string, tool: string, args: unknown, at: number) {
    return {
      accountRef,
      tool,
      kind: usageKind(tool, args),
      at,
      repeat: this.repeats.isRepeat(tool, args, at).catch(() => false),
      /** business-plans.MCP_LEDGER.8, MCP_ASYNC.9 — the meter's gate: the call is recorded once its reservation is known. */
      gate: null as CloudGate | null,
      /** mcp-usage-ledger.SINGLE.2 — the call's weekly reservation, settled by its record. */
      reservation: null as string | null,
    };
  }

  private disabledGate: DisabledGate | null = null;

  /** disabled-gating.MCP.1, MCP.5 — the refusal text for this call, or null; any failure lets the call run. */
  private async disabledRefusal(tool: string): Promise<string | null> {
    const accountRef = this.getAccountRef();
    if (!accountRef) return null;
    this.disabledGate ??= new DisabledGate({ env: this.env, phone: () => meteringPhoneWithAlias(this.env, accountRef) });
    try {
      return await this.disabledGate.refusal(tool);
    } catch (error) {
      console.error("[disabled-gate] check failed:", error instanceof Error ? error.message : error);
      return null;
    }
  }

  /**
   * mcp-usage-ledger.SINGLE.3-5, SINGLE.14, mcp-usage-pricing.USAGE.5 — the ledger's decision for this call (a reservation
   * for an enforced account) and, for a usage phone, what is left. Null (the call runs as before) when the ledger is off
   * or anything fails (SINGLE.5: a ledger failure never refuses a call).
   */
  private async ledgerGate(accountRef: string, tool: string, kind = ""): Promise<LedgerGate | null> {
    if (this.env.USAGE_LEDGER_ENABLED === "off" || !this.env.USAGE_LEDGER) return null;
    try {
      const phone = await meteringPhoneWithAlias(this.env, accountRef);
      if (!phone) return null;
      const ledger = ledgerFor(this.env, accountRef);
      const actionId = `cloud:${crypto.randomUUID()}`;
      // mcp-usage-ledger.CREDITS.3 — the call's kind prices its reservation.
      const begin = (await ledger.cloudBegin({ phone, actionId, tool, kind, accountRef })) as CloudBegin;
      const show = usagePhone(phone, this.env);
      // mcp-usage-ledger.CREDITS.5 — begin.use.used is already in the plan's unit.
      let window: { counted: number; credits?: number; to: string } | null = begin.use
        ? { counted: begin.use.used, credits: begin.use.used, to: begin.use.resetsAt }
        : null;
      if (show && !window && begin.plan?.period) {
        const w = await ledger.windows({ since: begin.plan.since ?? null });
        window = begin.plan.period === "month" ? w.month : w.week;
      }
      const usage = show ? ledgerUsage(begin.plan, window) : null;
      const lang = usageLang(begin.plan?.lang);
      if (begin.state === "refused") {
        // mcp-overage-billing.LEDGER.3 — past the overage cap: the cap's words (rest-api's), else the plan's.
        const capped = begin.use?.reason === "cap" ? begin.plan?.overage?.message ?? null : null;
        return { state: "refused", reservation: null, message: capped ?? begin.plan?.message ?? refusalFallback(begin.plan?.limit ?? 0, begin.plan?.period ?? "month", "credits"), usage, lang };
      }
      return { state: "run", reservation: begin.reserved ? actionId : null, message: null, usage, lang };
    } catch (error) {
      console.error("[ledger] gate failed:", error instanceof Error ? error.message : error);
      return null;
    }
  }

  /** weekly-plan-limits.LIMITS.14 — a failed call's reservation is given back (in the background). */
  private refundReservation(accountRef: string, actionId: string): void {
    const work = ledgerFor(this.env, accountRef)
      .use({ change: "refund", path: "cloud", actionIds: [actionId], limit: null, enforce: false })
      .catch(() => undefined);
    try {
      (this as any).ctx?.waitUntil?.(work);
    } catch {
      // The Durable Object stays alive while the promise runs.
    }
  }

  /** business-plans.MCP_LEDGER.1, MCP_ASYNC.1 — the relay's own switch, checked before anything else. */
  private meterOn(): boolean {
    return this.env.MCP_OVERAGE_LEDGER === "on" && this.env.USAGE_LEDGER_ENABLED !== "off" && !!this.env.USAGE_LEDGER;
  }

  private meter: CloudMeter | null = null;

  /** business-plans.MCP_ASYNC.2, MCP_LEDGER.15-16 — this session's meter, on the ledger the calls are recorded in. */
  private cloudMeter(accountRef: string): CloudMeter {
    if (!this.meter) {
      this.meter = new CloudMeter({
        env: this.env,
        ledger: () => ledgerFor(this.env, accountRef) as any,
        phone: () => meteringPhoneWithAlias(this.env, accountRef),
        background: (p) => {
          try {
            (this as any).ctx?.waitUntil?.(p);
          } catch {
            // The Durable Object stays alive while the promise runs.
          }
        },
      });
    }
    return this.meter;
  }

  /**
   * business-plans.MCP_LEDGER.1-7, .15, MCP_ASYNC.3-5 — the meter's gate for one cloud call, in the ledger of the account
   * the call is recorded in. Any failure of the ledger itself: not metered.
   */
  private async meterCloudCall(usage: ReturnType<RelayMCP["usageContext"]>, tool: string): Promise<CloudGate | null> {
    try {
      return await this.cloudMeter(usage.accountRef).begin({
        actionId: `cloud:${crypto.randomUUID()}`,
        path: "cloud",
        connection: this.getGrantId() ?? "unknown",
        app: await this.appName(usage.accountRef),
        tool,
        kind: usage.kind,
      });
    } catch (error) {
      console.error("[meter] gate failed:", error instanceof Error ? error.message : error);
      return null;
    }
  }

  /** mcp-usage-accounting.RECORD.1-6 — one cell into the account's ledger, after the answer; never fails the call. */
  private recordUsage(usage: ReturnType<RelayMCP["usageContext"]>, failure: unknown, elapsedMs: number): void {
    if (this.env.USAGE_LEDGER_ENABLED === "off" || !this.env.USAGE_LEDGER) return;
    const work = (async () => {
      const cell: UsageCell = {
        hour: hourOf(usage.at),
        path: "cloud",
        connection: this.getGrantId() ?? "unknown",
        app: await this.appName(usage.accountRef),
        // mcp-local-hub-growth.CLIENT.8 — the connection's normalized client (cloud path).
        client: await this.normalizedClient(usage.accountRef),
        tool: usage.tool,
        kind: usage.kind,
        outcome: outcomeOf(failure),
        latency: latencyBucket(elapsedMs),
        calls: 1,
        repeats: (await usage.repeat) ? 1 : 0,
      };
      // business-plans.MCP_LEDGER.8, MCP_ASYNC.8-9 — a metered call is recorded once its reservation is known (its
      // hold settled in the same transaction, a failed charged call credited back once).
      if (usage.gate?.metered && this.meter) {
        await this.meter.finish(usage.gate, cell, usage.accountRef);
        if (usage.reservation) await ledgerFor(this.env, usage.accountRef).settleReservation(usage.reservation);
      } else {
        // mcp-usage-ledger.SINGLE.2 — the record settles the call's reservation (a failed one was given back already).
        await ledgerFor(this.env, usage.accountRef).record([cell], { accountTag: usage.accountRef, ...(usage.reservation ? { reservation: usage.reservation } : {}) });
      }
      // mcp-usage-ledger.SHADOW.1-2, HOT_PATH.6 — after the call was answered and recorded: judge the window, never enforce.
      if (String(this.env.LEDGER_SHADOW ?? "").trim()) {
        const phone = await meteringPhoneWithAlias(this.env, usage.accountRef).catch(() => null);
        if (phone && shadowPhone(phone, this.env)) await ledgerFor(this.env, usage.accountRef).shadowAfter(phone);
      }
    })().catch((error) => console.error("[usage] record failed:", error instanceof Error ? error.message : error));
    try {
      (this as any).ctx?.waitUntil?.(work);
    } catch {
      // The Durable Object stays alive while the promise runs.
    }
  }

  private getAccountRef(): string | null {
    try {
      const props = (this as any).props;
      if (props?.accountRef) return props.accountRef;
    } catch {
      // ignore
    }
    return null;
  }

  private async relayToExtension(
    accountRef: string,
    method: string,
    params: Record<string, unknown>,
    metered = false,
  ): Promise<unknown> {
    // mcp-local-hub-growth.CLIENT.3 — the session's client travels beside the call (beside `kaption`).
    const client = await this.callClient(accountRef).catch(() => null);
    // mcp.CLOUD_RELAY.17 — follows a Brazilian number's other form when this account has no extension.
    return relayWithAliasSettled(this.env, accountRef, method, params, {
      ...(metered ? { metered: true } : {}),
      ...(client ? { client } : {}),
    });
  }
}
