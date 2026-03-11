/**
 * WhatsApp OTP Handler — replaces GoogleHandler from mcp-server.
 *
 * Handles OAuth authorization via WhatsApp OTP instead of Google OAuth:
 * - GET  /authorize          → Phone number input form
 * - GET  /authorize/verify   → OTP verification form
 * - POST /authorize/send-otp → Send OTP via WhatsApp
 * - POST /authorize/verify-otp → Verify OTP and complete OAuth
 * - POST /register           → Dynamic client registration
 *
 * Extension auth (non-OAuth):
 * - GET  /ext-auth           → Extension authentication page
 * - POST /ext-auth/send-otp  → Send OTP for extension auth
 * - POST /ext-auth/verify-otp → Verify OTP and return cloud_token
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "./types";
import {
  normalizePhone,
  generateOTP,
  checkCooldown,
  setCooldown,
  checkRateLimit,
  incrementRateLimit,
  storeOTP,
  verifyOTP,
  generateCloudToken,
  storeExtensionSession,
} from "./otp";
import { phoneInputPage, otpVerifyPage, extensionOtpPage } from "./html";

const app = new Hono<{ Bindings: Env }>();

// ─── Dynamic Client Registration ─────────────────────────────────────
app.post("/register", async (c) => {
  try {
    const body = (await c.req.json()) as any;
    const { client_id, client_name, redirect_uris } = body;

    if (!client_id || !redirect_uris || !Array.isArray(redirect_uris)) {
      return c.json(
        { error: "Missing required fields: client_id, redirect_uris (array)" },
        400,
      );
    }

    await c.env.OAUTH_PROVIDER.createClient({
      client_id,
      client_name: client_name || "MCP Client",
      redirect_uris,
      scope: "whatsapp",
    });

    return c.json({
      client_id,
      client_name: client_name || "MCP Client",
      redirect_uris,
      scopes: ["whatsapp"],
    });
  } catch (error) {
    return c.json(
      {
        error: "registration_failed",
        details: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ─── OAuth Authorization: Phone Input Page ────────────────────────────
app.get("/authorize", async (c) => {
  try {
    const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    if (!oauthReqInfo.clientId) {
      return c.text("Invalid request", 400);
    }

    const encoded = btoa(JSON.stringify(oauthReqInfo));
    return c.html(phoneInputPage(encoded));
  } catch (error) {
    return c.text(
      `Authorization failed: ${error instanceof Error ? error.message : String(error)}. Register your MCP client first via /register.`,
      400,
    );
  }
});

// ─── OAuth Authorization: OTP Verify Page ─────────────────────────────
app.get("/authorize/verify", async (c) => {
  const phone = c.req.query("phone");
  const oauthReqInfo = c.req.query("oauthReqInfo");

  if (!phone || !oauthReqInfo) {
    return c.text("Missing phone or OAuth state", 400);
  }

  return c.html(otpVerifyPage(normalizePhone(phone), oauthReqInfo));
});

// ─── Send OTP (OAuth flow) ────────────────────────────────────────────
app.post("/authorize/send-otp", async (c) => {
  const body = (await c.req.json()) as { phone?: string; oauthReqInfo?: string };
  return handleSendOTP(c, body.phone);
});

// ─── Verify OTP (OAuth flow) — completes authorization ────────────────
app.post("/authorize/verify-otp", async (c) => {
  const body = (await c.req.json()) as {
    phone?: string;
    code?: string;
    oauthReqInfo?: string;
  };

  if (!body.phone || !body.code || !body.oauthReqInfo) {
    return c.json({ error: "Missing phone, code, or OAuth state" }, 400);
  }

  const phone = normalizePhone(body.phone);
  const result = await verifyOTP(c.env.AUTH_KV, phone, body.code);

  if (!result.valid) {
    return c.json({ error: result.error }, 400);
  }

  // Parse the OAuth request info and complete authorization
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(body.oauthReqInfo));
  } catch {
    return c.json({ error: "Invalid OAuth state" }, 400);
  }

  if (!oauthReqInfo.clientId) {
    return c.json({ error: "Invalid OAuth state: missing clientId" }, 400);
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    metadata: {
      label: `WhatsApp ${phone}`,
    },
    props: {
      phone,
    },
    request: oauthReqInfo,
    scope: oauthReqInfo.scope,
    userId: phone,
  });

  return c.json({ redirectTo });
});

// ─── Extension Auth: Page ─────────────────────────────────────────────
app.get("/ext-auth", async (c) => {
  return c.html(extensionOtpPage());
});

// ─── Extension Auth: Send OTP ─────────────────────────────────────────
app.post("/ext-auth/send-otp", async (c) => {
  const body = (await c.req.json()) as { phone?: string };
  return handleSendOTP(c, body.phone);
});

// ─── Extension Auth: Verify OTP → return cloud_token ──────────────────
app.post("/ext-auth/verify-otp", async (c) => {
  const body = (await c.req.json()) as { phone?: string; code?: string };

  if (!body.phone || !body.code) {
    return c.json({ error: "Missing phone or code" }, 400);
  }

  const phone = normalizePhone(body.phone);
  const result = await verifyOTP(c.env.AUTH_KV, phone, body.code);

  if (!result.valid) {
    return c.json({ error: result.error }, 400);
  }

  // Generate and store a cloud token for the extension
  const cloudToken = generateCloudToken();
  await storeExtensionSession(c.env.AUTH_KV, cloudToken, phone);

  return c.json({ ok: true, cloud_token: cloudToken });
});

// ─── Build Info ───────────────────────────────────────────────────────
app.get("/build-info", async (c) => {
  return c.json({
    version: "1.0.0",
    commitSha: c.env.COMMIT_SHA || "unknown",
    buildHash: c.env.BUILD_HASH || "unknown",
    buildTimestamp: new Date().toISOString(),
    repo: "https://github.com/kaptionai/kaption-mcp-remote",
  });
});

// ─── Shared: Send OTP Logic ──────────────────────────────────────────

async function handleSendOTP(c: any, rawPhone?: string) {
  if (!rawPhone) {
    return c.json({ error: "Phone number is required" }, 400);
  }

  const phone = normalizePhone(rawPhone);

  // Basic phone validation (at least 8 digits)
  if (!/^\d{8,15}$/.test(phone)) {
    return c.json({ error: "Invalid phone number format" }, 400);
  }

  // Check cooldown (60s between sends)
  if (await checkCooldown(c.env.AUTH_KV, phone)) {
    return c.json({ error: "Please wait 60 seconds before requesting a new code" }, 429);
  }

  // Check hourly rate limit
  if (!(await checkRateLimit(c.env.AUTH_KV, phone))) {
    return c.json({ error: "Too many OTP requests. Try again in an hour." }, 429);
  }

  // Generate and store OTP
  const code = generateOTP();
  await storeOTP(c.env.AUTH_KV, phone, code);
  await setCooldown(c.env.AUTH_KV, phone);
  await incrementRateLimit(c.env.AUTH_KV, phone);

  // Send OTP via rest-api → WhatsApp Cloud API
  try {
    const apiBase = c.env.INTERNAL_API_BASE_URL.replace(/\/$/, "");
    const res = await fetch(`${apiBase}/__internal/otp/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": c.env.INTERNAL_API_KEY,
      },
      body: JSON.stringify({ phone, code }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`OTP send failed: ${res.status} ${errText}`);
      return c.json({ error: "Failed to send verification code. Try again." }, 500);
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("OTP send error:", err);
    return c.json({ error: "Failed to send verification code. Try again." }, 500);
  }
}

export { app as WhatsAppOTPHandler };
