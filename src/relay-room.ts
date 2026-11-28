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
  openState,
  sanitizeAccountRefForLog,
  sealState,
  validateExtensionSession,
  validateJwt,
} from "./otp";
import { rememberPhoneAlias } from "./phone-alias";
import { readManageFeatures, visibleManageTools, type ManageFeatures } from "./manage-kaption";
import { bridgeResumeConfigured, bridgeResumeOnForPhone } from "./bridge-resume-flag";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** mcp.CLOUD_RELAY.15 — the socket the request went to; only its close rejects it. */
  ws?: WebSocket | null;
  /** mcp-bridge-resume.RELAY_HOLD.3 — what was sent, kept so a cut-off read can be sent once more. */
  method?: string;
  params?: Record<string, unknown>;
  extra?: RelayCallExtra;
  /** mcp-bridge-resume.RELAY_HOLD.3 — read-only: may be re-sent after its bridge dropped. */
  retry?: boolean;
  /** Already re-sent once: a second drop rejects it. */
  retried?: boolean;
  /** Waiting for a bridge since its own dropped (ms), with the timer that gives up. */
  orphanedAt?: number;
  orphanTimer?: ReturnType<typeof setTimeout> | null;
}

/** mcp-bridge-resume.RELAY_HOLD.1-6 — the room's memory of its bridge, kept in storage across hibernation. */
interface BridgeResumeState {
  /** MCP_BRIDGE_RESUME for the phone the last bridge signed in with. */
  on: boolean;
  /** The serving bridge's manage features (its auth message), for RELAY_HOLD.6. */
  features: ManageFeatures | null;
  /** When the last authenticated bridge closed; null while one is connected (or never seen). */
  closedAt: number | null;
}

/** mcp-bridge-resume.RELAY_HOLD.5 — what a held or re-sent call carries in `kaption.resume`. */
export interface RelayResumeMark {
  kind: "waited" | "retried";
  waitMs: number;
}

/** mcp-bridge-resume.RELAY_HOLD.1, RELAY_HOLD.3 — how long a call waits for a bridge to (re)authenticate. */
export const RESUME_WAIT_MS = 20_000;
/** mcp-bridge-resume.RELAY_HOLD.1-2, RELAY_HOLD.6 — a bridge seen this recently is expected back. */
export const RESUME_GRACE_MS = 10 * 60_000;
const BRIDGE_RESUME_KEY = "bridge-resume";

/** Coarse wait bucket for the log line (enums only). */
function waitBucket(ms: number): string {
  return ms < 2_000 ? "lt2s" : ms < 5_000 ? "2-5s" : ms < 10_000 ? "5-10s" : ms < 20_000 ? "10-20s" : "gt20s";
}

interface WsAttachment {
  authenticated: boolean;
  accountRef: string | null;
  /** mcp.CLOUD_RELAY.15 — when this socket authenticated (ms); the newest one serves requests. */
  authAt?: number;
  /** mcp.CLOUD_RELAY.15 — when the socket was opened (ms); an unauthenticated one older than this grace is stale. */
  openedAt?: number;
  /** mcp.CLOUD_RELAY.14 — the account whose room this is, set by the Worker; a handshake must be for it. */
  room?: string | null;
  /** mcp-manage-kaption.LIST.1 — the manage families this client said in its auth message (absent: said nothing). */
  features?: ManageFeatures;
  /**
   * business-plans.MCP_LEDGER.16 — the signed-in phone, sealed with EPHEMERAL_STATE_SECRET, only while this socket
   * lives, so the ledger can ask rest-api about the account. Never stored anywhere else.
   */
  phoneSeal?: string;
}

/** business-plans.MCP_LEDGER.9 — what the relay adds beside a call's params (the extension's cloud bridge reads it). */
export interface RelayCallExtra {
  metered?: boolean;
  /** mcp-local-hub-growth.CLIENT.3 — the MCP session's clientInfo (already sanitized, CLIENT.5). */
  client?: { name: string; version: string } | null;
  /** mcp-bridge-resume.RELAY_HOLD.3 — retry: the tool is read-only, so a call cut off by a bridge drop may be re-sent. */
  resume?: { retry: boolean };
}

