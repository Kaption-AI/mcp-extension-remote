/**
 * RelayMCP — McpAgent Durable Object that registers tools and relays
 * tool calls to the appropriate RelayRoom (by account reference).
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CLOUD_TOOLS,
  PLANS_TOOL_OUTPUT_SCHEMA,
  PUBLIC_TOOL_OUTPUT_SCHEMA,
  routeToolCall,
  type ToolDefinition,
} from "./tools";
import { NO_ACCOUNT_TEXT, toolErrorText } from "./tool-errors";
import { scrubInlineMedia } from "./media-scrub";
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
import {
  RepeatDetector,
  hourOf,
  latencyBucket,
  normalizeCloudApp,
  outcomeOf,
  usageKind,
  type UsageCell,
} from "./usage";
import { ledgerFor } from "./usage-ledger";
import { DISABLED_CODE, DisabledGate } from "./disabled-gate";
import { beginUse, refundUse, usageConfigured, usageLine, usageMeta, type UseAnswer } from "./weekly-usage";

export class RelayMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "Kaption WhatsApp MCP (Cloud)",
    version: "1.0.0",
  }) as any; // McpServer version compat between agents and @modelcontextprotocol/sdk

  /** mcp-manage-kaption.LIST.2 — the manage tools registered now, and the set they follow. */
  private manageTools = new Map<string, { remove(): void }>();
  private manageVisible = new Set<string>();
  private manageRefreshedAt = 0;

  async init() {
    // mcp.CLOUD_RELAY.6 — registers same ten tools; relays to RelayRoom, never executes locally
    // mcp-manage-kaption.LIST.2 — the manage tools only while this account's extension said so (refreshManageVisibility).
    for (const tool of CLOUD_TOOLS) {
      if (MANAGE_TOOL_FEATURE[tool.name]) continue;
      this.registerCloudTool(tool);
    }
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
        return scrubInlineMedia(await this.relayToExtension(accountRef, "kaption_help", args));
      },
    });
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

  private registerCloudTool(tool: ToolDefinition): { remove(): void } {
    const isPlans = tool.name === "kaption_plans";
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
        outputSchema: isPlans ? PLANS_TOOL_OUTPUT_SCHEMA : PUBLIC_TOOL_OUTPUT_SCHEMA,
        annotations: tool.annotations,
        // The installed MCP SDK predates the top-level securitySchemes
        // field, so mirror it in _meta for ChatGPT compatibility. Endpoint
        // authentication is still enforced by OAuthProvider.
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["kaption:access"] }],
          "openai/toolInvocation/invoking": `Running ${tool.title ?? tool.name}…`,
          "openai/toolInvocation/invoked": `${tool.title ?? tool.name} complete`,
          ...(tool._meta ?? {}),
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
        // weekly-plan-limits.SERVER.13 — a listed phone's call is counted on rest-api's weekly ledger before it runs
        // (refused at the limit); mcp-usage-pricing.USAGE.5 — a usage phone also learns what is left. Unlisted: nothing.
        const weekly = await this.weeklyUse(accountRef, tool.name);
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
          console.log(
            `[RelayMCP] Relaying ${tool.name} to account=${sanitizeAccountRefForLog(accountRef)} app=${await this.appName(accountRef)}`,
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
          if (tool.name !== "download_media") {
            result = scrubInlineMedia(result);
          }

          // mcp-usage-pricing.RELAY.1 — a usage warning from the extension becomes its own line after the result.
          const marked = takeUsageNotice(result);
          result = marked.result;

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
            structuredContent: (isPlans ? plansStructuredContent(result) : undefined) ?? { result },
            // mcp-usage-pricing.USAGE.6 — what is left, on every result (only while MCP_USAGE_IN_RESULTS is on).
            ...(weekly?.usage ? { _meta: usageMeta(weekly.usage)! } : {}),
          };
        } catch (err: any) {
          failure = err ?? new Error("Tool call failed");
          // weekly-plan-limits.LIMITS.14 — a failed call gives its weekly slot (or its charge) back.
          if (weekly?.state === "run" && weekly.counted) this.refundWeeklyUse(accountRef, weekly.actionId);
          return {
            content: [
              {
                type: "text" as const,
                text: toolErrorText(tool.name, err),
              },
            ],
            isError: true,
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
    this.app = normalizeCloudApp(clientName);
    return this.app;
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
   * weekly-plan-limits.SERVER.13, mcp-usage-pricing.USAGE.5 — count this call on the weekly ledger and/or fetch what is
   * left. Null (the call runs as before) when both switches are unset, the phone is not listed, or anything fails.
   */
  private async weeklyUse(accountRef: string, tool: string): Promise<UseAnswer | null> {
    // lifetime-local.HOLDER.7 — rest-api's /access (the disabled gate's cached answer) says this account counts by the
    // week (every Lifetime account): its cloud calls are counted on the weekly ledger like a listed phone's.
    const weekly = this.disabledGate?.weekly() === true;
    if (!usageConfigured(this.env) && !weekly) return null;
    try {
      const phone = await meteringPhoneWithAlias(this.env, accountRef);
      return await beginUse(this.env, phone, tool, crypto.randomUUID(), fetch, { weekly });
    } catch (error) {
      console.error("[weekly-usage] check failed:", error instanceof Error ? error.message : error);
      return null;
    }
  }

  private refundWeeklyUse(accountRef: string, actionId: string): void {
    const work = meteringPhoneWithAlias(this.env, accountRef)
      .then((phone) => (phone ? refundUse(this.env, phone, actionId) : undefined))
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
        return;
      }
      await ledgerFor(this.env, usage.accountRef).record([cell], { accountTag: usage.accountRef });
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
    // mcp.CLOUD_RELAY.17 — follows a Brazilian number's other form when this account has no extension.
    return relayWithAliasSettled(this.env, accountRef, method, params, metered ? { metered: true } : {});
  }
}
