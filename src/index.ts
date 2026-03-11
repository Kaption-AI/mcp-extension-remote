/**
 * kaption-mcp-remote — Cloud MCP Relay for WhatsApp
 *
 * Cloudflare Worker entry point. Wires together:
 * - OAuthProvider for MCP client authentication (WhatsApp OTP)
 * - RelayMCP Durable Object for MCP tool handling
 * - RelayRoom Durable Object for WebSocket relay to extension
 * - DeploymentChainDO for build transparency
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { RelayMCP } from "./relay-mcp";
import { RelayRoom } from "./relay-room";
import { DeploymentChainDO } from "./deployment-chain";
import { WhatsAppOTPHandler } from "./whatsapp-otp-handler";
import { validateExtensionSession } from "./otp";
import type { Env } from "./types";

// Re-export Durable Objects for wrangler
export { RelayMCP, RelayRoom, DeploymentChainDO };

// ─── MCP Handler (authenticated tool calls) ───────────────────────────

const mcpApp = new Hono<{ Bindings: Env }>();

mcpApp.all("/sse", async (c) => {
  try {
    const handler = RelayMCP.serveSSE("/sse");
    return await handler.fetch(c.req.raw, c.env, c.executionCtx);
  } catch (error) {
    console.error("Error in /sse handler:", error);
    return c.text(
      `Internal Server Error: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
});

mcpApp.all("/mcp", async (c) => {
  try {
    const handler = RelayMCP.serve("/mcp");
    return await handler.fetch(c.req.raw, c.env, c.executionCtx);
  } catch (error) {
    console.error("Error in /mcp handler:", error);
    return c.text(
      `Internal Server Error: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
});

// ─── Non-OAuth routes (handled before OAuthProvider) ──────────────────

const outerApp = new Hono<{ Bindings: Env }>();

// Extension WebSocket endpoint (not behind OAuth)
outerApp.get("/ws/ext", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (upgradeHeader !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  // Authenticate via cloud_token query param
  const url = new URL(c.req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return c.text("Missing token parameter", 401);
  }

  const phone = await validateExtensionSession(c.env.AUTH_KV, token);
  if (!phone) {
    return c.text("Invalid or expired token", 401);
  }

  // Route to the RelayRoom for this phone number
  const roomId = c.env.RELAY_ROOM.idFromName(phone);
  const room = c.env.RELAY_ROOM.get(roomId);
  return room.handleExtensionWebSocket(c.req.raw);
});

// Transparency endpoints
outerApp.get("/transparency", async (c) => {
  const chainId = c.env.DEPLOYMENT_CHAIN.idFromName("main");
  const chain = c.env.DEPLOYMENT_CHAIN.get(chainId);
  const history = await chain.getHistory();
  return c.json(history);
});

outerApp.get("/transparency/latest", async (c) => {
  const chainId = c.env.DEPLOYMENT_CHAIN.idFromName("main");
  const chain = c.env.DEPLOYMENT_CHAIN.get(chainId);
  const latest = await chain.getLatest();
  return c.json(latest || { message: "No deployments recorded" });
});

outerApp.get("/transparency/verify", async (c) => {
  const chainId = c.env.DEPLOYMENT_CHAIN.idFromName("main");
  const chain = c.env.DEPLOYMENT_CHAIN.get(chainId);
  const result = await chain.verifyChain();
  return c.json(result);
});

outerApp.post("/transparency/append", async (c) => {
  const apiKey = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!c.env.DEPLOY_API_KEY || apiKey !== c.env.DEPLOY_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const event = await c.req.json();
  const chainId = c.env.DEPLOYMENT_CHAIN.idFromName("main");
  const chain = c.env.DEPLOYMENT_CHAIN.get(chainId);
  const result = await chain.appendDeployment(event as any);
  return c.json(result);
});

// ─── Main export: OAuthProvider wrapping everything ───────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Routes that bypass OAuth
    if (
      url.pathname === "/ws/ext" ||
      url.pathname.startsWith("/transparency") ||
      url.pathname.startsWith("/ext-auth") ||
      url.pathname === "/build-info"
    ) {
      // For /ext-auth and /build-info, delegate to the WhatsAppOTPHandler
      if (url.pathname.startsWith("/ext-auth") || url.pathname === "/build-info") {
        const handler = WhatsAppOTPHandler as any;
        return handler.fetch(request, env, ctx);
      }
      // For /ws/ext and /transparency, use outerApp
      return outerApp.fetch(request, env, ctx);
    }

    // Everything else goes through OAuthProvider
    const oauthHandler = new OAuthProvider({
      apiHandlers: {
        "/sse": mcpApp as any,
        "/mcp": mcpApp as any,
      },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      defaultHandler: WhatsAppOTPHandler as any,
    });

    return oauthHandler.fetch(request, env, ctx);
  },
};
