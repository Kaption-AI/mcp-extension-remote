import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkIpRateLimit,
  checkRateLimit,
  constantTimeTokenEqual,
  createVerifyTicket,
  decryptLoginHint,
  deriveAccountRef,
  encryptLoginHint,
  generateCloudToken,
  generateOTP,
  hmacSign,
  hmacVerify,
  normalizePhone,
  readVerifyTicket,
  revokeExtensionSession,
  sanitizeForLog,
  storeExtensionSession,
  storeOTP,
  validateExtensionSession,
  verifyOTP,
  incrementIpRateLimit,
  incrementRateLimit,
} from "./otp";

const TEST_PHONE = "5491155551234";
const PHONE_REF_SECRET = "test-phone-ref-secret";
const EPHEMERAL_STATE_SECRET = "test-ephemeral-state-secret";

interface MockKV extends KVNamespace {
  __store: Map<string, string>;
}

function createMockKV(): MockKV {
  const store = new Map<string, string>();
  return {
    __store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as MockKV;
}

describe("normalizePhone", () => {
  it("strips formatting characters", () => {
    expect(normalizePhone("+54 (911) 5555-1234")).toBe(TEST_PHONE);
  });

  it("returns plain digits unchanged", () => {
    expect(normalizePhone(TEST_PHONE)).toBe(TEST_PHONE);
  });
});

describe("deriveAccountRef", () => {
  it("is stable for the same normalized phone", async () => {
    const first = await deriveAccountRef(TEST_PHONE, PHONE_REF_SECRET);
    const second = await deriveAccountRef("+54 (911) 5555-1234", PHONE_REF_SECRET);
    expect(first).toBe(second);
  });

  it("does not resemble the raw phone", async () => {
    const accountRef = await deriveAccountRef(TEST_PHONE, PHONE_REF_SECRET);
    expect(accountRef).toMatch(/^acct_[0-9a-f]{64}$/);
    expect(accountRef).not.toContain(TEST_PHONE);
  });
});

describe("generateOTP", () => {
  it("returns a 6-digit string", () => {
    expect(generateOTP()).toMatch(/^\d{6}$/);
  });

  it("pads with leading zeros", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateOTP()).toHaveLength(6);
    }
  });
});

describe("constantTimeTokenEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeTokenEqual("secret123", "secret123")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(constantTimeTokenEqual("secret123", "secret456")).toBe(false);
  });
});

describe("generateCloudToken", () => {
  it("returns a 64-char hex string", () => {
    expect(generateCloudToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 10 }, () => generateCloudToken()));
    expect(tokens.size).toBe(10);
  });
});

describe("sanitizeForLog", () => {
  it("masks the middle of a phone number", () => {
    expect(sanitizeForLog(TEST_PHONE)).toBe("549****234");
  });

  it("fully masks short strings", () => {
    expect(sanitizeForLog("1234")).toBe("****");
  });
});

describe("hmacSign / hmacVerify", () => {
  const secret = "test-secret-key-for-hmac";

  it("roundtrips the original payload", async () => {
    const signed = await hmacSign("test-payload", secret);
    expect(await hmacVerify(signed, secret)).toBe("test-payload");
  });

  it("rejects tampered payloads", async () => {
    const signed = await hmacSign("original", secret);
    expect(await hmacVerify(signed.replace("original", "tampered"), secret)).toBeNull();
  });
});

describe("ephemeral encryption helpers", () => {
  it("encrypts and decrypts a login hint", async () => {
    const encrypted = await encryptLoginHint(TEST_PHONE, EPHEMERAL_STATE_SECRET);
    expect(encrypted).toBeTruthy();
    expect(encrypted!).not.toContain(TEST_PHONE);
    expect(await decryptLoginHint(encrypted!, EPHEMERAL_STATE_SECRET)).toBe(TEST_PHONE);
  });

  it("encrypts and decrypts a verify ticket", async () => {
    const ticket = await createVerifyTicket(
      TEST_PHONE,
      "signed-oauth-state",
      EPHEMERAL_STATE_SECRET,
    );
    expect(ticket).toBeTruthy();
    expect(ticket!).not.toContain(TEST_PHONE);
    expect(await readVerifyTicket(ticket!, EPHEMERAL_STATE_SECRET)).toEqual({
      phone: TEST_PHONE,
      oauthReqInfo: "signed-oauth-state",
    });
  });

  it("rejects tampered verify tickets", async () => {
    const ticket = await createVerifyTicket(
      TEST_PHONE,
      "signed-oauth-state",
      EPHEMERAL_STATE_SECRET,
    );
    const tampered = `${ticket}tampered`;
    expect(await readVerifyTicket(tampered, EPHEMERAL_STATE_SECRET)).toBeNull();
  });
});

