/**
 * mcp-manage-kaption.HELP.5 — kaption_help "read" answers the guide's live page on kaptionai.com instead of the copy
 * built into the extension, so plan numbers and limits are the site's of today, not those of the installed version.
 * Spec: kext/features/mcp/mcp-manage-kaption.feature.yaml in the kaptionai repo.
 *
 * Kept in step with the local hub's src/liveGuide.ts (kaption-mcp).
 */

const SITE = 'https://kaptionai.com';
const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 3_000;
const MAX_ENTRIES = 100;

/** mcp-manage-kaption.LIST.4 — what no guide may say (kext/scripts/generate-assistant-guides.mjs FORBIDDEN). */
const FORBIDDEN: RegExp[] = [
  /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/,
  /owner-only|Rust core|Rust extension/i,
  /\b(?:Parakeet|Muse|Whisper|Hy-?MT\d?|Qwen|DeepSeek|Gemma|Llama|Mistral|Silero|GPT-?\d|gpt-4o|o\d-mini|Sonnet|Opus|Haiku|Gemini|Cerebras|Fireworks|DeepInfra)\b/i,
];

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const cache = new Map<string, { at: number; text: string | null }>();

/** The kaptionai.com URL on a guide's "Canonical:" line, or null. */
export function canonicalOf(text: string): string | null {
  const url = text.match(/^Canonical: (\S+)/m)?.[1];
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.origin === SITE ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The live page's text without its YAML front matter, or null when it can't stand in for the guide. */
export function usablePage(body: string, canonical: string): string | null {
  const text = body.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  if (!/^# .+/m.test(text)) return null;
  if (canonicalOf(text) !== canonical) return null;
  if (FORBIDDEN.some(re => re.test(text))) return null;
  return text;
}

async function fetchPage(canonical: string, fetchImpl: Fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(canonical, { headers: { Accept: 'text/markdown' }, signal: controller.signal });
    if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('text/markdown')) return null;
    return usablePage(await res.text(), canonical);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * mcp-manage-kaption.HELP.5 — a kaption_help answer with a guide's text swapped for its live page. Anything that is not
 * a read answer, or any failure, answers the extension's answer unchanged; it never throws.
 */
export async function withLiveGuide<T>(args: unknown, answer: T, fetchImpl: Fetch = fetch, now = Date.now()): Promise<T> {
  try {
    if ((args as any)?.action !== 'read') return answer;
    const parsed: any = typeof answer === 'string' ? JSON.parse(answer) : answer;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.text !== 'string') return answer;
    const canonical = canonicalOf(parsed.text);
    if (!canonical) return answer;
    let entry = cache.get(canonical);
    if (!entry || now - entry.at > TTL_MS) {
      entry = { at: now, text: await fetchPage(canonical, fetchImpl) };
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(canonical, entry);
    }
    if (!entry.text) return answer;
    const title = entry.text.match(/^# (.+)$/m)?.[1]?.trim() ?? parsed.title;
    const live = { ...parsed, title, text: entry.text };
    return (typeof answer === 'string' ? JSON.stringify(live) : live) as T;
  } catch {
    return answer;
  }
}

/** Tests only. */
export function clearLiveGuideCache(): void {
  cache.clear();
}
