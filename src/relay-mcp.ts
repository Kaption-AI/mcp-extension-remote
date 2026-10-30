/**
 * RelayMCP — McpAgent Durable Object that registers tools and relays
 * tool calls to the appropriate RelayRoom (by account reference).
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CLOUD_TOOLS, PUBLIC_TOOL_OUTPUT_SCHEMA } from "./tools";
import { scrubInlineMedia } from "./media-scrub";
import type { Env } from "./types";
import { relayWithAliasSettled } from "./phone-alias";
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

  async init() {
    // mcp.CLOUD_RELAY.6 — registers same ten tools; relays to RelayRoom, never executes locally
    for (const tool of CLOUD_TOOLS) {
      // Use registerTool() with explicit config object — server.tool() has
      // ambiguous overloads that misinterpret ZodObject schemas as annotations
      // (because ZodObject has _def so isZodRawShapeCompat returns false).
      this.server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: PUBLIC_TOOL_OUTPUT_SCHEMA,
          annotations: tool.annotations,
          // The installed MCP SDK predates the top-level securitySchemes
          // field, so mirror it in _meta for ChatGPT compatibility. Endpoint
          // authentication is still enforced by OAuthProvider.
          _meta: {
            securitySchemes: [{ type: "oauth2", scopes: ["kaption:access"] }],
            "openai/toolInvocation/invoking": `Running ${tool.title ?? tool.name}…`,
            "openai/toolInvocation/invoked": `${tool.title ?? tool.name} complete`,
          },
        },
        async (args: Record<string, unknown>) => {
          const accountRef = this.getAccountRef();
          if (!accountRef) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Authentication error: no account reference in token. Re-authenticate via OTP.",
                },
              ],
            };
          }

          // mcp-usage-accounting.RECORD.1 — every tool call is counted, whatever its outcome.
          const started = Date.now();
          const usage = this.usageContext(accountRef, tool.name, args, started);
          let failure: unknown = null;
          try {
            // Sanitize args for DO RPC — the MCP SDK may inject non-serializable
            // properties (AbortSignal etc.) into the args object
            const cleanArgs = JSON.parse(JSON.stringify(args));
            const { sanitizeAccountRefForLog } = await import("./otp");
            console.log(
              `[RelayMCP] Relaying ${tool.name} to account=${sanitizeAccountRefForLog(accountRef)} app=${await this.appName(accountRef)}`,
            );
            let result = await this.relayToExtension(accountRef, tool.name, cleanArgs);

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
              structuredContent: { result },
            };
          } catch (err: any) {
            failure = err ?? new Error("Tool call failed");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: ${err.message}`,
                },
              ],
              isError: true,
            };
          } finally {
            this.recordUsage(usage, failure, Date.now() - started);
          }
        },
      );
    }
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
