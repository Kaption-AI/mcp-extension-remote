import { describe, it, expect } from "vitest";
import {
  SendOTPSchema,
  VerifyOTPSchema,
  ExtSendOTPSchema,
  ExtVerifyOTPSchema,
  RevokeSessionSchema,
  RegisterClientSchema,
  isAllowedRedirectUri,
} from "./schemas";

// ─── SendOTPSchema ──────────────────────────────────────────────────

describe("SendOTPSchema", () => {
  it("accepts a valid phone number", async () => {
    const result = await SendOTPSchema.safeParseAsync({ phone: "5491155551234" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBe("5491155551234");
    }
  });

  it("strips formatting characters from phone", async () => {
    const result = await SendOTPSchema.safeParseAsync({ phone: "+54 (911) 5555-1234" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBe("5491155551234");
    }
  });

  it("rejects empty phone", async () => {
    const result = await SendOTPSchema.safeParseAsync({ phone: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing phone", async () => {
    const result = await SendOTPSchema.safeParseAsync({});
    expect(result.success).toBe(false);
  });

  it("rejects phone with letters", async () => {
    const result = await SendOTPSchema.safeParseAsync({ phone: "abc12345678" });
    expect(result.success).toBe(false);
  });

  it("rejects phone too short (< 8 digits)", async () => {
    const result = await SendOTPSchema.safeParseAsync({ phone: "1234567" });
    expect(result.success).toBe(false);
  });

  it("rejects phone too long (> 15 digits)", async () => {
    const result = await SendOTPSchema.safeParseAsync({ phone: "1234567890123456" });
    expect(result.success).toBe(false);
  });

  it("accepts optional oauthReqInfo", async () => {
    const result = await SendOTPSchema.safeParseAsync({
      phone: "5491155551234",
      oauthReqInfo: "some-state",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.oauthReqInfo).toBe("some-state");
    }
  });
});

// ─── VerifyOTPSchema ────────────────────────────────────────────────

describe("VerifyOTPSchema", () => {
  it("accepts valid input", async () => {
    const result = await VerifyOTPSchema.safeParseAsync({
      phone: "5491155551234",
      code: "123456",
      oauthReqInfo: "signed-state",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBe("5491155551234");
      expect(result.data.code).toBe("123456");
      expect(result.data.oauthReqInfo).toBe("signed-state");
    }
  });

  it("rejects non-6-digit code", async () => {
    const result = await VerifyOTPSchema.safeParseAsync({
      phone: "5491155551234",
      code: "12345",
      oauthReqInfo: "state",
    });
    expect(result.success).toBe(false);
  });

  it("rejects code with letters", async () => {
    const result = await VerifyOTPSchema.safeParseAsync({
      phone: "5491155551234",
      code: "12345a",
      oauthReqInfo: "state",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty oauthReqInfo", async () => {
    const result = await VerifyOTPSchema.safeParseAsync({
      phone: "5491155551234",
      code: "123456",
      oauthReqInfo: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing oauthReqInfo", async () => {
    const result = await VerifyOTPSchema.safeParseAsync({
      phone: "5491155551234",
      code: "123456",
    });
    expect(result.success).toBe(false);
  });
});

// ─── ExtSendOTPSchema ───────────────────────────────────────────────

describe("ExtSendOTPSchema", () => {
  it("accepts valid phone", async () => {
    const result = await ExtSendOTPSchema.safeParseAsync({ phone: "5491155551234" });
    expect(result.success).toBe(true);
  });

  it("strips formatting", async () => {
    const result = await ExtSendOTPSchema.safeParseAsync({ phone: "+1-555-123-4567" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBe("15551234567");
    }
  });

  it("rejects missing phone", async () => {
    const result = await ExtSendOTPSchema.safeParseAsync({});
    expect(result.success).toBe(false);
  });
});

// ─── ExtVerifyOTPSchema ─────────────────────────────────────────────

describe("ExtVerifyOTPSchema", () => {
  it("accepts valid phone + code", async () => {
    const result = await ExtVerifyOTPSchema.safeParseAsync({
      phone: "5491155551234",
      code: "000000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects 7-digit code", async () => {
    const result = await ExtVerifyOTPSchema.safeParseAsync({
      phone: "5491155551234",
      code: "1234567",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing code", async () => {
    const result = await ExtVerifyOTPSchema.safeParseAsync({
      phone: "5491155551234",
    });
    expect(result.success).toBe(false);
  });
});

// ─── RevokeSessionSchema ────────────────────────────────────────────

describe("RevokeSessionSchema", () => {
  it("accepts valid token", () => {
    const result = RevokeSessionSchema.safeParse({ token: "abc123" });
    expect(result.success).toBe(true);
  });

  it("rejects empty token", () => {
    const result = RevokeSessionSchema.safeParse({ token: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing token", () => {
    const result = RevokeSessionSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── RegisterClientSchema ───────────────────────────────────────────

describe("RegisterClientSchema", () => {
  it("accepts valid registration", () => {
    const result = RegisterClientSchema.safeParse({
      client_id: "my-client",
      redirect_uris: ["https://claude.ai/callback"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional client_name", () => {
    const result = RegisterClientSchema.safeParse({
      client_id: "my-client",
      client_name: "My MCP Client",
      redirect_uris: ["http://localhost:3000/callback"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.client_name).toBe("My MCP Client");
    }
  });

  it("rejects missing client_id", () => {
    const result = RegisterClientSchema.safeParse({
      redirect_uris: ["https://claude.ai/callback"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty redirect_uris array", () => {
    const result = RegisterClientSchema.safeParse({
      client_id: "my-client",
      redirect_uris: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid URL in redirect_uris", () => {
    const result = RegisterClientSchema.safeParse({
      client_id: "my-client",
      redirect_uris: ["not-a-url"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-array redirect_uris", () => {
    const result = RegisterClientSchema.safeParse({
      client_id: "my-client",
      redirect_uris: "https://claude.ai/callback",
    });
    expect(result.success).toBe(false);
  });
});

// ─── isAllowedRedirectUri ───────────────────────────────────────────

describe("isAllowedRedirectUri", () => {
  it("allows claude.ai", () => {
    expect(isAllowedRedirectUri("https://claude.ai/callback")).toBe(true);
  });

  it("allows subdomain of claude.ai", () => {
    expect(isAllowedRedirectUri("https://mcp.claude.ai/oauth/callback")).toBe(true);
  });

  it("allows localhost", () => {
    expect(isAllowedRedirectUri("http://localhost:3000/callback")).toBe(true);
  });

  it("allows localhost without port", () => {
    expect(isAllowedRedirectUri("http://localhost/callback")).toBe(true);
  });

  it("allows 127.0.0.1", () => {
    expect(isAllowedRedirectUri("http://127.0.0.1:8080/callback")).toBe(true);
  });

  it("allows cursor.sh", () => {
    expect(isAllowedRedirectUri("https://cursor.sh/callback")).toBe(true);
  });

  it("allows cursor.com", () => {
    expect(isAllowedRedirectUri("https://www.cursor.com/callback")).toBe(true);
  });

  it("allows kaptionai.com", () => {
    expect(isAllowedRedirectUri("https://mcp-ext.kaptionai.com/callback")).toBe(true);
  });

  it("allows windsurf.com", () => {
    expect(isAllowedRedirectUri("https://windsurf.com/oauth")).toBe(true);
  });

  it("rejects evil.com", () => {
    expect(isAllowedRedirectUri("https://evil.com/callback")).toBe(false);
  });

  it("rejects http claude.ai (must be https)", () => {
    expect(isAllowedRedirectUri("http://claude.ai/callback")).toBe(false);
  });

  it("rejects https localhost (must be http)", () => {
    expect(isAllowedRedirectUri("https://localhost:3000/callback")).toBe(false);
  });

  it("rejects subdomain impersonation (e.g. claude.ai.evil.com)", () => {
    expect(isAllowedRedirectUri("https://claude.ai.evil.com/callback")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isAllowedRedirectUri("")).toBe(false);
  });
});
