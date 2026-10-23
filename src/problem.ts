/**
 * The relay's HTTP error contract (AgentReady AR-ACT-02).
 *
 * Every 4xx/5xx the worker produces itself is an RFC 9457 problem document
 * (`application/problem+json`) with a stable, snake_case `code` an agent can
 * branch on. Fields that callers already read (`error`, `error_description`,
 * `errorKey`, `errorParams`, `resource_metadata`, `forget`) stay as extension
 * members, so the extension and the sign-in pages keep working unchanged.
 *
 * Deliberately NOT covered, because a spec fixes their format:
 * - OAuth 2.0 token / registration / authorize errors from the OAuth library
 *   (RFC 6749 / RFC 7591 `{error, error_description}` JSON);
 * - MCP transport answers on /mcp and /sse (JSON-RPC error objects).
 *
 * Pure module: no Workers or Next imports, so pages, route handlers and the
 * worker can all use it.
 */

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** Where each `code` is documented: the developer page's error anchors. */
export const PROBLEM_TYPE_BASE = "https://kaptionai.com/developers/#errors-";

export function problemType(code: string): string {
  return `${PROBLEM_TYPE_BASE}${code}`;
}

const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  409: "Conflict",
  410: "Gone",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  426: "Upgrade Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** The generic code for a status, used when nothing more specific is known. */
const STATUS_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  406: "not_acceptable",
  409: "conflict",
  410: "gone",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "unprocessable_content",
  426: "upgrade_required",
  429: "rate_limited",
  500: "internal_error",
  501: "not_implemented",
  502: "bad_gateway",
  503: "service_unavailable",
  504: "gateway_timeout",
};

export function statusTitle(status: number): string {
  return STATUS_TITLES[status] ?? (status >= 500 ? "Server Error" : "Client Error");
}

export function defaultProblemCode(status: number): string {
  return STATUS_CODES[status] ?? `http_${status}`;
}

export interface ProblemInit {
  status: number;
  /** Stable snake_case identifier; defaults to the generic code for `status`. */
  code?: string;
  /** Short, human summary of the problem type; defaults to the status phrase. */
  title?: string;
  /** Human explanation of this occurrence. */
  detail?: string;
  headers?: HeadersInit;
  /** Extension members (RFC 9457 §3.2). They never override the core members. */
  extra?: Record<string, unknown>;
}

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  [extension: string]: unknown;
}

export function problemBody(init: Omit<ProblemInit, "headers">): ProblemDocument {
  const code = init.code ?? defaultProblemCode(init.status);
  return {
    ...(init.extra ?? {}),
    type: problemType(code),
    title: init.title ?? statusTitle(init.status),
    status: init.status,
    ...(init.detail ? { detail: init.detail } : {}),
    code,
  };
}

/** An `application/problem+json` response. */
export function problem(init: ProblemInit): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", PROBLEM_CONTENT_TYPE);
  headers.delete("Content-Length");
  return new Response(JSON.stringify(problemBody(init)), { status: init.status, headers });
}

/** A copy of `response` with extra headers set (Response headers can be immutable). */
export function withHeaders(response: Response, headers: HeadersInit | undefined): Response {
  if (!headers) return response;
  const out = new Response(response.body, response);
  new Headers(headers).forEach((value, key) => out.headers.set(key, value));
  return out;
}

// ─── Converting responses the worker did not shape itself ────────────────

/** MCP transport paths: their errors are JSON-RPC objects and stay that way. */
export function isMcpTransportPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/") || pathname === "/sse" || pathname.startsWith("/sse/");
}

/**
 * Pages that are real UI. A browser (Accept: text/html) asking one of these
 * keeps whatever the page answers, error or not, so the sign-in flow a person
 * sees inside Claude or ChatGPT is untouched.
 */
const UI_PAGES = new Set(["/", "/authorize", "/authorize/verify", "/connect", "/ext-auth", "/support"]);

export function isUiPage(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return UI_PAGES.has(path);
}

export function acceptsHtml(request: Request): boolean {
  return /\btext\/html\b/i.test(request.headers.get("Accept") ?? "");
}

function isJsonContentType(contentType: string | null): boolean {
  return !!contentType && /\bjson\b/i.test(contentType);
}

/**
 * Turns a non-JSON 4xx/5xx (Next's HTML 404 page, an empty 405, a plain-text
 * error) into a problem document with the same status and headers. JSON
 * answers (problem documents, OAuth errors, JSON-RPC errors) pass through,
 * and so do MCP transport answers and UI pages a browser asked for.
 */
export async function ensureProblemJson(response: Response, request: Request): Promise<Response> {
  if (response.status < 400) return response;
  if (isJsonContentType(response.headers.get("Content-Type"))) return response;
  const { pathname } = new URL(request.url);
  if (isMcpTransportPath(pathname)) return response;
  if (isUiPage(pathname) && acceptsHtml(request)) return response;

  const contentType = response.headers.get("Content-Type") ?? "";
  let detail: string | undefined;
  if (/^text\/plain\b/i.test(contentType)) {
    // Our own short plain-text messages are worth keeping; anything long or
    // HTML-looking is a framework page and says nothing an agent can use.
    const text = (await response.text().catch(() => "")).trim();
    if (text && text.length <= 300 && !text.startsWith("<")) detail = text;
  } else {
    await response.body?.cancel().catch(() => {});
  }

  const headers = new Headers(response.headers);
  headers.delete("Content-Encoding");
  return problem({ status: response.status, detail, headers });
}

// ─── Deprecation / Sunset (RFC 9745 / RFC 8594) ──────────────────────────

export interface DeprecationOptions {
  /** When the resource was (or will be) deprecated. */
  deprecatedAt: Date;
  /** When it stops working (RFC 8594). */
  sunsetAt?: Date;
  /** Human-readable migration notes, linked with rel="deprecation". */
  link?: string;
  /** Notes about the sunset, linked with rel="sunset". */
  sunsetLink?: string;
}

/**
 * Headers announcing that a resource is deprecated. Ready for use, applied to
 * nothing today.
 * - `Deprecation: @<unix seconds>` — RFC 9745 (a Structured Fields Date).
 * - `Sunset: <IMF-fixdate>` — RFC 8594.
 * - `Link: <…>; rel="deprecation"` / `rel="sunset"`.
 */
export function deprecationHeaders(options: DeprecationOptions): Headers {
  const headers = new Headers();
  headers.set("Deprecation", `@${Math.floor(options.deprecatedAt.getTime() / 1000)}`);
  if (options.sunsetAt) headers.set("Sunset", options.sunsetAt.toUTCString());
  const links: string[] = [];
  if (options.link) links.push(`<${options.link}>; rel="deprecation"; type="text/html"`);
  if (options.sunsetLink) links.push(`<${options.sunsetLink}>; rel="sunset"; type="text/html"`);
  if (links.length) headers.set("Link", links.join(", "));
  return headers;
}

/** `response` with deprecation headers added (an existing Link header is kept). */
export function withDeprecation(response: Response, options: DeprecationOptions): Response {
  const out = new Response(response.body, response);
  deprecationHeaders(options).forEach((value, key) => {
    if (key === "link" && out.headers.has("Link")) out.headers.append("Link", value);
    else out.headers.set(key, value);
  });
  return out;
}
