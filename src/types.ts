import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { RelayRoom } from "./relay-room";
import type { DeploymentChainDO } from "./deployment-chain";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  RELAY_ROOM: DurableObjectNamespace<RelayRoom>;
  DEPLOYMENT_CHAIN: DurableObjectNamespace<DeploymentChainDO>;
  OAUTH_KV: KVNamespace;
  AUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  INTERNAL_API_BASE_URL: string;
  INTERNAL_API_KEY: string;
  DEPLOY_API_KEY?: string;
  BUILD_HASH: string;
  COMMIT_SHA: string;
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
  phone: string;
  createdAt: number;
}

export interface DeploymentEvent {
  version: string;
  commitSha: string;
  buildHash: string;
  sigstoreBundleUrl: string;
  rekorLogIndex: string;
  deployedAt: string;
}

export interface ChainEntry {
  sequence: number;
  chainHash: string;
  event: DeploymentEvent;
  previousHash: string;
}
