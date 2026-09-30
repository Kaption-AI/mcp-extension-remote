import { describe, expect, it, vi } from "vitest";
import { encryptLoginHint } from "./otp";
import { applySecurityHeaders, createFetchHandler, getMcpOrigin } from "./index";
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
        // Mirrors @cloudflare/workers-oauth-provider 0.10: no token → empty
        // body; a bad token → {error, error_description} with error= in the
        // challenge.
        const metadata = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
        const auth = request.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ")) {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              "Cache-Control": "no-store",
              "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${metadata}", scope="kaption:access"`,
            },
          }));
        }
        return Promise.resolve(new Response(
          JSON.stringify({ error: "invalid_token", error_description: "Invalid access token" }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "WWW-Authenticate":
                `Bearer realm="OAuth", resource_metadata="${metadata}", error="invalid_token", scope="kaption:access"`,
            },
          },
        ));
      }
      return this.config.defaultHandler.fetch(request, env, ctx);
    }
  }

  // Per-request helpers: hand back the helpers each test's env carries.
  return {
    default: MockOAuthProvider,
    getOAuthApi: vi.fn((_options: unknown, env: { OAUTH_PROVIDER?: unknown }) => env.OAUTH_PROVIDER),
  };
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
  it("publishes canonical RFC 9728 protected-resource metadata", async () => {
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

  it("keeps RFC 9728 metadata on the legacy mcp-ext hostname", async () => {
    const handler = createFetchHandler({
      fetch: vi.fn(async () => new Response("unexpected")),
    } as any);
    const { ctx } = createExecutionContext();

    const response = await handler(
      new Request("https://mcp-ext.kaptionai.com/.well-known/oauth-protected-resource"),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: "https://mcp-ext.kaptionai.com/mcp",
      authorization_servers: ["https://mcp-ext.kaptionai.com"],
      scopes_supported: ["kaption:access"],
    });
  });

  it("never trusts an unknown request host as an OAuth issuer", () => {
    expect(getMcpOrigin(new URL("https://attacker.example/mcp"))).toBe(
      "https://mcp.kaptionai.com",
    );
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

  it("answers a tokenless MCP initialize with a JSON invalid_request body and the unchanged challenge", async () => {
    const handler = createFetchHandler({
      fetch: vi.fn(async () => new Response("unexpected")),
    } as any);
    const { ctx } = createExecutionContext();

    const response = await handler(
      new Request("https://mcp.kaptionai.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="OAuth", resource_metadata="https://mcp.kaptionai.com/.well-known/oauth-protected-resource/mcp", scope="kaption:access"',
    );
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: expect.any(String),
      resource_metadata: "https://mcp.kaptionai.com/.well-known/oauth-protected-resource/mcp",
    });
  });

  it("answers a bad token on tools/list with a JSON invalid_token body and the unchanged challenge", async () => {
    const handler = createFetchHandler({
      fetch: vi.fn(async () => new Response("unexpected")),
    } as any);
    const { ctx } = createExecutionContext();

    const response = await handler(
      new Request("https://mcp.kaptionai.com/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer not-a-real-token", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="OAuth", resource_metadata="https://mcp.kaptionai.com/.well-known/oauth-protected-resource/mcp", error="invalid_token", scope="kaption:access"',
    );
    expect(await response.json()).toEqual({
      error: "invalid_token",
      error_description: "Invalid access token",
      resource_metadata: "https://mcp.kaptionai.com/.well-known/oauth-protected-resource/mcp",
    });
  });

  it("returns JSON errors from the extension token exchange", async () => {
    const handler = createFetchHandler({
      fetch: vi.fn(async () => new Response("unexpected")),
    } as any);
    const { ctx } = createExecutionContext();

    const response = await handler(
      new Request("https://mcp.kaptionai.com/ws/auth", { method: "POST" }),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "Missing bearer token",
    });
  });

  it("keeps legacy-host 401 challenges and metadata on the same origin", async () => {
    const handler = createFetchHandler({
      fetch: vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    } as any);
    const { ctx } = createExecutionContext();

    const response = await handler(
      new Request("https://mcp-ext.kaptionai.com/mcp"),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp-ext.kaptionai.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(((await response.json()) as { resource_metadata: string }).resource_metadata).toBe(
      "https://mcp-ext.kaptionai.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("allows browser connections to both production MCP domains", () => {
    const headers = new Headers();
    applySecurityHeaders(headers);
    const csp = headers.get("content-security-policy") ?? "";

    expect(csp).toContain("https://mcp.kaptionai.com");
    expect(csp).toContain("https://mcp-ext.kaptionai.com");
  });
});

describe("mcp.CONNECT_CODE.8 page language", () => {
  function pageHandler() {
    let forwarded: Request | null = null;
    const handler = createFetchHandler({
      fetch: vi.fn(async (request: Request) => {
        forwarded = request;
        return new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
      }),
    } as any);
    return { handler, forwarded: () => forwarded as Request | null };
  }

  it("/connect?lang= renders in that language and remembers it in kaption_lang for a year", async () => {
    const { handler, forwarded } = pageHandler();
    const { ctx } = createExecutionContext();
    const response = await handler(
      new Request("https://mcp.kaptionai.com/connect?app=claude&lang=zh_TW"),
      createEnv(),
      ctx,
    );
    expect(forwarded()?.headers.get("x-kaption-lang")).toBe("zh-TW");
    expect(response.headers.get("set-cookie")).toBe(
      "kaption_lang=zh-TW; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
  });

  it("without a usable lang nothing is set", async () => {
    for (const url of ["https://mcp.kaptionai.com/connect?app=claude", "https://mcp.kaptionai.com/connect?lang=xx"]) {
      const { handler, forwarded } = pageHandler();
      const { ctx } = createExecutionContext();
      const response = await handler(new Request(url), createEnv(), ctx);
      expect(forwarded()?.headers.get("x-kaption-lang")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("a sign-in request the library rejects says so in the remembered language", async () => {
    const { handler } = pageHandler();
    const { ctx } = createExecutionContext();
    const env = createEnv({
      OAUTH_PROVIDER: { parseAuthRequest: vi.fn(async () => { throw new Error("invalid_target"); }) } as any,
    });
    const response = await handler(
      new Request("https://mcp.kaptionai.com/authorize?client_id=x", {
        headers: { cookie: "kaption_lang=es", "accept-language": "de" },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-language")).toBe("es");
    expect(await response.text()).toMatch(/^Kaption no /);
  });
});
