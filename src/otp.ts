import type {
  ExtensionSession,
  OTPRecord,
  RateLimitRecord,
} from "./types";

const OTP_TTL = 300; // 5 minutes
const RATE_WINDOW_TTL = 3600; // 1 hour window
const EXTENSION_SESSION_TTL = 7 * 24 * 3600; // 7 days
const LOGIN_HINT_TTL = 300; // 5 minutes
const MAX_SENDS_PER_HOUR = 50;
const MAX_VERIFY_ATTEMPTS = 5;
const NORMALIZED_PHONE_RE = /^\d{8,15}$/;

// [C2/M2] Rejection sampling threshold to avoid modulo bias
const REJECTION_THRESHOLD = 4294000000; // largest multiple of 1000000 below 2^32

interface ExpiringStateEnvelope<T> {
  exp: number;
  data: T;
}

export interface ExtensionSessionAuth {
  accountRef: string;
  phone: string | null;
}

export interface LoginHintPayload {
  phone: string;
}

export interface VerifyTicketPayload {
  phone: string;
  oauthReqInfo: string;
}

/** Generate a cryptographically random 6-digit code with no modulo bias. */
export function generateOTP(): string {
  const array = new Uint32Array(1);
  do {
    crypto.getRandomValues(array);
  } while (array[0] >= REJECTION_THRESHOLD);
  return String(array[0] % 1000000).padStart(6, "0");
}

/** Normalize phone: strip leading +, spaces, dashes */
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\+\(\)]/g, "");
}

export function isValidNormalizedPhone(phone: string): boolean {
  return NORMALIZED_PHONE_RE.test(phone);
}