describe("OTP KV operations", () => {
  let kv: MockKV;
  let accountRef: string;

  beforeEach(async () => {
    kv = createMockKV();
    accountRef = (await deriveAccountRef(TEST_PHONE, PHONE_REF_SECRET))!;
  });

  describe("rate limiting", () => {
    it("allows the first request", async () => {
      expect(await checkRateLimit(kv, accountRef)).toBe(true);
    });

    it("blocks the 51st request", async () => {
      for (let i = 0; i < 50; i++) {
        await incrementRateLimit(kv, accountRef);
      }
      expect(await checkRateLimit(kv, accountRef)).toBe(false);
    });

    it("stores rate-limit keys by accountRef instead of phone", async () => {
      await incrementRateLimit(kv, accountRef);
      const key = Array.from(kv.__store.keys())[0];
      expect(key).toBe(`rate:otp-send:${accountRef}`);
      expect(key).not.toContain(TEST_PHONE);
    });
  });

  describe("IP rate limiting", () => {
    it("allows the first request", async () => {
      expect(await checkIpRateLimit(kv, "1.2.3.4")).toBe(true);
    });

    it("blocks after 100 requests", async () => {
      for (let i = 0; i < 100; i++) {
        await incrementIpRateLimit(kv, "1.2.3.4");
      }
      expect(await checkIpRateLimit(kv, "1.2.3.4")).toBe(false);
    });
  });

  describe("storeOTP + verifyOTP", () => {
    it("verifies the correct code", async () => {
      await storeOTP(kv, accountRef, "123456");
      expect(await verifyOTP(kv, accountRef, "123456")).toEqual({ valid: true });
    });

    it("rejects the wrong code", async () => {
      await storeOTP(kv, accountRef, "123456");
      const result = await verifyOTP(kv, accountRef, "654321");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid code");
    });

    it("deletes OTP after successful verification", async () => {
      await storeOTP(kv, accountRef, "123456");
      await verifyOTP(kv, accountRef, "123456");
      expect(await verifyOTP(kv, accountRef, "123456")).toEqual({
        valid: false,
        error: "OTP expired or not found. Request a new code.",
      });
    });

    it("stores OTP keys by accountRef instead of phone", async () => {
      await storeOTP(kv, accountRef, "123456");
      const key = Array.from(kv.__store.keys())[0];
      expect(key).toBe(`otp:${accountRef}`);
      expect(key).not.toContain(TEST_PHONE);
    });
  });

  describe("extension sessions", () => {
    it("stores and validates an encrypted session", async () => {
      await storeExtensionSession(
        kv,
        "token-abc",
        accountRef,
        TEST_PHONE,
        EPHEMERAL_STATE_SECRET,
      );
      const session = await validateExtensionSession(
        kv,
        "token-abc",
        EPHEMERAL_STATE_SECRET,
      );
      expect(session).toEqual({ accountRef, phone: TEST_PHONE });
    });

    it("does not store plaintext phone in the session record", async () => {
      await storeExtensionSession(
        kv,
        "token-abc",
        accountRef,
        TEST_PHONE,
        EPHEMERAL_STATE_SECRET,
      );
      const raw = kv.__store.get("ext-session:token-abc");
      expect(raw).toContain(accountRef);
      expect(raw).not.toContain(TEST_PHONE);
    });

    it("returns null for unknown token", async () => {
      expect(
        await validateExtensionSession(kv, "nonexistent", EPHEMERAL_STATE_SECRET),
      ).toBeNull();
    });

    it("revokes a session", async () => {
      await storeExtensionSession(
        kv,
        "token-abc",
        accountRef,
        TEST_PHONE,
        EPHEMERAL_STATE_SECRET,
      );
      await revokeExtensionSession(kv, "token-abc");
      expect(
        await validateExtensionSession(kv, "token-abc", EPHEMERAL_STATE_SECRET),
      ).toBeNull();
    });
  });
});
