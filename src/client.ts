/**
 * mcp-local-hub-growth.CLIENT.3-5 (kaptionai features/mcp/mcp-local-hub-growth.feature.yaml) — which AI app is calling.
 *
 * The MCP `initialize` request's clientInfo {name, version}, cut down to what may be kept (CLIENT.5) and normalized to
 * one of a fixed set of ids (CLIENT.4). The extension (TypeScript), the Rust core and this relay agree, pinned by
 * kaptionai kaption-core/fixtures/mcp/clients.json (copied to src/test-support/mcp-clients.json).
 */

export type McpClientId =
  | "claude-desktop"
  | "claude-code"
  | "claude-ai"
  | "chatgpt"
  | "cursor"
  | "vscode"
  | "windsurf"
  | "other"
  | "unknown";

export const MCP_CLIENT_IDS: readonly McpClientId[] = [
  "claude-desktop", "claude-code", "claude-ai", "chatgpt", "cursor", "vscode", "windsurf", "other", "unknown",
];

/** What the relay sends the extension beside a relayed call (CLIENT.3). */
export interface McpClientInfo {
  name: string;
  version: string;
}

export interface NormalizedMcpClient {
  mcpClient: McpClientId;
  mcpClientName: string;
  mcpClientVersion: string;
}

/** mcp-local-hub-growth.CLIENT.5 — at most 32 characters of letters, digits, space and . _ - / ( ) +. */
export function sanitizeClientName(name: unknown): string {
  if (typeof name !== "string") return "";
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  return collapse(collapse(name).replace(/[^A-Za-z0-9 ._\-/()+]/g, "")).slice(0, 32).trim();
}

/** mcp-local-hub-growth.CLIENT.5 — at most 16 characters of letters, digits and . + -. */
export function sanitizeClientVersion(version: unknown): string {
  if (typeof version !== "string") return "";
  return version.replace(/[^A-Za-z0-9.+-]/g, "").slice(0, 16);
}

/** CLIENT.3, CLIENT.5 — clientInfo as kept and sent; null when it said no name. */
export function sanitizeClientInfo(info: unknown): McpClientInfo | null {
  if (!info || typeof info !== "object") return null;
  const name = sanitizeClientName((info as { name?: unknown }).name);
  if (!name) return null;
  return { name, version: sanitizeClientVersion((info as { version?: unknown }).version) };
}

/**
 * mcp-local-hub-growth.CLIENT.4 — first match on the (sanitized) name, case-insensitive; a bare claude / anthropic is
 * Claude Desktop on the local hub and claude.ai on the cloud.
 */
export function normalizeMcpClient(
  name: string | null | undefined,
  version: string | null | undefined,
  path: "local" | "cloud",
): NormalizedMcpClient {
  const mcpClientName = sanitizeClientName(name);
  const mcpClientVersion = sanitizeClientVersion(version);
  return { mcpClient: clientIdOf(mcpClientName, path), mcpClientName, mcpClientVersion };
}

function clientIdOf(name: string, path: "local" | "cloud"): McpClientId {
  if (!name) return "unknown";
  if (/claude[\s_-]*code/i.test(name)) return "claude-code";
  if (/cursor/i.test(name)) return "cursor";
  if (/windsurf|codeium/i.test(name)) return "windsurf";
  if (/visual[\s_-]*studio[\s_-]*code|vs[\s_-]?code|copilot/i.test(name)) return "vscode";
  if (/chat[\s_-]*gpt|openai/i.test(name)) return "chatgpt";
  if (/claude[\s_-]*desktop/i.test(name)) return "claude-desktop";
  if (/claude|anthropic/i.test(name)) return path === "local" ? "claude-desktop" : "claude-ai";
  return "other";
}

/** A stored client id read back: one of the set, else null (rows written before CLIENT.8 have none). */
export function knownClientId(value: unknown): McpClientId | null {
  return typeof value === "string" && (MCP_CLIENT_IDS as readonly string[]).includes(value) ? (value as McpClientId) : null;
}
