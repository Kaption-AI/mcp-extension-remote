import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: {} as any,
  completeAuthorization: vi.fn(),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: state.env }),
}));

vi.mock("@/src/otp", () => ({
  deriveAccountRef: vi.fn(async (phone: string) => `acct_${phone}`),
  hmacVerify: vi.fn(async () =>
    btoa(JSON.stringify({
      clientId: "openai-review-client",
      redirectUri: "https://chatgpt.com/callback",
      scope: ["kaption:access"],
    })),
  ),
  createVerifyTicket: vi.fn(),
  generateOTP: vi.fn(() => "123456"),
  checkRateLimit: vi.fn(async () => true),
  incrementRateLimit: vi.fn(async () => undefined),
  checkIpRateLimit: vi.fn(async () => true),
  incrementIpRateLimit: vi.fn(async () => undefined),
  storeOTP: vi.fn(async () => undefined),
  sanitizeForLog: vi.fn(() => "redacted"),
}));

import { POST as sendOtp } from "@/app/authorize/send-otp/route";
import { POST as reviewerLogin } from "@/app/authorize/reviewer-login/route";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function request(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://mcp.kaptionai.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "192.0.2.10",
    },
    body: JSON.stringify(body),
  });
}

describe("OpenAI reviewer authentication", () => {
  beforeEach(async () => {
    state.completeAuthorization.mockReset();
    state.completeAuthorization.mockResolvedValue({
      redirectTo: "https://chatgpt.com/callback?code=review-code",
    });
    state.env = {
      PHONE_REF_SECRET: "phone-ref-secret",
      INTERNAL_API_KEY: "internal-api-key",
      OPENAI_REVIEW_PHONE: "15555550123",
      OPENAI_REVIEW_PASSWORD_SHA256: await sha256Hex("review-password"),
      OAUTH_KV: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      OAUTH_PROVIDER: {
        completeAuthorization: state.completeAuthorization,
      },
    };
  });

  it("switches only the configured review phone to static-password mode", async () => {
    const response = await sendOtp(request("/authorize/send-otp", {
      phone: "+1 (555) 555-0123",
      oauthReqInfo: "signed-state",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      reviewPasswordRequired: true,
    });
  });

  it("keeps the reviewer endpoint disabled without both secrets", async () => {
    delete state.env.OPENAI_REVIEW_PHONE;
    const response = await reviewerLogin(request("/authorize/reviewer-login", {
      phone: "15555550123",
      password: "review-password",
      oauthReqInfo: "signed-state",
    }));

    expect(response.status).toBe(404);
    expect(state.completeAuthorization).not.toHaveBeenCalled();
  });

  it("completes OAuth for the configured synthetic account", async () => {
    const response = await reviewerLogin(request("/authorize/reviewer-login", {
      phone: "15555550123",
      password: "review-password",
      oauthReqInfo: "signed-state",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      redirectTo: "https://chatgpt.com/callback?code=review-code",
    });
    expect(state.completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "acct_15555550123",
        props: { accountRef: "acct_15555550123" },
        scope: ["kaption:access"],
      }),
    );
  });

  it("rejects an incorrect static password", async () => {
    const response = await reviewerLogin(request("/authorize/reviewer-login", {
      phone: "15555550123",
      password: "wrong-password",
      oauthReqInfo: "signed-state",
    }));

    expect(response.status).toBe(401);
    expect(state.completeAuthorization).not.toHaveBeenCalled();
  });
});
