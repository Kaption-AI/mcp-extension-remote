/**
 * RelayMCP — McpAgent Durable Object that registers tools and relays
 * tool calls to the appropriate RelayRoom (by account reference).
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS } from "./tools";
import type { Env } from "./types";

export class RelayMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "Kaption WhatsApp MCP (Cloud)",
    version: "1.0.0",
  }) as any; // McpServer version compat between agents and @modelcontextprotocol/sdk

  async init() {
    // mcp.CLOUD_RELAY.6 — registers same ten tools; relays to RelayRoom, never executes locally
    for (const tool of TOOLS) {
      // Use registerTool() with explicit config object — server.tool() has
      // ambiguous overloads that misinterpret ZodObject schemas as annotations
      // (because ZodObject has _def so isZodRawShapeCompat returns false).
      this.server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
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

          try {
            // Sanitize args for DO RPC — the MCP SDK may inject non-serializable
            // properties (AbortSignal etc.) into the args object
            const cleanArgs = JSON.parse(JSON.stringify(args));
            const { sanitizeAccountRefForLog } = await import("./otp");
            console.log(
              `[RelayMCP] Relaying ${tool.name} to account=${sanitizeAccountRefForLog(accountRef)}`,
            );
            let result = await this.relayToExtension(accountRef, tool.name, cleanArgs);

            // mcp.TOOLS.6 — strip base64_data from download_media at McpAgent boundary
            // Strip base64_data from download_media responses to avoid polluting
            // the model's context window with large binary payloads.
            if (tool.name === "download_media" && result && typeof result === "object") {
              const obj = result as Record<string, unknown>;
              if (obj.base64_data) {
                const sizeBytes = typeof obj.base64_data === "string"
                  ? Math.round((obj.base64_data as string).length * 3 / 4)
                  : undefined;
                const { base64_data: _, ...rest } = obj;
                result = {
                  ...rest,
                  _note: `base64_data stripped (${sizeBytes ? `~${(sizeBytes / 1024).toFixed(0)}KB` : "unknown size"}). The raw media was delivered to the client but excluded from this response to save context.`,
                };
              }
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: ${err.message}`,
                },
              ],
              isError: true,
            };
          }
        },
      );
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
    const roomId = this.env.RELAY_ROOM.idFromName(accountRef);
    const room = this.env.RELAY_ROOM.get(roomId);
    return room.handleMcpRequest(method, params);
  }
}
