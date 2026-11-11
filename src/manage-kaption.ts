/**
 * mcp-manage-kaption — the "manage Kaption" tools on the cloud relay: who sees them (LIST.2), the guides and prompts as MCP
 * resources and prompts (HELP.3, PROMPTS.2) and the plans UI resource (UI.1-3). The extension answers every call;
 * the relay only lists and forwards. Spec: kext/features/mcp/mcp-manage-kaption.feature.yaml in the kaptionai repo.
 *
 * Kept in step with the local hub's src/manageKaption.ts (kaption-mcp).
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PLANS_UI_URI } from './tools';
import { PLANS_UI_HTML, PLANS_UI_MIME_TYPE } from './plans-ui';

/** The families an account's extension said it may use (handshake / auth `features`). */
export interface ManageFeatures {
  manage_kaption?: boolean;
  business_agent?: boolean;
  plans?: boolean;
  /** scheduled-status.MCP — SCHEDULED_STATUS_POSTS on for this account (manage_status, list_status_posts). */
  scheduled_status?: boolean;
  /** whatsapp-channels-communities.HUB.1 — MCP_CHANNELS_COMMUNITIES on for this account (manage_channels, manage_communities
   * and their read tools). */
  channels_communities?: boolean;
  /** chat-export.MCP.6 — MCP_EXPORT_CHAT on for this account (export_chat). */
  export_chat?: boolean;
}

/** mcp-manage-kaption.LIST.2 — which `features` key shows each tool. */
export const MANAGE_TOOL_FEATURE: Readonly<Record<string, keyof ManageFeatures>> = Object.freeze({
  get_kaption_settings: 'manage_kaption',
  update_kaption_settings: 'manage_kaption',
  reconnect_kaption_connection: 'manage_kaption',
  kaption_help: 'manage_kaption',
  report_bug: 'manage_kaption',
  get_business_agent: 'business_agent',
  manage_business_agent: 'business_agent',
  kaption_plans: 'plans',
  create_kaption_checkout_link: 'plans',
  manage_status: 'scheduled_status',
  list_status_posts: 'scheduled_status',
  manage_channels: 'channels_communities',
  manage_communities: 'channels_communities',
  list_channels: 'channels_communities',
  get_channel: 'channels_communities',
  list_scheduled_channel_posts: 'channels_communities',
  list_communities: 'channels_communities',
  get_community: 'channels_communities',
  get_community_digest: 'channels_communities',
  export_chat: 'export_chat',
});

export const MANAGE_KAPTION_TOOLS: readonly string[] = Object.freeze(Object.keys(MANAGE_TOOL_FEATURE));

const FEATURE_KEYS: Array<keyof ManageFeatures> = ['manage_kaption', 'business_agent', 'plans', 'scheduled_status', 'channels_communities', 'export_chat'];

