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
  /** mcp.CLOUD_RELAY.14 — the account whose room this is, set by the Worker; a handshake must be for it. */
  room?: string | null;
}

/** mcp.CLOUD_RELAY.14 — set by the Worker (index.ts) on the upgrade it forwards to the room. */
export const ROOM_ACCOUNT_HEADER = "X-Kaption-Room-Account";

const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes — media downloads from WhatsApp CDN can be slow
// mcp.CLOUD_RELAY.5 — 16MB cap, JSON-RPC validation, origin restrict, 50 pending, hibernation
const MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // [H2] 16MB — must accommodate base64-encoded media (images, audio, video)
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
    this.setWsAttachment(server, { authenticated: false, accountRef: null, room: request.headers.get(ROOM_ACCOUNT_HEADER) });

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

    // mcp.CLOUD_RELAY.8 — relay is unprivileged; every tool needs live extension
    if (!this.extensionWs || !this.authenticated) {
      throw new Error(
        "Extension not connected. Open WhatsApp Web with Kaption extension and enable cloud bridge.",
      );
    }

    // mcp.RATE_LIMITS.3 — 50 in-flight cap; 51st rejects synchronously
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
  private async handleAuthHandshake(token: string, ws: WebSocket | null = this.extensionWs): Promise<void> {
    const session = await validateExtensionSession(
      this.env.OAUTH_KV,
      token,
      this.env.EPHEMERAL_STATE_SECRET,
    );
    if (!session || session.accountRef !== this.roomOf(ws)) {
      ws?.send(
        JSON.stringify({ type: "auth_error", error: "Invalid or expired token" }),
      );
      ws?.close(4001, "Authentication failed");
      if (this.extensionWs === ws) this.extensionWs = null;
      return;
    }

    this.authenticated = true;
    this.accountRef = session.accountRef;
    console.log(
      `[RelayRoom] Legacy auth OK, account=${sanitizeAccountRefForLog(session.accountRef)}`,
    );
    // mcp.CLOUD_RELAY.13 — the socket that sent this handshake, even if another spoke while it was checked.
    this.extensionWs = ws;
    if (ws) {
      this.setWsAttachment(ws, {
        authenticated: true,
        accountRef: session.accountRef,
        room: this.roomOf(ws),
      });
    }
    this.closeOtherSockets(ws);
    ws?.send(
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
  private async handleJwtAuth(jwt: string, ws: WebSocket | null = this.extensionWs): Promise<void> {
    const phone = await validateJwt(
      this.env.JWT_SECRET,
      jwt,
    );
    if (!phone) {
      ws?.send(
        JSON.stringify({ type: "auth_error", error: "Invalid or expired JWT" }),
      );
      ws?.close(4001, "JWT authentication failed");
      if (this.extensionWs === ws) this.extensionWs = null;
      return;
    }

    const derived = await deriveAccountRef(phone, this.env.PHONE_REF_SECRET);
    // mcp.CLOUD_RELAY.14 — a valid session for ANOTHER account is refused: the room is not its to answer.
    const accountRef = derived && derived === this.roomOf(ws) ? derived : null;
    if (!accountRef) {
      ws?.send(
        JSON.stringify({ type: "auth_error", error: "Invalid or expired JWT" }),
      );
      ws?.close(4001, "JWT authentication failed");
      if (this.extensionWs === ws) this.extensionWs = null;
      return;
    }

    this.authenticated = true;
    this.accountRef = accountRef;
    console.log(
      `[RelayRoom] JWT auth OK, account=${sanitizeAccountRefForLog(accountRef)}`,
    );
    // mcp.CLOUD_RELAY.13 — the socket that sent this handshake, even if another spoke while it was checked.
    this.extensionWs = ws;
    if (ws) {
      this.setWsAttachment(ws, { authenticated: true, accountRef, room: this.roomOf(ws) });
    }
    this.closeOtherSockets(ws);
    ws?.send(JSON.stringify({ type: "auth_ok", phone }));
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
    // mcp.CLOUD_RELAY.13 — the socket that spoke is the one to answer, with its own auth state. After hibernation
    // the room may still hold older sockets from the extension's earlier attempts; answering one of those (the
    // first, or an old authenticated one) sent auth_ok nowhere, so the extension timed out and retried for ever.
    this.extensionWs = ws;
    const attachment = this.readWsAttachment(ws);
    this.authenticated = attachment?.authenticated === true;
    this.accountRef = attachment?.accountRef ?? null;
    this.handleExtensionMessage(message);
  }

  /** mcp.CLOUD_RELAY.14 — the account this socket's room belongs to (null: unknown, and nothing authenticates). */
  private roomOf(ws: WebSocket | null): string | null {
    const room = ws ? this.readWsAttachment(ws)?.room : null;
    return typeof room === "string" && room ? room : null;
  }

  private readWsAttachment(ws: WebSocket): WsAttachment | null {
    try {
      return ((ws as any).deserializeAttachment?.() as WsAttachment | null) ?? null;
    } catch {
      return null;
    }
  }

  /** mcp.CLOUD_RELAY.13 — once a socket authenticates, the room's older sockets are gone for good. */
  private closeOtherSockets(current: WebSocket | null): void {
    if (!current) return;
    let sockets: WebSocket[] = [];
    try {
      sockets = this.ctx.getWebSockets();
    } catch {
      return;
    }
    for (const socket of sockets) {
      if (socket === current) continue;
      try {
        socket.close(4000, "Replaced by a newer connection");
      } catch {
        // already closed
      }
    }
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
