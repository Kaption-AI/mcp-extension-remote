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
import type { Env } from "./types";
import { manageFeaturesWithAlias, relayWithAliasSettled } from "./phone-alias";
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
        try {
          // Sanitize args for DO RPC — the MCP SDK may inject non-serializable
          // properties (AbortSignal etc.) into the args object
          const cleanArgs = JSON.parse(JSON.stringify(routed.params));
          const { sanitizeAccountRefForLog } = await import("./otp");
          console.log(
            `[RelayMCP] Relaying ${tool.name} to account=${sanitizeAccountRefForLog(accountRef)} app=${await this.appName(accountRef)}`,
          );
          let result = await this.relayToExtension(accountRef, routed.method, cleanArgs);

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

          return {
            content: [
              {
                type: "text" as const,
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
            ],
            structuredContent: (isPlans ? plansStructuredContent(result) : undefined) ?? { result },
          };
        } catch (err: any) {
          failure = err ?? new Error("Tool call failed");
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
    };
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
  ): Promise<unknown> {
    // mcp.CLOUD_RELAY.17 — follows a Brazilian number's other form when this account has no extension.
    return relayWithAliasSettled(this.env, accountRef, method, params);
  }
}