/** Only booleans are kept; anything else (missing, "yes", 1) is unknown, which counts as no. */
export function readManageFeatures(features: unknown): ManageFeatures {
  const out: ManageFeatures = {};
  if (!features || typeof features !== 'object') return out;
  for (const key of FEATURE_KEYS) {
    const value = (features as Record<string, unknown>)[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/**
 * mcp-manage-kaption.LIST.2 — a tool is listed while SOME connected account said its key is true. No account, an
 * account that sent no features (older extensions) or one that left the key out hides it (unlike local_send).
 */
export function visibleManageTools(accounts: Array<ManageFeatures | null | undefined>): Set<string> {
  const visible = new Set<string>();
  for (const name of MANAGE_KAPTION_TOOLS) {
    const key = MANAGE_TOOL_FEATURE[name];
    if (accounts.some(a => a?.[key] === true)) visible.add(name);
  }
  return visible;
}

/** The extension's answer as JSON: an object as is, a JSON string parsed, an MCP text result's JSON parsed. */
export function parseAnswer(data: unknown): unknown {
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return data; }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const content = (data as { content?: unknown }).content;
    if (Array.isArray(content) && Object.keys(data).every(k => k === 'content' || k === 'isError')) {
      const text = content.find((c: any) => c?.type === 'text')?.text;
      if (typeof text === 'string') return parseAnswer(text);
    }
  }
  return data;
}

/** mcp-manage-kaption.UI.2 — kaption_plans results carry the parsed answer as structuredContent. */
export function plansStructuredContent(data: unknown): Record<string, unknown> | undefined {
  const answer = parseAnswer(data);
  return answer && typeof answer === 'object' && !Array.isArray(answer) ? answer as Record<string, unknown> : undefined;
}

/**
 * Adds and removes the gated tools so the listed set is `visible`. A hidden tool is not registered at all, so a call
 * to it answers the server's usual unknown-tool error. Registering or removing a tool sends tools/list_changed.
 * Returns whether anything changed.
 */
export function syncGatedTools<T extends { remove(): void }>(
  visible: Set<string>,
  registered: Map<string, T>,
  register: (name: string) => T,
): boolean {
  let changed = false;
  for (const name of MANAGE_KAPTION_TOOLS) {
    const has = registered.has(name);
    if (visible.has(name) && !has) {
      registered.set(name, register(name));
      changed = true;
    } else if (!visible.has(name) && has) {
      registered.get(name)!.remove();
      registered.delete(name);
      changed = true;
    }
  }
  return changed;
}

export const GUIDE_URI_PREFIX = 'kaption://guide/';
const LIST_TIMEOUT_MS = 8_000;

export interface ManageResourcesHost {
  /** The gated tools listed now. */
  visible(): Set<string> | Promise<Set<string>>;
  /** Calls the extension's kaption_help with these arguments and answers its result. */
  callHelp(args: Record<string, unknown>): Promise<unknown>;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function helpAnswer(host: ManageResourcesHost, args: Record<string, unknown>, timeoutMs?: number): Promise<any> {
  const call = host.callHelp(args);
  const answer = parseAnswer(timeoutMs ? await withTimeout(call, timeoutMs) : await call);
  return answer && typeof answer === 'object' ? answer : {};
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * mcp-manage-kaption.HELP.3, PROMPTS.2, UI.1 — resources (one per guide, plus the plans UI) and prompts, answered
 * through the extension's kaption_help. Must run before the server connects (it declares the capabilities). Lists
 * answer empty when the extension can't be reached; they never fail the client.
 */
export function installManageResources(server: Server, host: ManageResourcesHost): void {
  server.registerCapabilities({ resources: { listChanged: true }, prompts: { listChanged: true } });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const visible = await host.visible();
    const resources: Array<Record<string, unknown>> = [];
    if (visible.has('kaption_help')) {
      try {
        const answer = await helpAnswer(host, { action: 'list' }, LIST_TIMEOUT_MS);
        for (const topic of Array.isArray(answer.topics) ? answer.topics : []) {
          const id = str(topic?.id);
          if (!id) continue;
          resources.push({
            uri: `${GUIDE_URI_PREFIX}${id}`,
            name: id,
            ...(str(topic.title) ? { title: topic.title } : {}),
            ...(str(topic.summary) ? { description: topic.summary } : {}),
            mimeType: 'text/markdown',
          });
        }
      } catch {
        // unreachable extension: no guides listed
      }
    }
    if (visible.has('kaption_plans')) {
      resources.push({
        uri: PLANS_UI_URI,
        name: 'plans.html',
        title: 'Kaption plans',
        description: 'Shows the answer of kaption_plans as the plans window: a period switch and one card per plan.',
        mimeType: PLANS_UI_MIME_TYPE,
      });
    }
    return { resources };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const visible = await host.visible();
    return {
      resourceTemplates: visible.has('kaption_help')
        ? [{ uriTemplate: `${GUIDE_URI_PREFIX}{id}`, name: 'guide', title: 'Kaption guide', mimeType: 'text/markdown' }]
        : [],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === PLANS_UI_URI) {
      return {
        contents: [{ uri, mimeType: PLANS_UI_MIME_TYPE, text: PLANS_UI_HTML, _meta: { ui: { prefersBorder: true } } }],
      };
    }
    if (uri.startsWith(GUIDE_URI_PREFIX) && (await host.visible()).has('kaption_help')) {
      const id = decodeURIComponent(uri.slice(GUIDE_URI_PREFIX.length));
      const answer = await helpAnswer(host, { action: 'read', topic: id });
      if (typeof answer.text !== 'string') throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
      return { contents: [{ uri, mimeType: 'text/markdown', text: answer.text }] };
    }
    throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
  });

  const prompts = async (timeoutMs?: number): Promise<Array<{ id: string; title?: string; text: string }>> => {
    const answer = await helpAnswer(host, { action: 'prompts' }, timeoutMs);
    return (Array.isArray(answer.prompts) ? answer.prompts : [])
      .filter((p: any) => str(p?.id) && typeof p.text === 'string')
      .map((p: any) => ({ id: p.id, title: str(p.title), text: p.text }));
  };

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    if (!(await host.visible()).has('kaption_help')) return { prompts: [] };
    try {
      return {
        prompts: (await prompts(LIST_TIMEOUT_MS)).map(p => ({
          name: p.id,
          ...(p.title ? { title: p.title, description: p.title } : {}),
        })),
      };
    } catch {
      return { prompts: [] };
    }
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name;
    const found = (await host.visible()).has('kaption_help')
      ? (await prompts()).find(p => p.id === name)
      : undefined;
    if (!found) throw new McpError(ErrorCode.InvalidParams, `Prompt ${name} not found`);
    return {
      ...(found.title ? { description: found.title } : {}),
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: found.text } }],
    };
  });
}

/** Tells a connected client that the resources and prompts lists changed (never throws). */
export function notifyResourcesAndPromptsChanged(server: Server): void {
  for (const send of [() => server.sendResourceListChanged(), () => server.sendPromptListChanged()]) {
    try {
      Promise.resolve(send()).catch(() => {});
    } catch {
      // not connected
    }
  }
}

/** Whether the change between two visible sets touches the resources or prompts lists. */
export function resourcesChanged(before: Set<string>, after: Set<string>): boolean {
  return ['kaption_help', 'kaption_plans'].some(name => before.has(name) !== after.has(name));
}
