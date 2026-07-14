/**
 * RelayMCP — McpAgent Durable Object that registers tools and relays
 * tool calls to the appropriate RelayRoom (by account reference).
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS } from "./tools";
import { scrubInlineMedia } from "./media-scrub";
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
          annotations: tool.annotations,
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
