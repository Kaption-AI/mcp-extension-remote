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
  /**
   * business-plans.MCP_LEDGER.1 — "on" lets the ledger meter Claude and ChatGPT overage (rest-api still has to answer
   * metered for the account); anything else: nothing is reserved, charged or marked, as before.
   */
  MCP_OVERAGE_LEDGER?: string;
  /**
   * disabled-gating.SWITCH.4 — phones whose tool calls are checked against rest-api's disabled-account answer
   * ("*" = every account; unset or empty = nobody, every call runs as before). rest-api's own switch still decides.
   */
  DISABLED_FULL_GATING_PHONES?: string;
  /**
   * weekly-plan-limits.SERVER.13 (Kaption-AI monorepo) — phones whose cloud calls are counted on rest-api's weekly ledger
   * ("*" = every account; unset or empty = nobody, every call runs as before). rest-api's own switch still decides.
   */
  WEEKLY_PLAN_LIMITS_PHONES?: string;
  /**
   * mcp-usage-pricing.USAGE.5-8 — "on"/"*" or a phone list: tool results carry what is left (_meta.kaption.usage, the
   * X-Kaption-Usage-* headers, a short line near the limit). Unset or "off": responses are byte-for-byte unchanged.
   */
  MCP_USAGE_IN_RESULTS?: string;
  /**
   * mcp-usage-ledger.SHADOW.1 (Kaption-AI monorepo) — phones whose ledger keeps its plan and judges its windows against
   * it, without enforcing anything ("*" = everyone; unset, empty or "off" = nobody: nothing is fetched or stored).
   */
  LEDGER_SHADOW?: string;
  /** mcp-usage-ledger.TOTALS.1 — global totals objects (default 16; "1" = the old single "global"). */
  USAGE_TOTALS_SHARDS?: string;
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
