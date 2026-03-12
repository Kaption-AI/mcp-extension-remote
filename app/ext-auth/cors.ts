/**
 * CORS helpers for ext-auth routes.
 *
 * Chrome extensions make cross-origin requests from chrome-extension:// origins.
 * These helpers add the necessary CORS headers and handle preflight OPTIONS.
 *
 * Only chrome-extension:// and kaptionai.com origins are allowed.
 */

const ALLOWED_ORIGIN_PATTERNS = [
  /^chrome-extension:\/\//,
  /^https:\/\/([a-z0-9-]+\.)?kaptionai\.com$/,
];

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(origin));
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowedOrigin = origin && isAllowedOrigin(origin) ? origin : "https://kaptionai.com";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

/** Preflight response for OPTIONS requests */
export function corsOptions(request: Request): Response {
  const origin = request.headers.get("Origin");
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/** Add CORS headers to an existing Response */
export function withCors(response: Response, request: Request): Response {
  const origin = request.headers.get("Origin");
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}
