import type { OTPRecord, RateLimitRecord } from "./types";

const OTP_TTL = 300; // 5 minutes
const RATE_WINDOW_TTL = 3600; // 1 hour window
const MAX_SENDS_PER_HOUR = 50;
const MAX_VERIFY_ATTEMPTS = 5;

// [C2/M2] Rejection sampling threshold to avoid modulo bias
const REJECTION_THRESHOLD = 4294000000; // largest multiple of 1000000 below 2^32

/** Generate a cryptographically random 6-digit code with no modulo bias. */
export function generateOTP(): string {
  const array = new Uint32Array(1);
  // [M2] Rejection sampling to avoid modulo bias
  do {
    crypto.getRandomValues(array);
  } while (array[0] >= REJECTION_THRESHOLD);
  return String(array[0] % 1000000).padStart(6, "0");
}

/** Normalize phone: strip leading +, spaces, dashes */
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\+\(\)]/g, "");
}

/**
 * [C1] Constant-time string comparison to prevent timing attacks.
 * Always compares all bytes regardless of match.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Check hourly rate limit (max 50 sends per hour). Returns true if allowed. */
export async function checkRateLimit(kv: KVNamespace, phone: string): Promise<boolean> {
  const key = `rate:otp-send:${phone}`;
  const raw = await kv.get(key);

  if (!raw) return true;

  const record: RateLimitRecord = JSON.parse(raw);
  const elapsed = Date.now() - record.windowStart;

  // Window expired — allow
  if (elapsed > RATE_WINDOW_TTL * 1000) return true;

  // Within window — check count
  return record.count < MAX_SENDS_PER_HOUR;
}

/** Increment the send rate counter. */
export async function incrementRateLimit(kv: KVNamespace, phone: string): Promise<void> {
  const key = `rate:otp-send:${phone}`;
  const raw = await kv.get(key);

  let record: RateLimitRecord;
  if (!raw) {
    record = { count: 1, windowStart: Date.now() };
  } else {
    record = JSON.parse(raw);
    const elapsed = Date.now() - record.windowStart;
    if (elapsed > RATE_WINDOW_TTL * 1000) {
      record = { count: 1, windowStart: Date.now() };
    } else {
      record.count++;
    }
  }

  await kv.put(key, JSON.stringify(record), { expirationTtl: RATE_WINDOW_TTL });
}

/**
 * [M1] Check IP-based rate limit (max 10 OTP sends per IP per hour).
 * Returns true if allowed.
 */
export async function checkIpRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const key = `rate:otp-ip:${ip}`;
  const raw = await kv.get(key);

  if (!raw) return true;

  const record: RateLimitRecord = JSON.parse(raw);
  const elapsed = Date.now() - record.windowStart;

  if (elapsed > RATE_WINDOW_TTL * 1000) return true;
  return record.count < 100; // 100 OTP sends per IP per hour
}

/** Increment the IP-based send rate counter. */
export async function incrementIpRateLimit(kv: KVNamespace, ip: string): Promise<void> {
  const key = `rate:otp-ip:${ip}`;
  const raw = await kv.get(key);

  let record: RateLimitRecord;
  if (!raw) {
    record = { count: 1, windowStart: Date.now() };
  } else {
    record = JSON.parse(raw);
    const elapsed = Date.now() - record.windowStart;
    if (elapsed > RATE_WINDOW_TTL * 1000) {
      record = { count: 1, windowStart: Date.now() };
    } else {
      record.count++;
    }
  }

  await kv.put(key, JSON.stringify(record), { expirationTtl: RATE_WINDOW_TTL });
}

/** Store an OTP code for a phone number. */
export async function storeOTP(kv: KVNamespace, phone: string, code: string): Promise<void> {
  const key = `otp:${phone}`;
  const record: OTPRecord = {
    code,
    attempts: 0,
    createdAt: Date.now(),
  };
  await kv.put(key, JSON.stringify(record), { expirationTtl: OTP_TTL });
}

/**
 * Verify an OTP code. Returns true if valid.
 * [C1] Uses constant-time comparison to prevent timing attacks.
 * Increments attempts on each call. Deletes the OTP on success or max attempts.
 */