/** mcp-manage-kaption.LIST.2 — MCP sessions (RelayMCP Durable Object ids) told when this room's manage tools change. */
const MANAGE_WATCHERS_KEY = "manage-watchers";
const MANAGE_VISIBLE_KEY = "manage-visible";
const MAX_MANAGE_WATCHERS = 50;
const MANAGE_WATCHER_TTL_MS = 7 * 24 * 3600 * 1000;

/** mcp.CLOUD_RELAY.14 — set by the Worker (index.ts) on the upgrade it forwards to the room. */
export const ROOM_ACCOUNT_HEADER = "X-Kaption-Room-Account";

/** mcp.CLOUD_RELAY.15 — an unauthenticated socket older than this is a client's abandoned attempt. */
const STALE_HANDSHAKE_MS = 30_000;
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
    this.setWsAttachment(server, { authenticated: false, accountRef: null, room: request.headers.get(ROOM_ACCOUNT_HEADER), openedAt: Date.now() });

    server.addEventListener("message", (event) => {
      this.handleExtensionMessage(event.data as string);
    });

    server.addEventListener("close", () => {
      this.forgetSocket(server);
      this.manageMaybeChanged(server);
    });

    server.addEventListener("error", () => {
      if (this.extensionWs === server) this.extensionWs = null;
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * mcp-usage-accounting.RECORD.5 — the same call as handleMcpRequest, settled instead of thrown, so the caller (in
   * another Durable Object) learns the JSON-RPC error code: errors lose their own properties across RPC.
   */
  async handleMcpRequestSettled(
    method: string,
    params: Record<string, unknown>,
    extra: RelayCallExtra = {},
  ): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code: number | string | null }> {
    try {
      return { ok: true, result: await this.handleMcpRequest(method, params, extra) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown })?.code;
      return { ok: false, message, code: typeof code === "number" || typeof code === "string" ? code : null };
    }
  }

  /**
   * Forward an MCP tool call to the connected extension.
   * Returns the JSON-RPC result or throws on error/timeout.
   */
  async handleMcpRequest(
    method: string,
    params: Record<string, unknown>,
    extra: RelayCallExtra = {},
  ): Promise<unknown> {
    // Restore state from hibernation if needed
    this.restoreFromHibernation();
    // mcp-bridge-resume.RELAY_HOLD.3 — known before a drop can cut this call off (one storage read per wake).
    // Not awaited: a connected bridge gets the call in the same turn, as before.
    if (!this.resumeLoaded) void this.loadResumeState();

    // mcp.CLOUD_RELAY.8 — relay is unprivileged; every tool needs live extension
    // mcp.CLOUD_RELAY.15 — several clients of one account may be connected; the newest authenticated one serves.
    let target = this.servingSocket();
    const arrivedAt = Date.now();
    let resume: RelayResumeMark | null = null;
    if (!target) {
      // mcp-bridge-resume.RELAY_HOLD.1-2 — a bridge seen in the last 10 minutes (or mid-handshake) is waited for, up to
      // 20 s; a room with no recent bridge answers at once, as before (so the alias room is tried straight away).
      const state = await this.loadResumeState();
      if (state?.on && this.bridgeExpected(state)) {
        // mcp-bridge-resume.RELAY_HOLD.4 — a held call counts against the 50.
        if (this.pendingRequests.size + this.resumeWaiters.size >= MAX_PENDING_REQUESTS) {
          throw new Error("Too many pending requests. Try again shortly.");
        }
        target = await this.waitForBridge(RESUME_WAIT_MS);
        const waitMs = Date.now() - arrivedAt;
        this.logResume("waited", target ? "served" : "gave-up", waitMs);
        if (target) resume = { kind: "waited", waitMs };
      }
      if (!target) {
        throw Object.assign(
          new Error("Extension not connected. Open WhatsApp Web with Kaption extension and enable cloud bridge."),
          { code: "offline" },
        );
      }
    }

    // mcp.RATE_LIMITS.3 — 50 in-flight cap; 51st rejects synchronously
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      throw new Error("Too many pending requests. Try again shortly.");
    }

    const id = ++this.requestCounter;
    const socketForCall = target;

    return new Promise((resolve, reject) => {
      // mcp-bridge-resume.RELAY_HOLD.4 — the 2-minute timeout runs from when the call reached the room.
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending?.orphanTimer) clearTimeout(pending.orphanTimer);
        this.pendingRequests.delete(id);
        reject(
          Object.assign(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`), { code: "timeout" }),
        );
      }, Math.max(0, REQUEST_TIMEOUT_MS - (Date.now() - arrivedAt)));

      const pending: PendingRequest = { resolve, reject, timeout, ws: socketForCall };
      if (extra.resume?.retry) Object.assign(pending, { method, params, extra, retry: true });
      this.pendingRequests.set(id, pending);

      try {
        this.sendCall(socketForCall, id, method, params, extra, resume);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /** One JSON-RPC call to a bridge. `resume` only after a wait or a re-send (mcp-bridge-resume.RELAY_HOLD.5). */
  private sendCall(
    ws: WebSocket,
    id: number | string,
    method: string,
    params: Record<string, unknown>,
    extra: RelayCallExtra,
    resume: RelayResumeMark | null,
  ): void {
    const kaption = {
      // business-plans.MCP_LEDGER.9 — the ledger already decided this call: the cloud bridge must not charge it.
      ...(extra.metered ? { metered: true } : {}),
      // mcp-bridge-resume.RELAY_HOLD.5 — the bridges read it only for their resumed-call KPI.
      ...(resume ? { resume: { kind: resume.kind, waitMs: resume.waitMs } } : {}),
    };
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
        ...(Object.keys(kaption).length ? { kaption } : {}),
        // mcp-local-hub-growth.CLIENT.3 — which AI app made the call, outside the tool's params.
        ...(extra.client ? { client: { name: extra.client.name, version: extra.client.version } } : {}),
      }),
    );
  }

  // ─── mcp-bridge-resume.RELAY_HOLD — calls held across a bridge reconnect ─────────────

  private resumeState: BridgeResumeState | null = null;
  private resumeLoaded = false;
  private resumeWaiters = new Set<{ resolve: (ws: WebSocket | null) => void; timer: ReturnType<typeof setTimeout> }>();

  /** The stored state (read once per wake); null when nothing was ever stored. */
  private async loadResumeState(): Promise<BridgeResumeState | null> {
    if (this.resumeLoaded) return this.resumeState;
    try {
      const stored = await this.ctx.storage?.get<BridgeResumeState>(BRIDGE_RESUME_KEY);
      // A value set while the read ran (an auth, a close) is newer than the stored one.
      if (!this.resumeLoaded) this.resumeState = stored ?? null;
    } catch {
      // no storage (tests): memory only
    }
    this.resumeLoaded = true;
    return this.resumeState;
  }

  private saveResumeState(next: BridgeResumeState): void {
    this.resumeState = next;
    this.resumeLoaded = true;
    const work = (async () => {
      await this.ctx.storage?.put(BRIDGE_RESUME_KEY, next);
    })().catch(() => undefined);
    this.keepAlive(work);
  }

  private keepAlive(work: Promise<unknown>): void {
    try {
      this.ctx.waitUntil(work);
    } catch {
      // no waitUntil outside the runtime (tests): the promise still runs
    }
  }

  /** mcp-bridge-resume.RELAY_HOLD.1 — a bridge was here in the last 10 minutes, or one is mid-handshake now. */
  private bridgeExpected(state: BridgeResumeState): boolean {
    const now = Date.now();
    if (state.closedAt !== null && now - state.closedAt < RESUME_GRACE_MS) return true;
    let sockets: WebSocket[] = [];
    try {
      sockets = this.ctx.getWebSockets();
    } catch {
      sockets = [];
    }
    return sockets.some((socket) => {
      const attachment = this.readWsAttachment(socket);
      return !attachment?.authenticated && typeof attachment?.openedAt === "number" && now - attachment.openedAt < STALE_HANDSHAKE_MS;
    });
  }

  private waitForBridge(ms: number): Promise<WebSocket | null> {
    return new Promise((resolve) => {
      const waiter = {
        resolve: (ws: WebSocket | null) => {
          clearTimeout(waiter.timer);
          this.resumeWaiters.delete(waiter);
          resolve(ws);
        },
        timer: setTimeout(() => waiter.resolve(null), ms),
      };
      this.resumeWaiters.add(waiter);
    });
  }

  /** mcp-bridge-resume.FLAG.2 — MCP_BRIDGE_RESUME for the phone this bridge signed in with, asked in the background. */
  private noteBridgeAuthenticated(phone: string | null | undefined, features: ManageFeatures | undefined): void {
    const previous = this.resumeState;
    const base: BridgeResumeState = { on: previous?.on ?? false, features: features ?? {}, closedAt: null };
    if (!bridgeResumeConfigured(this.env)) {
      // Kill switch: nothing asked; a stored on is cleared so no call waits and no tool stays listed.
      if (previous?.on) this.saveResumeState({ ...base, on: false });
      else this.resumeState = previous ? { ...previous, features: base.features, closedAt: null } : null;
      return;
    }
    // Storage is written only while the flag is (or was) on for this room; off, memory only.
    if (previous?.on) this.saveResumeState(base);
    else {
      this.resumeState = base;
      this.resumeLoaded = true;
    }
    if (!phone) return;
    this.keepAlive(
      bridgeResumeOnForPhone(this.env, phone)
        .then((on) => {
          const current = this.resumeState ?? base;
          if (current.on !== on) this.saveResumeState({ ...current, on });
        })
        .catch(() => undefined),
    );
  }

  /** A socket authenticated: held calls go to it, and calls cut off by a drop are sent once more (RELAY_HOLD.1, .3). */
  private serveHeldCalls(ws: WebSocket | null): void {
    if (!ws) return;
    for (const waiter of [...this.resumeWaiters]) waiter.resolve(ws);
    const now = Date.now();
    for (const [id, pending] of this.pendingRequests) {
      if (pending.orphanedAt === undefined) continue;
      if (pending.orphanTimer) clearTimeout(pending.orphanTimer);
      const waitMs = now - pending.orphanedAt;
      pending.orphanTimer = null;
      pending.orphanedAt = undefined;
      pending.retried = true;
      pending.ws = ws;
      try {
        this.sendCall(ws, id, pending.method!, pending.params ?? {}, pending.extra ?? {}, { kind: "retried", waitMs });
        this.logResume("retried", "sent", waitMs);
      } catch (err) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        pending.reject(err);
      }
    }
  }

  /** mcp-bridge-resume.RELAY_HOLD.6 — after the grace, the sessions are told the tools the room lists now. */
  async alarm(): Promise<void> {
    await this.loadResumeState();
    this.restoreFromHibernation();
    this.manageMaybeChanged();
  }

  private logResume(kind: "waited" | "retried", outcome: string, waitMs: number): void {
    console.log(
      `[RelayRoom] bridge-resume kind=${kind} outcome=${outcome} wait=${waitBucket(waitMs)} account=${this.accountRef ? sanitizeAccountRefForLog(this.accountRef) : "-"}`,
    );
  }

  /**
   * Check if the extension is currently connected and authenticated.
   */
  isExtensionConnected(): boolean {
    this.restoreFromHibernation();
    return this.servingSocket() !== null;
  }

  /** mcp.CLOUD_RELAY.15 — the newest authenticated socket of this room, or null. */
  private servingSocket(exclude: WebSocket | null = null): WebSocket | null {
    let sockets: WebSocket[] = [];
    try {
      sockets = this.ctx.getWebSockets();
    } catch {
      sockets = [];
    }
    let best: WebSocket | null = null;
    let bestAt = -1;
    for (const socket of sockets) {
      if (socket === exclude) continue;
      const attachment = this.readWsAttachment(socket);
      if (!attachment?.authenticated) continue;
      const at = typeof attachment.authAt === "number" ? attachment.authAt : 0;
      if (at >= bestAt) {
        best = socket;
        bestAt = at;
      }
    }
    if (best) return best;
    // Outside hibernation (tests, first run) the in-memory state is the only record.
    return this.extensionWs && this.authenticated && this.extensionWs !== exclude ? this.extensionWs : null;
  }

  // ─── mcp-manage-kaption.LIST.2 — which manage tools this account's MCP sessions list ─────────────

  /**
   * The manage families the serving socket (the one calls go to, CLOUD_RELAY.15) said in its auth message; {} when it
   * said nothing (older extensions: the tools stay hidden), null when no extension is connected.
   */
  manageFeatures(exclude: WebSocket | null = null): ManageFeatures | null {
    this.restoreFromHibernation();
    const socket = this.servingSocket(exclude);
    if (!socket) {
      // mcp-bridge-resume.RELAY_HOLD.6 — for 10 minutes after the serving bridge closed, its tools stay listed, so a
      // reconnect does not remove and re-add them in Claude or ChatGPT (alarm() tells the sessions after that).
      const state = this.resumeState;
      if (state?.on && state.features && state.closedAt !== null && Date.now() - state.closedAt < RESUME_GRACE_MS) {
        return readManageFeatures(state.features);
      }
      return null;
    }
    return readManageFeatures(this.readWsAttachment(socket)?.features);
  }

  /** manageFeatures(), and the MCP session `watcherId` is told (refreshManageVisibility) when they change. */
  async watchManage(watcherId: string): Promise<ManageFeatures | null> {
    if (typeof watcherId === "string" && /^[0-9a-f]{16,128}$/i.test(watcherId)) {
      try {
        const now = Date.now();
        const watchers = { ...((await this.ctx.storage?.get<Record<string, number>>(MANAGE_WATCHERS_KEY)) ?? {}) };
        watchers[watcherId] = now;
        const kept = Object.entries(watchers)
          .filter(([, at]) => now - at < MANAGE_WATCHER_TTL_MS)
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_MANAGE_WATCHERS);
        await this.ctx.storage?.put(MANAGE_WATCHERS_KEY, Object.fromEntries(kept));
      } catch {
        // no storage (tests): the session still gets the features
      }
    }
    await this.loadResumeState();
    return this.manageFeatures();
  }

  /** After a socket authenticates or closes: when the listed manage tools change, tell the watching MCP sessions. */
  private manageMaybeChanged(closing: WebSocket | null = null): void {
    const work = (async () => {
      const storage = this.ctx.storage;
      if (!storage) return;
      const visible = [...visibleManageTools([this.manageFeatures(closing)])].join(",");
      if ((await storage.get<string>(MANAGE_VISIBLE_KEY)) === visible) return;
      await storage.put(MANAGE_VISIBLE_KEY, visible);
      const watchers = (await storage.get<Record<string, number>>(MANAGE_WATCHERS_KEY)) ?? {};
      const namespace = this.env.MCP_OBJECT;
      if (!namespace) return;
      const gone: string[] = [];
      await Promise.all(Object.keys(watchers).map(async (id) => {
        try {
          await (namespace.get(namespace.idFromString(id)) as unknown as { refreshManageVisibility(): Promise<unknown> })
            .refreshManageVisibility();
        } catch {
          gone.push(id);
        }
      }));
      if (gone.length) {
        const left = { ...watchers };
        for (const id of gone) delete left[id];
        await storage.put(MANAGE_WATCHERS_KEY, left);
      }
    })().catch((e) => console.warn("[RelayRoom] manage tools change not sent:", e instanceof Error ? e.message : e));
    try {
      this.ctx.waitUntil(work);
    } catch {
      // no waitUntil outside the runtime (tests): the promise still runs
    }
  }

  /** mcp.CLOUD_RELAY.15 — a closed socket takes only its own in-flight requests with it. */
  private forgetSocket(ws: WebSocket): void {
    const wasAuthenticated = this.readWsAttachment(ws)?.authenticated === true || (this.extensionWs === ws && this.authenticated);
    const closingFeatures = this.readWsAttachment(ws)?.features;
    if (this.extensionWs === ws) {
      this.extensionWs = null;
      this.authenticated = false;
      this.accountRef = null;
    }
    const state = this.resumeState;
    const resumeOn = state?.on === true;
    // mcp-bridge-resume.RELAY_HOLD.1, RELAY_HOLD.6 — the last serving bridge left: remember when, and what it listed.
    if (resumeOn && wasAuthenticated && !this.servingSocket(ws)) {
      const closedAt = Date.now();
      this.saveResumeState({ on: true, features: closingFeatures ? readManageFeatures(closingFeatures) : state!.features, closedAt });
      this.keepAlive((async () => {
        await this.ctx.storage?.setAlarm?.(closedAt + RESUME_GRACE_MS);
      })().catch(() => undefined));
    }
    for (const [id, pending] of this.pendingRequests) {
      // mcp-bridge-resume.RELAY_HOLD.3 — already waiting for a bridge: its own timer decides.
      if (pending.orphanedAt !== undefined) continue;
      if (pending.ws && pending.ws !== ws) continue;
      // mcp-bridge-resume.RELAY_HOLD.3 — a read cut off by the drop waits (once) for the next bridge; a write never.
      if (resumeOn && pending.retry && !pending.retried) {
        pending.ws = null;
        pending.orphanedAt = Date.now();
        pending.orphanTimer = setTimeout(() => {
          if (!this.pendingRequests.has(id)) return;
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(id);
          this.logResume("retried", "gave-up", Date.now() - (pending.orphanedAt ?? Date.now()));
          pending.reject(new Error("Extension disconnected"));
        }, RESUME_WAIT_MS);
        continue;
      }
      clearTimeout(pending.timeout);
      pending.reject(new Error("Extension disconnected"));
      this.pendingRequests.delete(id);
    }
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
      // mcp-manage-kaption.LIST.1 — the auth message may say which manage families this account may use.
      const features = obj.features && typeof obj.features === "object" ? readManageFeatures(obj.features) : undefined;
      if (typeof obj.jwt === "string") {
        this.handleJwtAuth(obj.jwt as string, this.extensionWs, features);
      } else {
        this.handleAuthHandshake(obj.token as string, this.extensionWs, features);
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
            Object.assign(
              new Error(
                (errObj.message as string) || "Extension returned error",
              ),
              // mcp-usage-accounting.RECORD.5 — -32003 is a plan-limit refusal.
              { code: typeof errObj.code === "number" ? errObj.code : null },
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
  private async handleAuthHandshake(
    token: string,
    ws: WebSocket | null = this.extensionWs,
    features?: ManageFeatures,
  ): Promise<void> {
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
        authAt: Date.now(),
        ...(features ? { features } : {}),
      });
    }
    this.closeOtherSockets(ws);
    this.manageMaybeChanged();
    if (session.phone) this.rememberAlias(session.phone, session.accountRef);
    ws?.send(
      JSON.stringify(
        session.phone
          ? { type: "auth_ok", phone: session.phone }
          : { type: "auth_ok" },
      ),
    );
    // mcp-bridge-resume.FLAG.2, RELAY_HOLD.1, RELAY_HOLD.3 — the flag for this phone, then the calls held for a bridge.
    this.noteBridgeAuthenticated(session.phone, features);
    this.serveHeldCalls(ws);
    if (session.phone) await this.rememberPhoneSeal(ws, session.phone);
  }

  /** business-plans.MCP_LEDGER.16 — seals the phone into the socket's attachment (only when metering is on). */
  private async rememberPhoneSeal(ws: WebSocket | null, phone: string): Promise<void> {
    if (!ws || this.env.MCP_OVERAGE_LEDGER !== "on" || !this.env.EPHEMERAL_STATE_SECRET) return;
    try {
      const seal = await sealState({ phone }, 7 * 24 * 3600, this.env.EPHEMERAL_STATE_SECRET);
      const current = this.readWsAttachment(ws);
      if (current?.authenticated) this.setWsAttachment(ws, { ...current, phoneSeal: seal });
    } catch (e) {
      console.error("[RelayRoom] phone seal failed:", e instanceof Error ? e.message : e);
    }
  }

  /**
   * business-plans.MCP_LEDGER.16 — the phone of the extension that serves this room's calls, for the usage ledger's
   * questions to rest-api; null when none is connected (or it signed in without a phone).
   */
  async meteringPhone(): Promise<string | null> {
    this.restoreFromHibernation();
    const target = this.servingSocket();
    const seal = target ? this.readWsAttachment(target)?.phoneSeal : undefined;
    if (!seal || !this.env.EPHEMERAL_STATE_SECRET) return null;
    const opened = await openState<{ phone?: string }>(seal, this.env.EPHEMERAL_STATE_SECRET).catch(() => null);
    return typeof opened?.phone === "string" ? opened.phone : null;
  }

  /**
   * Validate a Kaption JWT sent in the auth handshake.
   * Calls the internal API to verify the JWT and extract the phone number.
   */
  private async handleJwtAuth(
    jwt: string,
    ws: WebSocket | null = this.extensionWs,
    features?: ManageFeatures,
  ): Promise<void> {
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
      this.setWsAttachment(ws, {
        authenticated: true,
        accountRef,
        room: this.roomOf(ws),
        authAt: Date.now(),
        ...(features ? { features } : {}),
      });
    }
    this.closeOtherSockets(ws);
    this.manageMaybeChanged();
    this.rememberAlias(phone, accountRef);
    ws?.send(JSON.stringify({ type: "auth_ok", phone }));
    // mcp-bridge-resume.FLAG.2, RELAY_HOLD.1, RELAY_HOLD.3 — the flag for this phone, then the calls held for a bridge.
    this.noteBridgeAuthenticated(phone, features);
    this.serveHeldCalls(ws);
    await this.rememberPhoneSeal(ws, phone);
  }

  /** mcp.CLOUD_RELAY.17 — connections made with this phone's other Brazilian form find this room. Never blocks auth. */
  private rememberAlias(phone: string, roomRef: string): void {
    const pending = rememberPhoneAlias(this.env.OAUTH_KV, phone, roomRef, this.env.PHONE_REF_SECRET).catch((e) => {
      console.warn("[RelayRoom] alias not recorded:", e instanceof Error ? e.message : e);
    });
    try {
      this.ctx.waitUntil(pending);
    } catch {
      // no waitUntil outside the runtime (tests): the promise still runs
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

  /**
   * mcp.CLOUD_RELAY.13, CLOUD_RELAY.15 — once a socket authenticates, the room's leftover sockets that never
   * authenticated (a client's earlier attempts) are closed. Another AUTHENTICATED socket is a different client of
   * the same account (Kaption.app and a browser, two browsers) and is kept: closing it made the two replace each
   * other every few seconds, for ever (found 2026-09-30). Requests go to the newest authenticated socket.
   */
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
      const attachment = this.readWsAttachment(socket);
      if (attachment?.authenticated) continue;
      // Another client may be mid-handshake: only an attempt left unauthenticated past the grace is stale.
      if (typeof attachment?.openedAt === "number" && Date.now() - attachment.openedAt < STALE_HANDSHAKE_MS) continue;
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
    await this.loadResumeState();
    this.forgetSocket(ws);
    this.manageMaybeChanged(ws);
  }
}