export function normalizeAndValidatePhone(phone: string): string | null {
  const normalized = normalizePhone(phone);
  return isValidNormalizedPhone(normalized) ? normalized : null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importHmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function importAesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptJson(data: unknown, secret: string): Promise<string> {
  const key = await importAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      plaintext,
    ),
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

async function decryptJson<T>(ciphertext: string, secret: string): Promise<T | null> {
  try {
    const [ivPart, cipherPart] = ciphertext.split(".");
    if (!ivPart || !cipherPart) return null;

    const key = await importAesKey(secret);
    const iv = base64UrlToBytes(ivPart);
    const cipherBytes = base64UrlToBytes(cipherPart);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      cipherBytes as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}

async function encryptExpiringState<T>(
  data: T,
  ttlSeconds: number,
  secret: string,
): Promise<string> {
  const envelope: ExpiringStateEnvelope<T> = {
    exp: Date.now() + ttlSeconds * 1000,
    data,
  };
  return encryptJson(envelope, secret);
}

async function decryptExpiringState<T>(
  token: string,
  secret: string,
): Promise<T | null> {
  const envelope = await decryptJson<ExpiringStateEnvelope<T>>(token, secret);
  if (!envelope || typeof envelope.exp !== "number" || envelope.exp < Date.now()) {
    return null;
  }
  return envelope.data;
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

export async function deriveAccountRef(
  phone: string,
  secret: string,
): Promise<string | null> {
  const normalized = normalizeAndValidatePhone(phone);
  if (!normalized) return null;

  const key = await importHmacKey(secret, "sign");
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(normalized),
  );
  return `acct_${bytesToHex(new Uint8Array(digest))}`;
}

export async function encryptLoginHint(
  phone: string,
  secret: string,
): Promise<string | null> {
  const normalized = normalizeAndValidatePhone(phone);
  if (!normalized) return null;
  return encryptExpiringState<LoginHintPayload>(
    { phone: normalized },
    LOGIN_HINT_TTL,
    secret,
  );
}

export async function decryptLoginHint(
  token: string,
  secret: string,
): Promise<string | null> {
  const payload = await decryptExpiringState<LoginHintPayload>(token, secret);
  return payload ? normalizeAndValidatePhone(payload.phone) : null;
}

export async function createVerifyTicket(
  phone: string,
  oauthReqInfo: string,
  secret: string,
): Promise<string | null> {
  const normalized = normalizeAndValidatePhone(phone);
  if (!normalized) return null;
  return encryptExpiringState<VerifyTicketPayload>(
    { phone: normalized, oauthReqInfo },
    OTP_TTL,
    secret,
  );
}

export async function readVerifyTicket(
  ticket: string,
  secret: string,
): Promise<VerifyTicketPayload | null> {
  const payload = await decryptExpiringState<VerifyTicketPayload>(ticket, secret);
  if (!payload) return null;
  const normalized = normalizeAndValidatePhone(payload.phone);
  if (!normalized || typeof payload.oauthReqInfo !== "string" || !payload.oauthReqInfo) {
    return null;
  }
  return { phone: normalized, oauthReqInfo: payload.oauthReqInfo };
}

/** Check hourly rate limit (max 50 sends per hour). Returns true if allowed. */
export async function checkRateLimit(
  kv: KVNamespace,
  accountRef: string,
): Promise<boolean> {
  const key = `rate:otp-send:${accountRef}`;
  const raw = await kv.get(key);

  if (!raw) return true;

  const record: RateLimitRecord = JSON.parse(raw);
  const elapsed = Date.now() - record.windowStart;

  if (elapsed > RATE_WINDOW_TTL * 1000) return true;
  return record.count < MAX_SENDS_PER_HOUR;
}

/** Increment the send rate counter. */
export async function incrementRateLimit(
  kv: KVNamespace,
  accountRef: string,
): Promise<void> {
  const key = `rate:otp-send:${accountRef}`;
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
 * [M1] Check IP-based rate limit (max 100 OTP sends per IP per hour).
 * Returns true if allowed.
 */
export async function checkIpRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const key = `rate:otp-ip:${ip}`;
  const raw = await kv.get(key);

  if (!raw) return true;

  const record: RateLimitRecord = JSON.parse(raw);
  const elapsed = Date.now() - record.windowStart;

  if (elapsed > RATE_WINDOW_TTL * 1000) return true;
  return record.count < 100;
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

/** Store an OTP code for an account reference. */
export async function storeOTP(
  kv: KVNamespace,
  accountRef: string,
  code: string,
): Promise<void> {
  const key = `otp:${accountRef}`;
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
 */
export async function verifyOTP(
  kv: KVNamespace,
  accountRef: string,
  code: string,
): Promise<{ valid: boolean; error?: string }> {
  const key = `otp:${accountRef}`;
  const raw = await kv.get(key);

  if (!raw) {
    return { valid: false, error: "OTP expired or not found. Request a new code." };
  }

  const record: OTPRecord = JSON.parse(raw);

  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    await kv.delete(key);
    return { valid: false, error: "Too many attempts. Request a new code." };
  }

  if (!constantTimeEqual(record.code, code)) {
    record.attempts++;
    if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
      await kv.delete(key);
      return { valid: false, error: "Too many attempts. Request a new code." };
    }
    const elapsed = (Date.now() - record.createdAt) / 1000;
    const remainingTtl = Math.max(60, Math.ceil(OTP_TTL - elapsed));
    await kv.put(key, JSON.stringify(record), { expirationTtl: remainingTtl });
    return { valid: false, error: `Invalid code. ${MAX_VERIFY_ATTEMPTS - record.attempts} attempts remaining.` };
  }

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
  accountRef: string,
  phone: string,
  encryptionSecret: string,
): Promise<void> {
  const normalized = normalizeAndValidatePhone(phone);
  if (!normalized) {
    throw new Error("Invalid phone number format");
  }

  const key = `ext-session:${token}`;
  const record: ExtensionSession = {
    accountRef,
    phoneCiphertext: await encryptJson({ phone: normalized }, encryptionSecret),
    createdAt: Date.now(),
  };
  await kv.put(
    key,
    JSON.stringify(record),
    { expirationTtl: EXTENSION_SESSION_TTL },
  );
}

/** Validate an extension session token. */
export async function validateExtensionSession(
  kv: KVNamespace,
  token: string,
  encryptionSecret: string,
): Promise<ExtensionSessionAuth | null> {
  const key = `ext-session:${token}`;
  const raw = await kv.get(key);
  if (!raw) return null;

  const session = JSON.parse(raw) as Partial<ExtensionSession>;
  if (typeof session.accountRef !== "string" || typeof session.phoneCiphertext !== "string") {
    return null;
  }

  const payload = await decryptJson<{ phone?: string }>(
    session.phoneCiphertext,
    encryptionSecret,
  );
  const phone = payload?.phone ? normalizeAndValidatePhone(payload.phone) : null;

  return { accountRef: session.accountRef, phone };
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

/**
 * Validate a Kaption JWT using the shared JWT_SECRET.
 * Returns the normalized phone number if valid, null otherwise.
 */
export async function validateJwt(
  jwtSecret: string,
  jwt: string,
): Promise<string | null> {
  try {
    const { jwtVerify } = await import("jose");
    const secret = new TextEncoder().encode(jwtSecret);
    const { payload } = await jwtVerify(jwt, secret);
    const phone = (payload as any).phoneNumber || (payload as any).phone || null;
    return typeof phone === "string" ? normalizeAndValidatePhone(phone) : null;
  } catch {
    return null;
  }
}

/** Extract phone from JWT without validation (for routing only). */
export function extractPhoneFromJwt(jwt: string): string | null {
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1]));
    const phone = payload.phoneNumber || payload.phone || null;
    return typeof phone === "string" ? normalizeAndValidatePhone(phone) : null;
  } catch {
    return null;
  }
}

/**
 * [M3] HMAC-sign a payload (base64-encoded oauthReqInfo).
 * Returns "payload.hexSignature".
 */
export async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret, "sign");
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return `${payload}.${bytesToHex(new Uint8Array(sig))}`;
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

  const key = await importHmacKey(secret, "verify");
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

export function sanitizeAccountRefForLog(accountRef: string): string {
  if (accountRef.length <= 14) return accountRef;
  return `${accountRef.slice(0, 10)}...${accountRef.slice(-4)}`;
}

/** [L2] Redact sensitive data for logging. Never log OTP codes, tokens, or full phone numbers. */
export function sanitizeForLog(phone: string): string {
  if (phone.length <= 4) return "****";
  return phone.slice(0, 3) + "****" + phone.slice(-3);
}