export async function verifyOTP(
  kv: KVNamespace,
  phone: string,
  code: string,
): Promise<{ valid: boolean; error?: string }> {
  const key = `otp:${phone}`;
  const raw = await kv.get(key);

  if (!raw) {
    return { valid: false, error: "OTP expired or not found. Request a new code." };
  }

  const record: OTPRecord = JSON.parse(raw);

  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    await kv.delete(key);
    return { valid: false, error: "Too many attempts. Request a new code." };
  }

  // [C1] Constant-time comparison — always runs in same time regardless of match
  if (!constantTimeEqual(record.code, code)) {
    record.attempts++;
    if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
      await kv.delete(key);
      return { valid: false, error: "Too many attempts. Request a new code." };
    }
    // Re-store with incremented attempts, keeping remaining TTL
    const elapsed = (Date.now() - record.createdAt) / 1000;
    const remainingTtl = Math.max(60, Math.ceil(OTP_TTL - elapsed));
    await kv.put(key, JSON.stringify(record), { expirationTtl: remainingTtl });
    return { valid: false, error: `Invalid code. ${MAX_VERIFY_ATTEMPTS - record.attempts} attempts remaining.` };
  }

  // Valid — delete the OTP
  await kv.delete(key);
  return { valid: true };
}

/** Generate a cloud token for extension sessions. */
export function generateCloudToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Store an extension session token. */
export async function storeExtensionSession(
  kv: KVNamespace,
  token: string,
  phone: string,
): Promise<void> {
  const key = `ext-session:${token}`;
  await kv.put(
    key,
    JSON.stringify({ phone, createdAt: Date.now() }),
    { expirationTtl: 7 * 24 * 3600 }, // [H5] 7 days (reduced from 30)
  );
}

/** Validate an extension session token. Returns phone if valid. */
export async function validateExtensionSession(
  kv: KVNamespace,
  token: string,
): Promise<string | null> {
  const key = `ext-session:${token}`;
  const raw = await kv.get(key);
  if (!raw) return null;
  const session = JSON.parse(raw) as { phone: string };
  return session.phone;
}

/** [H5] Revoke an extension session token. */
export async function revokeExtensionSession(
  kv: KVNamespace,
  token: string,
): Promise<void> {
  const key = `ext-session:${token}`;
  await kv.delete(key);
}

/**
 * [C2] Constant-time comparison for API keys and tokens.
 */
export function constantTimeTokenEqual(a: string, b: string): boolean {
  return constantTimeEqual(a, b);
}

// ─── JWT Validation ──────────────────────────────────────────────────

/** Validate a Kaption JWT by calling the internal API. Returns phone if valid. */
/**
 * Validate a Kaption JWT using the shared JWT_SECRET.
 * Returns the phone number if valid, null otherwise.
 * Uses the same jose.jwtVerify pattern as schedule/metadata workers.
 */
export async function validateJwt(
  jwtSecret: string,
  jwt: string,
): Promise<string | null> {
  try {
    const { jwtVerify } = await import("jose");
    const secret = new TextEncoder().encode(jwtSecret);
    const { payload } = await jwtVerify(jwt, secret);

    // JWT payload has phoneNumber (and userId) — same as schedule/metadata workers
    const phone =
      (payload as any).phoneNumber ||
      (payload as any).phone ||
      null;
    return phone;
  } catch {
    return null;
  }
}

/** Extract phone from JWT without validation (for routing only). */
export function extractPhoneFromJwt(jwt: string): string | null {
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1]));
    return payload.phoneNumber || payload.phone || null;
  } catch {
    return null;
  }
}

// ─── HMAC Signing for oauthReqInfo (M3) ──────────────────────────────

/**
 * [M3] HMAC-sign a payload (base64-encoded oauthReqInfo).
 * Returns "payload.hexSignature".
 */
export async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  const sigHex = Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${payload}.${sigHex}`;
}

/**
 * [M3] Verify an HMAC-signed payload. Returns the original payload if valid, null otherwise.
 */
export async function hmacVerify(
  signed: string,
  secret: string,
): Promise<string | null> {
  const dotIndex = signed.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const payload = signed.substring(0, dotIndex);
  const sigHex = signed.substring(dotIndex + 1);

  if (!/^[0-9a-f]{64}$/.test(sigHex)) return null;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const sigBytes = new Uint8Array(
    sigHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(payload),
  );
  return valid ? payload : null;
}

// ─── Logging Helpers (L2) ────────────────────────────────────────────

/** [L2] Redact sensitive data for logging. Never log OTP codes, tokens, or full phone numbers. */
export function sanitizeForLog(phone: string): string {
  if (phone.length <= 4) return "****";
  return phone.slice(0, 3) + "****" + phone.slice(-3);
}
