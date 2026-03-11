/**
 * DeploymentChainDO — Append-only hash chain for deployment transparency.
 *
 * Records every deployment with a cryptographic hash chain.
 * Each entry links to the previous via SHA-256, creating a tamper-evident log.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env, DeploymentEvent, ChainEntry } from "./types";

async function sha256(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const GENESIS_HASH = "genesis:kaption-mcp-remote";

export class DeploymentChainDO extends DurableObject<Env> {
  /**
   * Append a new deployment record to the chain.
   */
  async appendDeployment(
    event: DeploymentEvent,
  ): Promise<{ chainHash: string; sequence: number }> {
    const entries = await this.loadEntries();
    const previousHash =
      entries.length > 0
        ? entries[entries.length - 1].chainHash
        : await sha256(GENESIS_HASH);

    const sequence = entries.length + 1;
    const payload = previousHash + JSON.stringify(event);
    const chainHash = await sha256(payload);

    const entry: ChainEntry = {
      sequence,
      chainHash,
      event,
      previousHash,
    };

    entries.push(entry);
    await this.ctx.storage.put("chain", JSON.stringify(entries));

    return { chainHash, sequence };
  }

  /**
   * Get deployment history with pagination. [L3] Capped at 100 entries per response.
   */
  async getHistory(limit = 100, offset = 0): Promise<{ entries: ChainEntry[]; total: number }> {
    const all = await this.loadEntries();
    const entries = all.slice(offset, offset + Math.min(limit, 100));
    return { entries, total: all.length };
  }

  /**
   * Get the latest deployment entry.
   */
  async getLatest(): Promise<ChainEntry | null> {
    const entries = await this.loadEntries();
    return entries.length > 0 ? entries[entries.length - 1] : null;
  }

  /**
   * Verify the integrity of the entire chain.
   */
  async verifyChain(): Promise<{ valid: boolean; entries: number; error?: string }> {
    const entries = await this.loadEntries();

    if (entries.length === 0) {
      return { valid: true, entries: 0 };
    }

    const genesisHash = await sha256(GENESIS_HASH);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const expectedPrevious = i === 0 ? genesisHash : entries[i - 1].chainHash;

      if (entry.previousHash !== expectedPrevious) {
        return {
          valid: false,
          entries: entries.length,
          error: `Chain broken at sequence ${entry.sequence}: previousHash mismatch`,
        };
      }

      const payload = entry.previousHash + JSON.stringify(entry.event);
      const expectedHash = await sha256(payload);

      if (entry.chainHash !== expectedHash) {
        return {
          valid: false,
          entries: entries.length,
          error: `Chain broken at sequence ${entry.sequence}: chainHash mismatch`,
        };
      }
    }

    return { valid: true, entries: entries.length };
  }

  private async loadEntries(): Promise<ChainEntry[]> {
    const raw = await this.ctx.storage.get<string>("chain");
    if (!raw) return [];
    return JSON.parse(raw) as ChainEntry[];
  }
}
