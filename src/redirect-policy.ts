/**
 * mcp.CLOUD_RELAY.16 — where an OAuth client may send people back after they connect.
 *
 * Dynamic client registration (RFC 7591) stays open, because Claude, ChatGPT, Codex, Cursor and every other MCP client
 * register themselves at POST /register. What it no longer accepts is an arbitrary redirect URI: a stranger could
 * register "Claude" with a redirect to their own site and send people a sign-in link whose code ended up there
 * (security report #2198, 2026-10-06). A redirect must now be one of:
 *
 * - an https address on a known MCP client's own domain (KNOWN_CLIENT_DOMAINS, subdomains included) or one of the
 *   exact hosts in KNOWN_CLIENT_HOSTS;
 * - a loopback address on any port and path (http or https on localhost, 127.0.0.0/8, [::1]): what CLI and desktop
 *   clients — Claude Code, Codex, Cursor, VS Code, OpenCode — listen on (RFC 8252 §7.3). A code sent there never leaves
 *   the person's own computer;
 * - a known desktop app's own scheme (claude://, cursor://, vscode://…, RFC 8252 §7.1).
 *
 * The list came from the redirect URIs real clients registered, and completed connections with, in the 90 days to
 * 2026-10-28 (read-only from the production KV). To admit another AI app, add its domain here.
 *
 * The same check runs again on /authorize, so a client registered before this rule with any other redirect can no
 * longer start a sign-in.
 */

/** Domains whose https addresses (and their subdomains') may receive a code. */
export const KNOWN_CLIENT_DOMAINS = [
  // Anthropic: Claude (web, desktop, mobile)
  "claude.ai",
  "claude.com",
  "anthropic.com",
  // OpenAI: ChatGPT connectors, Codex
  "chatgpt.com",
  "openai.com",
  // Other AI clients people connected Kaption to
  "cursor.com",
  "cursor.sh",
  "notion.com",
  "notion.so",
  "perplexity.ai",
  "perplexity.com",
  "mistral.ai",
  "grok.com",
  "x.ai",
  "manus.im",
  "tess.im",
  "glama.ai",
  // VS Code's web redirect (vscode.dev/redirect)
  "vscode.dev",
] as const;

/**
 * Exact hosts (never their siblings): Google's per-user OAuth redirects for Gemini custom MCP connectors live on
 * googleusercontent.com, where anyone can publish content, so only these three hosts are admitted.
 */
export const KNOWN_CLIENT_HOSTS = [
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
  "oauth-redirect-test.googleusercontent.com",
] as const;

/** Private-use URI schemes of desktop AI apps (the code reaches only an app installed on the person's computer). */
export const KNOWN_APP_SCHEMES = [
  "claude",
  "cursor",
  "vscode",
  "vscode-insiders",
  "windsurf",
  "workbuddy",
] as const;

export type RedirectKind = "web" | "loopback" | "app";

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** What kind of allowed redirect this is, or null when it isn't allowed. */
export function classifyRedirectUri(redirectUri: unknown): RedirectKind | null {
  if (typeof redirectUri !== "string" || !redirectUri) return null;
  // No whitespace or control characters anywhere: the address registered must be the address used, byte for byte
  // (the report's example carried a leading space).
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(redirectUri)) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.hash || url.username || url.password) return null;
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const host = url.hostname.toLowerCase();

  if (scheme === "http" || scheme === "https") {
    if (isLoopbackHost(host)) return "loopback";
    if (scheme !== "https") return null;
    if ((KNOWN_CLIENT_HOSTS as readonly string[]).includes(host)) return "web";
    if (KNOWN_CLIENT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return "web";
    return null;
  }
  if ((KNOWN_APP_SCHEMES as readonly string[]).includes(scheme)) return "app";
  return null;
}

export function isAllowedRedirectUri(redirectUri: unknown): boolean {
  return classifyRedirectUri(redirectUri) !== null;
}

// ─── mcp.ANY_CLIENT.1-3 — any other https app, but only through the approval on the person's computer ──────────────

/**
 * What a redirect is under the owner's policy: CLOUD_RELAY.16's kinds, "unknown_web" for an https address on any other
 * host (completed only by the approval on the person's computer, mcp.ANY_CLIENT.3), or null when it is refused.
 */
export type PolicyRedirectKind = RedirectKind | "unknown_web";

