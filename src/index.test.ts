import { describe, expect, it, vi } from "vitest";
import { encryptLoginHint } from "./otp";
import { createFetchHandler } from "./index";
import type { Env } from "./types";

vi.mock("./relay-mcp", () => ({
  RelayMCP: {
    serveSSE: () => vi.fn(),
    serve: () => vi.fn(),
  },
}));

vi.mock("./relay-room", () => ({
  RelayRoom: class RelayRoom {},
}));

vi.mock("./deployment-chain", () => ({
  DeploymentChainDO: class DeploymentChainDO {},
}));

vi.mock("@cloudflare/workers-oauth-provider", () => {
  class MockOAuthProvider {
    private readonly config: any;

    constructor(config: any) {
      this.config = config;
    }

    fetch(request: Request, env: any, ctx: any): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Promise.resolve(Response.json(this.config.resourceMetadata));
      }
      if (this.config.apiHandlers[url.pathname]) {
        return Promise.resolve(new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate":
              `Bearer realm="OAuth", resource_metadata="${url.origin}/.well-known/oauth-protected-resource${url.pathname}"`,
          },
        }));
      }
      return this.config.defaultHandler.fetch(request, env, ctx);
    }
  }

  return { default: MockOAuthProvider };
});

const TEST_PHONE = "5491155551234";

function createExecutionContext() {
  const tasks: Promise<unknown>[] = [];

  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        tasks.push(Promise.resolve(promise));
      },
    } as ExecutionContext,
    async flush() {
      await Promise.all(tasks);
    },
  };
}

function createEnv(overrides?: Partial<Env>): Env {
  return {
    MCP_OBJECT: {} as unknown as Env["MCP_OBJECT"],
    RELAY_ROOM: {} as unknown as Env["RELAY_ROOM"],
    DEPLOYMENT_CHAIN: {} as unknown as Env["DEPLOYMENT_CHAIN"],
    OAUTH_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn(async () => ({
        clientId: "claude-ai",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        scope: "whatsapp",
        state: "oauth-state",
      })),
    } as any,
    INTERNAL_API_BASE_URL: "https://api.kaptionai.com",
    INTERNAL_API_KEY: "internal-api-key",
    DEPLOY_API_KEY: "deploy-api-key",
    JWT_SECRET: "jwt-secret",
    PHONE_REF_SECRET: "phone-ref-secret",
    EPHEMERAL_STATE_SECRET: "ephemeral-state-secret",
    BUILD_HASH: "build-hash",
    COMMIT_SHA: "commit-sha",
    ...overrides,
  };
}

describe("createFetchHandler authorize login hint flow", () => {
  it("injects the decrypted login hint and deletes it after use", async () => {
    const encryptedHint = await encryptLoginHint(TEST_PHONE, "ephemeral-state-secret");
    const get = vi.fn(async () => encryptedHint);
    const del = vi.fn(async () => undefined);
    const env = createEnv({
      OAUTH_KV: {
        get,
        put: vi.fn(async () => undefined),
        delete: del,
      } as unknown as KVNamespace,
    });

    let forwardedUrl = "";
    const nextHandler = {
      fetch: vi.fn(async (request: Request) => {
        forwardedUrl = request.url;
        return new Response("ok");
      }),
    };

    const handler = createFetchHandler(nextHandler as any);
    const { ctx, flush } = createExecutionContext();

    await handler(
      new Request("https://mcp.kaptionai.com/authorize", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
      env,
      ctx,
    );
    await flush();

    const params = new URL(forwardedUrl).searchParams;
    expect(params.get("_loginHint")).toBe(TEST_PHONE);
    expect(get).toHaveBeenCalledWith("login_hint:1.2.3.4");
    expect(del).toHaveBeenCalledWith("login_hint:1.2.3.4");
  });

  it("still deletes the hint if decryption fails", async () => {
    const del = vi.fn(async () => undefined);
    const env = createEnv({
      OAUTH_KV: {
        get: vi.fn(async () => "not-a-valid-hint"),
        put: vi.fn(async () => undefined),
        delete: del,
      } as unknown as KVNamespace,
    });

    let forwardedUrl = "";
    const nextHandler = {
      fetch: vi.fn(async (request: Request) => {
        forwardedUrl = request.url;
        return new Response("ok");
      }),
    };

    const handler = createFetchHandler(nextHandler as any);
    const { ctx, flush } = createExecutionContext();

    await handler(
      new Request("https://mcp.kaptionai.com/authorize", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
      env,
      ctx,
    );
    await flush();

    const params = new URL(forwardedUrl).searchParams;
    expect(params.get("_loginHint")).toBeNull();
    expect(del).toHaveBeenCalledWith("login_hint:1.2.3.4");
  });
});

describe("createFetchHandler OpenAI plugin discovery", () => {
  it("publishes RFC 9728 protected-resource metadata", async () => {
    const handler = createFetchHandler({
      fetch: vi.fn(async () => new Response("unexpected")),
    } as any);
    const { ctx } = createExecutionContext();

    const response = await handler(
      new Request("https://mcp.kaptionai.com/.well-known/oauth-protected-resource"),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: "https://mcp.kaptionai.com/mcp",
      authorization_servers: ["https://mcp.kaptionai.com"],
      scopes_supported: ["kaption:access"],
    });
  });

  it("returns the exact configured OpenAI domain challenge token", async () => {
    const handler = createFetchHandler({
      fetch: vi.fn(async () => new Response("unexpected")),
    } as any);
    const { ctx } = createExecutionContext();

    const response = await handler(
      new Request("https://mcp.kaptionai.com/.well-known/openai-apps-challenge"),
      createEnv({ OPENAI_APPS_CHALLENGE_TOKEN: "portal-token-123" }),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("portal-token-123");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("keeps the domain challenge unavailable until a token is configured", async () => {
    const handler = createFetchHandler({
      fetch: vi.fn(async () => new Response("unexpected")),
    } as any);
    const { ctx } = createExecutionContext();

    const response = await handler(
      new Request("https://mcp.kaptionai.com/.well-known/openai-apps-challenge"),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(404);
  });

  it("adds protected-resource discovery to OAuth 401 challenges", async () => {
    const handler = createFetchHandler({
      fetch: vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    } as any);
    const { ctx } = createExecutionContext();

    const response = await handler(
      new Request("https://mcp.kaptionai.com/mcp"),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.kaptionai.com/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
