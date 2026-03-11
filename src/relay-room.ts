/**
 * RelayRoom Durable Object — one per phone number.
 *
 * The Chrome extension connects via WebSocket.
 * MCP tool calls arrive via handleMcpRequest() and are forwarded
 * to the extension, which executes them in the WhatsApp Web page context.
 *
 * Security hardening:
 * - [H2] Message size limit (64KB) + JSON-RPC schema validation
 * - [H3] Origin validation on WebSocket upgrade
 * - [H6] Token sent in first WebSocket message (auth handshake), not URL
 * - [M5] Pending requests capped at 50
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { validateExtensionSession } from "./otp";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_SIZE = 64 * 1024; // [H2] 64KB
const MAX_PENDING_REQUESTS = 50; // [M5]

/** [H3] Allowed WebSocket origins */
const ALLOWED_ORIGIN_PATTERNS = [
  /^chrome-extension:\/\//,
  /^https:\/\/([a-z0-9-]+\.)?kaptionai\.com$/,
];

/** [H2] Validate JSON-RPC message structure */
function isValidJsonRpc(msg: unknown): msg is Record<string, unknown> {
  if (typeof msg !== "object" || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  // Must have jsonrpc field or be a known message type
  if (obj.jsonrpc === "2.0") {
    // Request: must have id + method
    if (obj.method !== undefined && obj.id !== undefined) return true;
    // Response: must have id + (result or error)
    if (obj.id !== undefined && (obj.result !== undefined || obj.error !== undefined)) return true;
  }
  // Allow heartbeat messages
  if (obj.type === "pong" || obj.method === "pong") return true;
  // Allow auth handshake
  if (obj.type === "auth" && typeof obj.token === "string") return true;
  return false;
}

export class RelayRoom extends DurableObject<Env> {
  private extensionWs: WebSocket | null = null;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private requestCounter = 0;
  private authenticated = false;
  private phone: string | null = null;

  /**
   * Handle WebSocket upgrade from the Chrome extension.
   * [H3] Validates Origin header. [H6] Token via auth handshake message.
   */
  async handleExtensionWebSocket(request: Request): Promise<Response> {
    // [H3] Validate Origin header
    const origin = request.headers.get("Origin");
    if (origin && !ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(origin))) {
      return new Response("Forbidden: invalid origin", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.extensionWs = server;
    this.authenticated = false;

    server.addEventListener("message", (event) => {
      this.handleExtensionMessage(event.data as string);
    });

    server.addEventListener("close", () => {
      this.extensionWs = null;
      this.authenticated = false;
      this.phone = null;
      this.rejectAllPending("Extension disconnected");
    });

    server.addEventListener("error", () => {
      this.extensionWs = null;
      this.authenticated = false;
      this.phone = null;
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
    if (!this.extensionWs || !this.authenticated) {
      throw new Error(
        "Extension not connected. Open WhatsApp Web with Kaption extension and enable cloud bridge.",
      );
    }

    // [M5] Cap pending requests
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      throw new Error("Too many pending requests. Try again shortly.");
    }

    const id = ++this.requestCounter;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`),
        );
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
   * Check if the extension is currently connected and authenticated.
   */
  isExtensionConnected(): boolean {
    return this.extensionWs !== null && this.authenticated;
  }

  /**
   * Handle incoming messages from the extension WebSocket.
   */
  private handleExtensionMessage(data: string): void {
    // [H2] Reject oversized messages
    if (data.length > MAX_MESSAGE_SIZE) {
      this.extensionWs?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Message too large" },
          id: null,
        }),
      );
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    // [H2] Validate message structure
    if (!isValidJsonRpc(msg)) {
      this.extensionWs?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Invalid message format" },
          id: null,
        }),
      );
      return;
    }

    const obj = msg as Record<string, unknown>;

    // [H6] Auth handshake — first message must authenticate
    if (obj.type === "auth" && typeof obj.token === "string") {
      this.handleAuthHandshake(obj.token as string);
      return;
    }

    // Reject messages from unauthenticated connections
    if (!this.authenticated) {
      this.extensionWs?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Not authenticated. Send auth message first." },
          id: null,
        }),
      );
      return;
    }

    // Heartbeat pong — ignore
    if (obj.type === "pong" || obj.method === "pong") {
      return;
    }

    // JSON-RPC response — resolve pending request
    if (obj.id !== undefined) {
      const pending = this.pendingRequests.get(obj.id as string | number);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(obj.id as string | number);

        if (obj.error) {
          const errObj = obj.error as Record<string, unknown>;
          pending.reject(
            new Error(
              (errObj.message as string) || "Extension returned error",
            ),
          );
        } else {
          pending.resolve(obj.result);
        }
      }
    }
  }

  /**
   * [H6] Validate the auth token sent in the first WebSocket message.
   */
  private async handleAuthHandshake(token: string): Promise<void> {
    const phone = await validateExtensionSession(this.env.EXT_AUTH_KV, token);
    if (!phone) {
      this.extensionWs?.send(
        JSON.stringify({ type: "auth_error", error: "Invalid or expired token" }),
      );
      this.extensionWs?.close(4001, "Authentication failed");
      this.extensionWs = null;
      return;
    }

    this.authenticated = true;
    this.phone = phone;
    this.extensionWs?.send(JSON.stringify({ type: "auth_ok", phone }));
  }

  /**
   * Reject all pending requests with the given reason.
   */
  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Durable Object WebSocket hibernation handler.
   */
  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
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
      this.authenticated = false;
      this.phone = null;
      this.rejectAllPending("Extension disconnected");
    }
  }
}
