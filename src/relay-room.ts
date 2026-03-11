/**
 * RelayRoom Durable Object — one per phone number.
 *
 * The Chrome extension connects via WebSocket.
 * MCP tool calls arrive via handleMcpRequest() and are forwarded
 * to the extension, which executes them in the WhatsApp Web page context.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class RelayRoom extends DurableObject<Env> {
  private extensionWs: WebSocket | null = null;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private requestCounter = 0;

  /**
   * Handle WebSocket upgrade from the Chrome extension.
   */
  async handleExtensionWebSocket(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.extensionWs = server;

    server.addEventListener("message", (event) => {
      this.handleExtensionMessage(event.data as string);
    });

    server.addEventListener("close", () => {
      this.extensionWs = null;
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Extension disconnected"));
        this.pendingRequests.delete(id);
      }
    });

    server.addEventListener("error", () => {
      this.extensionWs = null;
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Forward an MCP tool call to the connected extension.
   * Returns the JSON-RPC result or throws on error/timeout.
   */
  async handleMcpRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.extensionWs) {
      throw new Error("Extension not connected. Open WhatsApp Web with Kaption extension and enable cloud bridge.");
    }

    const id = ++this.requestCounter;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        this.extensionWs!.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }),
        );
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Check if the extension is currently connected.
   */
  isExtensionConnected(): boolean {
    return this.extensionWs !== null;
  }

  /**
   * Handle incoming messages from the extension WebSocket.
   */
  private handleExtensionMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    // Heartbeat pong — ignore
    if (msg.type === "pong" || msg.method === "pong") {
      return;
    }

    // JSON-RPC response — resolve pending request
    if (msg.id !== undefined) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msg.id);

        if (msg.error) {
          pending.reject(
            new Error(msg.error.message || "Extension returned error"),
          );
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  /**
   * Durable Object WebSocket hibernation handler.
   * Called when a hibernated WebSocket receives a message.
   */
  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    // Re-establish as extension WS if needed
    if (!this.extensionWs) {
      this.extensionWs = ws;
    }
    this.handleExtensionMessage(message);
  }

  /**
   * Durable Object WebSocket hibernation handler for close events.
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.extensionWs === ws) {
      this.extensionWs = null;
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Extension disconnected"));
        this.pendingRequests.delete(id);
      }
    }
  }
}
