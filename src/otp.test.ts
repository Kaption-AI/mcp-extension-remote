import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateOTP,
  normalizePhone,
  constantTimeTokenEqual,
  hmacSign,
  hmacVerify,
  sanitizeForLog,
  generateCloudToken,
  checkRateLimit,
  incrementRateLimit,
  checkIpRateLimit,
  incrementIpRateLimit,
  storeOTP,
  verifyOTP,
  storeExtensionSession,
  validateExtensionSession,
  revokeExtensionSession,
} from "./otp";

// ─── Mock KV ────────────────────────────────────────────────────────

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

// ─── normalizePhone ─────────────────────────────────────────────────

describe("normalizePhone", () => {
  it("strips + prefix", () => {
    expect(normalizePhone("+5491155551234")).toBe("5491155551234");
  });

  it("strips spaces", () => {
    expect(normalizePhone("549 1155 551234")).toBe("5491155551234");
  });

  it("strips dashes", () => {
    expect(normalizePhone("549-1155-551234")).toBe("5491155551234");
  });

  it("strips parentheses", () => {
    expect(normalizePhone("(549) 1155551234")).toBe("5491155551234");
  });

  it("strips all formatting combined", () => {
    expect(normalizePhone("+54 (911) 5555-1234")).toBe("5491155551234");
  });

  it("returns plain digits unchanged", () => {
    expect(normalizePhone("5491155551234")).toBe("5491155551234");
  });
});

// ─── generateOTP ────────────────────────────────────────────────────

describe("generateOTP", () => {
  it("returns a 6-digit string", () => {
    const code = generateOTP();
    expect(code).toMatch(/^\d{6}$/);
  });

  it("pads with leading zeros", () => {
    // Run multiple times to check padding logic
    for (let i = 0; i < 20; i++) {
      const code = generateOTP();
      expect(code).toHaveLength(6);
    }
  });

  it("generates different codes (not always the same)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      codes.add(generateOTP());
    }
    // With 6-digit codes, getting the same code 10 times is statistically impossible
    expect(codes.size).toBeGreaterThan(1);
  });
});

// ─── constantTimeTokenEqual ─────────────────────────────────────────

describe("constantTimeTokenEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeTokenEqual("secret123", "secret123")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(constantTimeTokenEqual("secret123", "secret456")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(constantTimeTokenEqual("short", "longer-string")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(constantTimeTokenEqual("", "")).toBe(true);
  });
});

// ─── generateCloudToken ─────────────────────────────────────────────

describe("generateCloudToken", () => {
  it("returns a 64-char hex string (32 bytes)", () => {
    const token = generateCloudToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 10; i++) {
      tokens.add(generateCloudToken());
    }
    expect(tokens.size).toBe(10);
  });
});

// ─── sanitizeForLog ─────────────────────────────────────────────────

describe("sanitizeForLog", () => {
  it("masks middle of a normal phone", () => {
    expect(sanitizeForLog("5491155551234")).toBe("549****234");
  });

  it("masks short strings fully", () => {
    expect(sanitizeForLog("1234")).toBe("****");
  });

  it("masks 3-char strings fully", () => {
    expect(sanitizeForLog("abc")).toBe("****");
  });

  it("handles 5-char string", () => {
    expect(sanitizeForLog("12345")).toBe("123****345");
  });
});

// ─── HMAC sign/verify ───────────────────────────────────────────────

