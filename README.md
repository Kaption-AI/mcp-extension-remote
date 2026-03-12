# kaption-mcp-remote

Cloud MCP relay for WhatsApp — lets AI assistants (Claude, ChatGPT, Cursor, etc.) interact with your WhatsApp conversations through the [Model Context Protocol](https://modelcontextprotocol.io/).

**Live at:** [mcp-ext.kaptionai.com](https://mcp-ext.kaptionai.com)

The relay **cannot read your messages**. It forwards MCP tool calls between the AI client and the Kaption browser extension, which processes everything locally in your browser. The code is open source — verify it yourself.

## Architecture

```
AI Client (Claude/ChatGPT/Cursor)
    │
    │ OAuth 2.1 + SSE/Streamable HTTP
    ▼
┌─────────────────────────────────────┐
│  Cloudflare Worker                  │
│  mcp-ext.kaptionai.com             │
│                                     │
│  ┌────────────┐  ┌──────────────┐  │
│  │ OAuthProv  │  │ Next.js      │  │
│  │ /sse /mcp  │  │ /authorize   │  │
│  │ /token     │  │ /ext-auth    │  │
│  │ /register  │  │ / (landing)  │  │
│  └─────┬──────┘  └──────────────┘  │
│        │                            │
│  ┌─────▼──────┐  ┌──────────────┐  │
│  │ RelayMCP   │  │ Deployment   │  │
│  │ (DO)       │  │ ChainDO      │  │
│  └─────┬──────┘  └──────────────┘  │
│        │                            │
│  ┌─────▼──────┐                    │
│  │ RelayRoom  │ ◄── WebSocket ──┐  │
│  │ (DO/accountRef) │            │  │
│  └────────────┘                 │  │
└─────────────────────────────────┼──┘
                                  │
                          Browser Extension
                          (WhatsApp Web tab)
```

### Durable Objects

| DO | Keyed By | Purpose |
|----|----------|---------|
| **RelayMCP** | OAuth session | McpAgent — registers tools, relays JSON-RPC to RelayRoom |
| **RelayRoom** | Opaque accountRef | WebSocket bridge to extension, auth handshake, request/response matching |
| **DeploymentChainDO** | `"main"` | Append-only hash chain for deployment transparency |

## Request Flow

1. AI client discovers the MCP server via `/.well-known/oauth-authorization-server`
2. Client registers dynamically via `POST /register` (RFC 7591)
3. User authenticates with WhatsApp OTP at `/authorize`
4. Client exchanges code for token at `/token`
5. Client sends tool calls via SSE (`/sse`) or Streamable HTTP (`/mcp`)
6. **RelayMCP** DO receives the call, routes to **RelayRoom** for the accountRef
7. **RelayRoom** forwards JSON-RPC to the extension over WebSocket
8. Extension executes in WhatsApp Web context, returns result
9. Result flows back: RelayRoom → RelayMCP → AI client

## Routing Table

| Path | Method | Auth | Handler |
|------|--------|------|---------|
| `/` | GET | — | Next.js landing page |
| `/authorize` | GET | — | Next.js OTP form (HMAC-signed oauthReqInfo) |
| `/authorize/send-otp` | POST | — | Next.js API route → rest-api |
| `/authorize/verify` | GET/POST | — | Next.js OTP verify → OAuthProvider completeAuthorization |
| `/register` | POST | — | OAuthProvider (RFC 7591 dynamic client registration) |
| `/token` | POST | — | OAuthProvider (token exchange) |
| `/sse` | GET | OAuth token | RelayMCP DO (SSE transport) |
| `/mcp` | POST | OAuth token | RelayMCP DO (Streamable HTTP) |
| `/ws/ext` | GET | JWT/token in auth msg | RelayRoom DO (WebSocket upgrade) |
| `/ext-auth/*` | Various | — | Next.js extension auth pages + API |
| `/transparency` | GET | — | DeploymentChainDO (chain history) |
| `/transparency/latest` | GET | — | DeploymentChainDO (latest entry) |
| `/transparency/verify` | GET | — | DeploymentChainDO (chain integrity) |
| `/transparency/gaps` | GET | CF token | Cross-reference CF deploys with chain |
| `/transparency/append` | POST | DEPLOY_API_KEY | Append entry (CI only) |

## MCP Tools

10 tools forwarded to the extension (relay does not execute them):

| Tool | Description |
|------|-------------|
| `query` | Query conversations, contacts, messages, transcriptions, labels, communities, sessions |
| `summarize_conversation` | Get or generate a conversation summary |
| `manage_labels` | Add/remove/create/delete WhatsApp Business labels |
| `manage_notes` | Get/set contact notes (Business accounts) |
| `download_media` | Download image/video/audio/document from a message |
| `manage_chat` | Archive, pin, mute, mark read/unread, set/clear draft |
| `manage_reminders` | Create/list/complete/delete personal reminders |
| `manage_scheduled_messages` | Schedule messages for future delivery |
| `manage_lists` | Manage personal chat lists (custom categories) |
| `get_api_info` | Get REST API connection info |

## Deployment Security

Every deployment is cryptographically signed and recorded in a tamper-evident transparency chain. See [SECURITY.md](./SECURITY.md) for full details.

### Pipeline

```
GitHub Actions (push to main)
    │
    ├─ 1. Run tests
    ├─ 2. Build worker (OpenNext + wrap)
    ├─ 3. SHA-256 hash the bundle
    ├─ 4. Pre-deploy: Sigstore sign → Rekor log
    ├─ 5. Deploy to Cloudflare
    ├─ 6. Post-deploy: verify hash unchanged, sign attestation → Rekor
    └─ 7. Append to transparency chain (hash-linked)
```

Daily heartbeat redeploys (6am UTC) ensure the chain stays active even without code changes.

Local deploys are blocked — `npm run deploy` checks for `$CI`.

### Verify a Deployment

```bash
# 1. Check the transparency chain
curl -s https://mcp-ext.kaptionai.com/transparency/latest | jq .

# 2. Verify chain integrity
curl -s https://mcp-ext.kaptionai.com/transparency/verify | jq .

# 3. Verify Sigstore signature (requires cosign)
COMMIT=$(curl -s https://mcp-ext.kaptionai.com/transparency/latest | jq -r '.event.commitSha')
cosign verify-blob \
  --bundle worker.js.sigstore.json \
  --certificate-identity-regexp "https://github.com/Kaption-AI/mcp-extension-remote/.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  worker.js
```

## API Endpoints

### Transparency API (public, no auth)

```bash
# Full chain history (paginated)
GET /transparency?limit=50&offset=0

# Latest deployment
GET /transparency/latest

# Verify chain integrity
GET /transparency/verify
```

### MCP (OAuth-protected)

```bash
# SSE transport (for Claude Code, Cursor)
GET /sse

# Streamable HTTP transport
POST /mcp
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Dev server (Next.js only — no Worker routing)
npm run dev

# Build the full worker (OpenNext + custom wrapper)
npm run build:worker
```

### Project Structure

```
src/
  index.ts            # Worker entry — Hono routing, OAuthProvider composition
  relay-mcp.ts        # RelayMCP Durable Object (McpAgent)
  relay-room.ts       # RelayRoom Durable Object (WebSocket bridge)
  deployment-chain.ts # DeploymentChainDO (transparency log)
  otp.ts              # OTP generation, verification, JWT, HMAC, rate limiting
  schemas.ts          # Zod schemas for API request validation
  tools.ts            # MCP tool definitions (forwarded, not executed)
  types.ts            # TypeScript interfaces (Env, DeploymentEvent, etc.)
app/
  page.tsx            # Landing page (multilingual, client-side i18n)
  layout.tsx          # Root layout
  i18n.ts             # i18next init (8 languages)
  locales/            # Translation JSON files
  authorize/          # OAuth OTP flow pages + API routes
  ext-auth/           # Extension auth pages + API routes
scripts/
  wrap-worker.mjs     # Post-build: wraps OpenNext output with custom routing
```

## Environment Variables

### Vars (wrangler.jsonc)

| Variable | Description |
|----------|-------------|
| `INTERNAL_API_BASE_URL` | Backend API base URL |
| `BUILD_HASH` | SHA-256 of worker bundle (set by CI) |
| `COMMIT_SHA` | Git commit SHA (set by CI) |

### Secrets (`wrangler secret put`)

| Secret | Description |
|--------|-------------|
| `INTERNAL_API_KEY` | API key for rest-api OTP endpoint |
| `DEPLOY_API_KEY` | API key for transparency chain append |
| `JWT_SECRET` | Shared JWT signing secret (same as rest-api, schedule, metadata workers) |
| `PHONE_REF_SECRET` | HMAC secret used to derive opaque durable account references from phone numbers |
| `EPHEMERAL_STATE_SECRET` | Encryption secret for short-lived login hints, verify tickets, and encrypted session phone payloads |

## Related Projects

- **[Kaption Extension](https://kaptionai.com/extension)** — Chrome/Edge/Firefox browser extension (the other side of the relay)
- **[@kaptionai/mcp-extension](https://www.npmjs.com/package/@kaptionai/mcp-extension)** — Local MCP bridge (runs on your machine, no cloud relay)

## License

[BUSL-1.1](./LICENSE)