/**
 * mcp.ANY_CLIENT.2, .16 — the owner's switch for everything any-client adds:
 * - "off": as before it (CLOUD_RELAY.16): unknown websites refused at register and /authorize, the sign-in page never
 *   offers the approval, the approval endpoints answer 403 `approval_disabled`. "known-only" is read as "off".
 * - "allowlist" (the default): only for testers. An approval completes only for a phone on `allowPhones` (proven by the
 *   WhatsApp handshake); the sign-in page offers it only in a browser that opted in (the tester cookie); unknown
 *   websites are accepted only on a `previewHosts` host. Everyone else sees the relay exactly as before.
 * - "on": for everyone.
 */
export type AnyClientMode = "off" | "allowlist" | "on";

/** mcp.ANY_CLIENT.2 — the owner's switch and lists, one KV value. */
export interface RedirectPolicy {
  mode: AnyClientMode;
  /** Hosts treated as known AI apps (subdomains included). */
  allowHosts: string[];
  /** Hosts refused everywhere, known apps included (subdomains included). */
  denyHosts: string[];
  /** mcp.ANY_CLIENT.16 — "allowlist": the only phones an approval completes for. */
  allowPhones: string[];
  /** mcp.ANY_CLIENT.16 — "allowlist": the only unknown websites accepted (subdomains included). */
  previewHosts: string[];
}

export const REDIRECT_POLICY_KEY = "mcp-any-client:policy";
/** mcp.ANY_CLIENT.16 — the owner's test numbers, the allowlist when the stored value names none. */
export const DEFAULT_ALLOW_PHONES = ["17373427172", "17374202658"];
export const DEFAULT_REDIRECT_POLICY: RedirectPolicy = {
  mode: "allowlist",
  allowHosts: [],
  denyHosts: [],
  allowPhones: DEFAULT_ALLOW_PHONES,
  previewHosts: [],
};

/** mcp.ANY_CLIENT.16 — the cookie a tester's browser carries to see the new sign-in (not a credential). */
export const TESTER_COOKIE = "kaption_any_client_tester";

function hostList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, ""))
    .filter((h) => /^[a-z0-9.-]{1,253}$/.test(h) && h.includes("."))
    .slice(0, 500);
}

function phoneList(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_ALLOW_PHONES;
  return value
    .filter((p): p is string | number => typeof p === "string" || typeof p === "number")
    .map((p) => String(p).replace(/[\s\-+()]/g, ""))
    .filter((p) => /^\d{8,15}$/.test(p))
    .slice(0, 100);
}

function parseMode(value: unknown): AnyClientMode {
  if (value === "on") return "on";
  if (value === "off" || value === "known-only") return "off";
  return "allowlist";
}

/** mcp.ANY_CLIENT.2 — a stored value as a policy; anything unreadable is the default. */
export function parseRedirectPolicy(raw: unknown): RedirectPolicy {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return DEFAULT_REDIRECT_POLICY; }
  }
  if (!value || typeof value !== "object") return DEFAULT_REDIRECT_POLICY;
  const v = value as Record<string, unknown>;
  return {
    mode: parseMode(v.mode),
    allowHosts: hostList(v.allowHosts),
    denyHosts: hostList(v.denyHosts),
    allowPhones: phoneList(v.allowPhones),
    previewHosts: hostList(v.previewHosts),
  };
}

/** mcp.ANY_CLIENT.16 — whether this browser is shown the approval (the page, /authorize, approval/start). */
export function approvalOfferedToBrowser(policy: RedirectPolicy, tester: boolean): boolean {
  if (policy.mode === "on") return true;
  return policy.mode === "allowlist" && tester;
}

/** mcp.ANY_CLIENT.16 — whether an approval may be shown to, started and completed for this phone. */
export function approvalAllowedForPhone(policy: RedirectPolicy, phone: string | null | undefined): boolean {
  if (!phone) return false;
  if (policy.mode === "on") return true;
  return policy.mode === "allowlist" && policy.allowPhones.includes(phone);
}

/** mcp.ANY_CLIENT.16 — the tester cookie in a Cookie header. */
export function hasTesterCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((part) => part.trim() === `${TESTER_COOKIE}=1`);
}

const POLICY_CACHE_MS = 60_000;
let cachedPolicy: { at: number; policy: RedirectPolicy } | null = null;