describe("hmacSign / hmacVerify", () => {
  const secret = "test-secret-key-for-hmac";

  it("sign produces payload.signature format", async () => {
    const signed = await hmacSign("hello", secret);
    expect(signed).toContain(".");
    const [payload, sig] = signed.split(".");
    expect(payload).toBe("hello");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verify returns original payload for valid signature", async () => {
    const signed = await hmacSign("test-payload", secret);
    const result = await hmacVerify(signed, secret);
    expect(result).toBe("test-payload");
  });

  it("verify returns null for wrong secret", async () => {
    const signed = await hmacSign("test-payload", secret);
    const result = await hmacVerify(signed, "wrong-secret");
    expect(result).toBeNull();
  });

  it("verify returns null for tampered payload", async () => {
    const signed = await hmacSign("original", secret);
    const tampered = signed.replace("original", "tampered");
    const result = await hmacVerify(tampered, secret);
    expect(result).toBeNull();
  });

  it("verify returns null for missing dot", async () => {
    const result = await hmacVerify("nodothere", secret);
    expect(result).toBeNull();
  });

  it("verify returns null for invalid hex signature", async () => {
    const result = await hmacVerify("payload.not-hex!", secret);
    expect(result).toBeNull();
  });

  it("roundtrips a base64-encoded JSON payload", async () => {
    const data = { clientId: "test", scope: ["whatsapp"] };
    const encoded = btoa(JSON.stringify(data));
    const signed = await hmacSign(encoded, secret);
    const verified = await hmacVerify(signed, secret);
    expect(verified).toBe(encoded);
    expect(JSON.parse(atob(verified!))).toEqual(data);
  });
});

// ─── KV-based OTP operations ────────────────────────────────────────

describe("OTP KV operations", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  describe("rate limiting", () => {
    it("allows first request", async () => {
      expect(await checkRateLimit(kv, "5491155551234")).toBe(true);
    });

    it("allows up to 50 requests", async () => {
      for (let i = 0; i < 49; i++) {
        await incrementRateLimit(kv, "5491155551234");
      }
      expect(await checkRateLimit(kv, "5491155551234")).toBe(true);
    });

    it("blocks 51st request", async () => {
      for (let i = 0; i < 50; i++) {
        await incrementRateLimit(kv, "5491155551234");
      }
      expect(await checkRateLimit(kv, "5491155551234")).toBe(false);
    });
  });

  describe("IP rate limiting", () => {
    it("allows first request", async () => {
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
    it("verifies correct code", async () => {
      await storeOTP(kv, "5491155551234", "123456");
      const result = await verifyOTP(kv, "5491155551234", "123456");
      expect(result.valid).toBe(true);
    });

    it("rejects wrong code", async () => {
      await storeOTP(kv, "5491155551234", "123456");
      const result = await verifyOTP(kv, "5491155551234", "654321");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid code");
    });

    it("rejects when no OTP stored", async () => {
      const result = await verifyOTP(kv, "5491155551234", "123456");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("expired");
    });

    it("deletes OTP after successful verification", async () => {
      await storeOTP(kv, "5491155551234", "123456");
      await verifyOTP(kv, "5491155551234", "123456");
      // Second attempt should fail (OTP deleted)
      const result = await verifyOTP(kv, "5491155551234", "123456");
      expect(result.valid).toBe(false);
    });

    it("blocks after 5 wrong attempts", async () => {
      await storeOTP(kv, "5491155551234", "123456");
      for (let i = 0; i < 4; i++) {
        await verifyOTP(kv, "5491155551234", "000000");
      }
      // 5th attempt triggers lockout
      const result = await verifyOTP(kv, "5491155551234", "000000");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Too many attempts");
    });
  });

  describe("extension sessions", () => {
    it("stores and validates a session", async () => {
      await storeExtensionSession(kv, "token-abc", "5491155551234");
      const phone = await validateExtensionSession(kv, "token-abc");
      expect(phone).toBe("5491155551234");
    });

    it("returns null for unknown token", async () => {
      const phone = await validateExtensionSession(kv, "nonexistent");
      expect(phone).toBeNull();
    });

    it("revokes a session", async () => {
      await storeExtensionSession(kv, "token-abc", "5491155551234");
      await revokeExtensionSession(kv, "token-abc");
      const phone = await validateExtensionSession(kv, "token-abc");
      expect(phone).toBeNull();
    });
  });
});
