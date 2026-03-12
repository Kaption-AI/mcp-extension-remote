/**
 * RelayRoom Durable Object — one per account reference.
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
 *
 * Hibernation: Auth state is persisted via WebSocket attachment tags
 * so that the DO can hibernate and resume without losing the connection.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import {
  deriveAccountRef,
  sanitizeAccountRefForLog,
  validateExtensionSession,
  validateJwt,
} from "./otp";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface WsAttachment {
  authenticated: boolean;
  accountRef: string | null;
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
  if (obj.type === "ping" || obj.type === "pong" || obj.method === "pong") return true;
  // Allow auth handshake (JWT-based or legacy token-based)
  if (obj.type === "auth" && (typeof obj.jwt === "string" || typeof obj.token === "string")) return true;
  return false;
}

export class RelayRoom extends DurableObject<Env> {
  private extensionWs: WebSocket | null = null;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private requestCounter = 0;
  private authenticated = false;
  private accountRef: string | null = null;

  /**
   * Route incoming fetch requests — handles WebSocket upgrades for the extension.
   */
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader === "websocket") {
      return this.handleExtensionWebSocket(request);
    }
    return new Response("Not found", { status: 404 });
  }

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
    this.accountRef = null;
    // Persist initial (unauthenticated) state in WS attachment for hibernation
    this.setWsAttachment(server, { authenticated: false, accountRef: null });

    server.addEventListener("message", (event) => {
      this.handleExtensionMessage(event.data as string);
    });

    server.addEventListener("close", () => {
      this.extensionWs = null;
      this.authenticated = false;
      this.accountRef = null;
      this.rejectAllPending("Extension disconnected");
    });

    server.addEventListener("error", () => {
      this.extensionWs = null;
      this.authenticated = false;
      this.accountRef = null;
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
    // Restore state from hibernation if needed
    this.restoreFromHibernation();

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
    this.restoreFromHibernation();
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

    // [H6] Auth handshake — first message must authenticate (JWT or legacy token)
    if (obj.type === "auth" && (typeof obj.jwt === "string" || typeof obj.token === "string")) {
      if (typeof obj.jwt === "string") {
        this.handleJwtAuth(obj.jwt as string);
      } else {
        this.handleAuthHandshake(obj.token as string);
      }
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

    // Heartbeat ping — respond with pong
    if (obj.type === "ping") {
      this.extensionWs?.send(JSON.stringify({ type: "pong" }));
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
   * [H6] Validate the auth token sent in the first WebSocket message (legacy).
   */
  private async handleAuthHandshake(token: string): Promise<void> {
    const session = await validateExtensionSession(
      this.env.OAUTH_KV,
      token,
      this.env.EPHEMERAL_STATE_SECRET,
    );
    if (!session) {
      this.extensionWs?.send(
        JSON.stringify({ type: "auth_error", error: "Invalid or expired token" }),
      );
      this.extensionWs?.close(4001, "Authentication failed");
      this.extensionWs = null;
      return;
    }

    this.authenticated = true;
    this.accountRef = session.accountRef;
    console.log(
      `[RelayRoom] Legacy auth OK, account=${sanitizeAccountRefForLog(session.accountRef)}`,
    );
    if (this.extensionWs) {
      this.setWsAttachment(this.extensionWs, {
        authenticated: true,
        accountRef: session.accountRef,
      });
    }
    this.extensionWs?.send(
      JSON.stringify(
        session.phone
          ? { type: "auth_ok", phone: session.phone }
          : { type: "auth_ok" },
      ),
    );
  }

  /**
   * Validate a Kaption JWT sent in the auth handshake.
   * Calls the internal API to verify the JWT and extract the phone number.
   */
  private async handleJwtAuth(jwt: string): Promise<void> {
    const phone = await validateJwt(
      this.env.JWT_SECRET,
      jwt,
    );
    if (!phone) {
      this.extensionWs?.send(
        JSON.stringify({ type: "auth_error", error: "Invalid or expired JWT" }),
      );
      this.extensionWs?.close(4001, "JWT authentication failed");
      this.extensionWs = null;
      return;
    }

    const accountRef = await deriveAccountRef(phone, this.env.PHONE_REF_SECRET);
    if (!accountRef) {
      this.extensionWs?.send(
        JSON.stringify({ type: "auth_error", error: "Invalid or expired JWT" }),
      );
      this.extensionWs?.close(4001, "JWT authentication failed");
      this.extensionWs = null;
      return;
    }

    this.authenticated = true;
    this.accountRef = accountRef;
    console.log(
      `[RelayRoom] JWT auth OK, account=${sanitizeAccountRefForLog(accountRef)}`,
    );
    if (this.extensionWs) {
      this.setWsAttachment(this.extensionWs, { authenticated: true, accountRef });
    }
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

  // ─── Hibernation support ─────────────────────────────────────────────

  /**
   * Persist auth state in the WebSocket attachment so it survives hibernation.
   */
  private setWsAttachment(ws: WebSocket, attachment: WsAttachment): void {
    try {
      (ws as any).serializeAttachment(attachment);
    } catch {
      // serializeAttachment not available outside hibernation context
    }
  }

  /**
   * Restore in-memory state from WebSocket attachments after hibernation.
   * Called when the DO wakes up (from webSocketMessage or handleMcpRequest).
   */
  private restoreFromHibernation(): void {
    if (this.extensionWs && this.authenticated) return; // Already restored

    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;

    // Find the authenticated WebSocket
    for (const ws of sockets) {
      try {
        const attachment = (ws as any).deserializeAttachment() as WsAttachment | null;
        if (attachment?.authenticated) {
          this.extensionWs = ws;
          this.authenticated = true;
          this.accountRef = attachment.accountRef;
          return;
        }
      } catch {
        // ignore
      }
    }

    // No authenticated socket found — pick first available
    if (!this.extensionWs && sockets.length > 0) {
      this.extensionWs = sockets[0];
    }
  }

  /**
   * Durable Object WebSocket hibernation handler.
   */
  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    // Restore auth state from attachment after hibernation
    this.restoreFromHibernation();
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
      this.accountRef = null;
      this.rejectAllPending("Extension disconnected");
    }
  }
}