/** mcp.ANY_CLIENT.2 — read at most once a minute per isolate; a failed read is the default. */
export async function loadRedirectPolicy(kv: Pick<KVNamespace, "get">, now = Date.now()): Promise<RedirectPolicy> {
  if (cachedPolicy && now - cachedPolicy.at < POLICY_CACHE_MS) return cachedPolicy.policy;
  let policy = DEFAULT_REDIRECT_POLICY;
  try {
    policy = parseRedirectPolicy(await kv.get(REDIRECT_POLICY_KEY));
  } catch {
    policy = DEFAULT_REDIRECT_POLICY;
  }
  cachedPolicy = { at: now, policy };
  return policy;
}

/** Tests: forget the cached policy. */
export function resetRedirectPolicyCache(): void {
  cachedPolicy = null;
}

const matchesHost = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** A bare IPv4 or IPv6 address (outside loopback a code never goes to one). */
function isIpLiteral(host: string): boolean {
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** mcp.ANY_CLIENT.1-2 — the redirect's kind under the owner's policy, or null when it is refused. */
export function classifyWithPolicy(redirectUri: unknown, policy: RedirectPolicy = DEFAULT_REDIRECT_POLICY): PolicyRedirectKind | null {
  if (typeof redirectUri !== "string" || !redirectUri) return null;
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(redirectUri)) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.hash || url.username || url.password) return null;
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const host = url.hostname.toLowerCase();
  const web = scheme === "http" || scheme === "https";
  // The deny list wins over everything, the known apps included.
  if (web && !isLoopbackHost(host) && matchesHost(host, policy.denyHosts)) return null;
  const known = classifyRedirectUri(redirectUri);
  if (known) return known;
  if (scheme !== "https") return null;
  if (isIpLiteral(host) || !host.includes(".") || host.endsWith(".")) return null;
  if (matchesHost(host, policy.allowHosts)) return "web";
  // mcp.ANY_CLIENT.16 — "off": refused as before; "allowlist": only the owner's preview hosts.
  if (policy.mode === "on") return "unknown_web";
  if (policy.mode === "allowlist" && matchesHost(host, policy.previewHosts)) return "unknown_web";
  return null;
}

/** mcp.ANY_CLIENT.3, .5 — kinds a sign-in must be approved on the person's computer for (no phone, no code). */
export function approvalOnly(kind: PolicyRedirectKind | null): boolean {
  return kind === "unknown_web";
}

/** mcp.ANY_CLIENT.5 — kinds whose approval needs PKCE with S256: everything that isn't a known AI app's website. */
export function approvalNeedsPkce(kind: PolicyRedirectKind | null): boolean {
  return kind !== "web";
}

/**
 * OAuthProvider `clientRegistrationCallback`: refuses a registration whose redirect_uris include one that isn't
 * allowed (RFC 7591 §3.2.2 invalid_redirect_uri, HTTP 400). Nothing is stored for a refused registration.
 */
export function checkClientRegistration(options: {
  clientMetadata: Record<string, unknown>;
}, policy?: RedirectPolicy): { code: string; description: string; status: number } | undefined {
  const uris = options.clientMetadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return undefined; // the library answers a missing list itself
  // mcp.ANY_CLIENT.1 — with the owner's policy, an https app on any other host is accepted too (approval only).
  const allowed = (uri: unknown) => (policy ? classifyWithPolicy(uri, policy) !== null : isAllowedRedirectUri(uri));
  const refused = uris.find((uri) => !allowed(uri));
  if (refused === undefined) return undefined;
  // mcp.ANY_CLIENT.16 — until it is on for everyone, the refusal reads as it did before any-client.
  return {
    code: "invalid_redirect_uri",
    description: policy?.mode === "on"
      ? "This redirect URI is not accepted. Kaption connects to AI apps over https, and to apps on your own computer "
        + "(http://localhost or http://127.0.0.1 on any port). To connect another app, write to hello@kaptionai.com."
      : "This redirect URI is not accepted. Kaption connects to known AI apps (Claude, ChatGPT, Cursor, …) and to apps "
        + "on your own computer (http://localhost or http://127.0.0.1 on any port). To connect another app, write to "
        + "hello@kaptionai.com.",
    status: 400,
  };
}
