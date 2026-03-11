import type { OTPRecord, RateLimitRecord } from "./types";

const OTP_TTL = 300; // 5 minutes
const COOLDOWN_TTL = 60; // 60 seconds between sends
const RATE_WINDOW_TTL = 3600; // 1 hour window
const MAX_SENDS_PER_HOUR = 3;
const MAX_VERIFY_ATTEMPTS = 5;

/** Generate a cryptographically random 6-digit code. */
export function generateOTP(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(array[0] % 1000000).padStart(6, "0");
}

/** Normalize phone: strip leading +, spaces, dashes */
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\+\(\)]/g, "");
}

/** Check if the phone is on cooldown (60s between sends). */
export async function checkCooldown(kv: KVNamespace, phone: string): Promise<boolean> {
  const key = `rate:otp-cooldown:${phone}`;
  const val = await kv.get(key);
  return val !== null;
}

/** Set cooldown for a phone. */
export async function setCooldown(kv: KVNamespace, phone: string): Promise<void> {
  const key = `rate:otp-cooldown:${phone}`;
  await kv.put(key, "1", { expirationTtl: COOLDOWN_TTL });
}

/** Check hourly rate limit (max 3 sends per hour). Returns true if allowed. */
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

  if (record.code !== code) {
    record.attempts++;
    if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
      await kv.delete(key);
      return { valid: false, error: "Too many attempts. Request a new code." };
    }
    // Re-store with incremented attempts, keeping remaining TTL
    const elapsed = (Date.now() - record.createdAt) / 1000;
    const remainingTtl = Math.max(1, Math.ceil(OTP_TTL - elapsed));
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
    { expirationTtl: 30 * 24 * 3600 }, // 30 days
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
