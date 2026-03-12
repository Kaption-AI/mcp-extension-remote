/**
 * RelayMCP — McpAgent Durable Object that registers tools and relays
 * tool calls to the appropriate RelayRoom (by phone number).
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
    for (const tool of TOOLS) {
      this.server.tool(
        tool.name,
        tool.description,
        tool.inputSchema,
        async (args: Record<string, unknown>) => {
          const phone = this.getPhone();
          if (!phone) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Authentication error: no phone number in token. Re-authenticate via OTP.",
                },
              ],
            };
          }

          try {
            // Sanitize args for DO RPC — the MCP SDK may inject non-serializable
            // properties (AbortSignal etc.) into the args object
            const cleanArgs = JSON.parse(JSON.stringify(args));
            console.log(`[RelayMCP] Relaying ${tool.name} to phone=${phone}`);
            const result = await this.relayToExtension(phone, tool.name, cleanArgs);
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

  private getPhone(): string | null {
    try {
      const props = (this as any).props;
      if (props?.phone) return props.phone;
    } catch {
      // ignore
    }
    return null;
  }

  private async relayToExtension(
    phone: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const roomId = this.env.RELAY_ROOM.idFromName(phone);
    const room = this.env.RELAY_ROOM.get(roomId);
    return room.handleMcpRequest(method, params);
  }
}
