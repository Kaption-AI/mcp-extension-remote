import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalOf, clearLiveGuideCache, withLiveGuide } from './live-guide';

const STALE = {
  id: 'pricing',
  title: 'Kaption AI pricing',
  text: '# Kaption AI pricing\n\nCanonical: https://kaptionai.com/pricing/ · Also at: https://kaptionai.com/pricing.md\n\n| MCP tool calls | 20 a week | 100 a week |',
};
const LIVE =
  '---\ntitle: "Kaption AI pricing"\ncanonical: "https://kaptionai.com/pricing/"\n---\n\n# Kaption AI pricing\n\nCanonical: https://kaptionai.com/pricing/ · Also at: https://kaptionai.com/pricing.md\n\n- Claude and ChatGPT: 250 credits a month + usage\n';

const page = (body: string, status = 200, type = 'text/markdown; charset=utf-8') =>
  vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } }));

describe('mcp-manage-kaption.HELP.5 kaption_help read answers the live page', () => {
  beforeEach(() => clearLiveGuideCache());

  it('mcp-manage-kaption.HELP.5 swaps the text for the Markdown twin of the Canonical URL, without front matter', async () => {
    const fetchImpl = page(LIVE);
    const out = await withLiveGuide({ action: 'read', topic: 'pricing' }, STALE, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('https://kaptionai.com/pricing/', expect.objectContaining({ headers: { Accept: 'text/markdown' } }));
    expect(out.id).toBe('pricing');
    expect(out.text.startsWith('# Kaption AI pricing')).toBe(true);
    expect(out.text).toContain('250 credits a month');
    expect(out.text).not.toContain('100 a week');
    expect(out.text).not.toContain('title:');
  });

  it('mcp-manage-kaption.HELP.5 keeps the page up to 10 minutes', async () => {
    const fetchImpl = page(LIVE);
    await withLiveGuide({ action: 'read' }, STALE, fetchImpl, 0);
    await withLiveGuide({ action: 'read' }, STALE, fetchImpl, 9 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await withLiveGuide({ action: 'read' }, STALE, fetchImpl, 11 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('mcp-manage-kaption.HELP.5 a JSON string answer stays a JSON string', async () => {
    const out = await withLiveGuide({ action: 'read' }, JSON.stringify(STALE), page(LIVE));
    expect(JSON.parse(out).text).toContain('250 credits a month');
  });

  it('mcp-manage-kaption.HELP.5 keeps the extension answer when the page fails, is not Markdown, or differs', async () => {
    for (const fetchImpl of [
      page('nope', 404),
      page('<html></html>', 200, 'text/html'),
      page(LIVE.replace(/pricing\/ ·/g, 'mcp/ ·')),
      page(`${LIVE}\nUses Whisper.`),
      page(`${LIVE}\nFlag PLANS_2027 on.`),
      vi.fn(async () => { throw new Error('offline'); }),
    ]) {
      clearLiveGuideCache();
      expect(await withLiveGuide({ action: 'read' }, STALE, fetchImpl as any)).toBe(STALE);
    }
  });

  it('mcp-manage-kaption.HELP.5 list, prompts and guides without a kaptionai.com Canonical line are untouched', async () => {
    const fetchImpl = page(LIVE);
    const list = { count: 1, topics: [] };
    expect(await withLiveGuide({ action: 'list' }, list, fetchImpl)).toBe(list);
    const answers = { id: 'assistant-answers', title: 'Answers', text: '# Answers\n\nNo canonical.' };
    expect(await withLiveGuide({ action: 'read' }, answers, fetchImpl)).toBe(answers);
    const elsewhere = { ...STALE, text: 'Canonical: https://example.com/pricing/' };
    expect(await withLiveGuide({ action: 'read' }, elsewhere, fetchImpl)).toBe(elsewhere);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(canonicalOf(STALE.text)).toBe('https://kaptionai.com/pricing/');
  });
});
