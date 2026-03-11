/**
 * CORS helpers for ext-auth routes.
 *
 * Chrome extensions make cross-origin requests from chrome-extension:// origins.
 * These helpers add the necessary CORS headers and handle preflight OPTIONS.
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** Preflight response for OPTIONS requests */
export function corsOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Add CORS headers to an existing Response */
export function withCors(response: Response): Response {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}
