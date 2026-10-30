import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { RelayRoom } from "./relay-room";
import type { DeploymentChainDO } from "./deployment-chain";
import type { UsageLedger, UsageTotals } from "./usage-ledger";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  RELAY_ROOM: DurableObjectNamespace<RelayRoom>;
  DEPLOYMENT_CHAIN: DurableObjectNamespace<DeploymentChainDO>;
  /** mcp-usage-accounting.STORE.1 — one ledger per account. */
  USAGE_LEDGER?: DurableObjectNamespace<UsageLedger>;
  /** mcp-usage-accounting.ADMIN.1 — global totals without accounts. */
  USAGE_TOTALS?: DurableObjectNamespace<UsageTotals>;
  /** mcp-usage-accounting.STORE.4 — "off" stops recording (kill switch); anything else records. */
  USAGE_LEDGER_ENABLED?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  INTERNAL_API_BASE_URL: string;
  INTERNAL_API_KEY: string;
  DEPLOY_API_KEY?: string;
  JWT_SECRET: string;
  PHONE_REF_SECRET: string;
  EPHEMERAL_STATE_SECRET: string;
  BUILD_HASH: string;
  COMMIT_SHA: string;
  OPENAI_APPS_CHALLENGE_TOKEN?: string;
  OPENAI_REVIEW_PASSWORD_SHA256?: string;
  OPENAI_REVIEW_PHONE?: string;
}

export interface OTPRecord {
  code: string;
  attempts: number;
  createdAt: number;
}

export interface RateLimitRecord {
  count: number;
  windowStart: number;
}

export interface ExtensionSession {
  accountRef: string;
  phoneCiphertext: string;
  createdAt: number;
}

export interface DeploymentEvent {
  version: string;
  commitSha: string;
  buildHash: string;
  sigstoreBundleUrl: string;
  rekorLogIndex: string;
  deployedAt: string;
  // Phase 2: post-deploy attestation fields (optional for backwards compat)
  cfVersionId?: string;
  preDeployRekorIndex?: string;
  source?: "github-actions" | "manual" | "heartbeat";
}

export interface ChainEntry {
  sequence: number;
  chainHash: string;
  event: DeploymentEvent;
  previousHash: string;
}
