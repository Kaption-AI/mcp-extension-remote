// mcp-apps-cards.DATA, SEARCH, SENT, SCHEDULED — the cards' data built from the extension's answers. The same tests run
// in the local hub (kaption-mcp/src/__tests__/cards.test.ts) on the same fixture.
import { describe, expect, it } from 'vitest';
import {
  CARD_MAX_CHARS,
  CARD_MAX_ITEMS,
  CARD_TOOLS,
  CARDS_UI_URI,
  cardFor,
  cardToolMeta,
  avatarIds,
  avatarsAnswer,
  avatarsToolMeta,
  AVATARS_MAX_CHARS,
  AVATARS_MAX_IDS,
  chatLink,
  deliveryOf,
  errorCardFor,
  reasonText,
  type ScheduledCard,
  type SearchCard,
  type SentCard,
} from './cards';
import answers from './test-support/mcp-apps-cards-answers.json';

const A: any = answers;

describe('mcp-apps-cards.FLAG.3 card tools', () => {
  it('link the one cards page (MCP Apps and ChatGPT)', () => {
    expect(CARD_TOOLS).toEqual(['query', 'send_message', 'manage_scheduled_messages', 'list_scheduled_messages', 'get_scheduled_message']);
    expect(cardToolMeta()).toEqual({ ui: { resourceUri: 'ui://kaption/cards.html' }, 'openai/outputTemplate': 'ui://kaption/cards.html', 'openai/widgetAccessible': true });
    expect(CARDS_UI_URI).toBe('ui://kaption/cards.html');
  });

  it('mcp-apps-cards.DATA.1 — other tools get no card', () => {
    expect(cardFor('list_contacts', {}, { contacts: [] })).toBeNull();
    expect(errorCardFor('query', {}, 'Error: x')).toBeNull();
  });
});

describe('mcp-apps-cards.SEARCH', () => {
  const card = cardFor('query', { query: 'delivery' }, A.search) as SearchCard;

  it('mcp-apps-cards.SEARCH.1 — groups the messages by chat in the answer\'s order with counts', () => {
    expect(card.kind).toBe('search');
    expect(card.query).toBe('delivery');
    expect(card.total).toBe(5);
    expect(card.chats).toBe(4);
    expect(card.first_chats).toBe(3);
    expect(card.groups.map((g) => g.name)).toEqual(['Marina Costa', 'Equipe Vendas SP', '+5511933334444', '+5511955556666']);
    expect(card.groups[0].messages).toEqual([
      { from_me: false, sender: null, at: '2026-11-19T17:02:00.000Z', text: 'The delivery is confirmed for Friday morning, before 11.' },
      { from_me: true, sender: 'You', at: '2026-11-19T17:05:00.000Z', text: 'Great, can you send the delivery address again?' },
    ]);
    expect(card.omitted).toBe(0);
  });

  it('mcp-apps-cards.SEARCH.2 — names from the answer, Group or the phone otherwise; group senders by name', () => {
    expect(card.groups[1]).toMatchObject({ is_group: true, link: null, chat_id: '120363000000000001@g.us' });
    expect(card.groups[1].messages[0].sender).toBe('Rafael Lima');
    const bare = cardFor('query', { query: 'x', entity: 'messages' }, { messages: [A.search.messages[2]] }) as SearchCard;
    expect(bare.groups[0].name).toBe('Group');
    expect(bare.groups[0].messages[0].sender).toBe('+5511911112222');
  });

  it('mcp-apps-cards.SEARCH.5 — a one-to-one chat links to WhatsApp Web; a voice note without text says so', () => {
    expect(card.groups[0].link).toBe('https://web.whatsapp.com/send?phone=5511987654821');
    expect(chatLink('120363000000000001@g.us')).toBeNull();
    expect(chatLink('99999@lid')).toBeNull();
    expect(card.groups[3].messages[0].text).toBe('Voice note');
  });

  it('mcp-apps-cards.SEARCH.6 — no messages list, or a lookup by id: no card', () => {
    expect(cardFor('query', {}, { conversations: [] })).toBeNull();
    expect(cardFor('query', { id: '5511987654821@c.us', query: 'x' }, { messages: [] })).toBeNull();
    expect(cardFor('query', { entity: 'session' }, { session: { connected: true } })).toBeNull();
    expect(cardFor('query', { query: 'x' }, 'not json')).toBeNull();
  });

  it('reads the answer as JSON text or as an MCP text result too', () => {
    expect(cardFor('query', { query: 'delivery' }, JSON.stringify(A.search))).toEqual(card);
    expect(cardFor('query', { query: 'delivery' }, { content: [{ type: 'text', text: JSON.stringify(A.search) }] })).toEqual(card);
  });

  it('mcp-apps-cards.DATA.3 — at most 30 messages, texts cut to 280 characters, the card within 16 000 characters', () => {
    const long = 'delivery '.repeat(80);
    const messages = Array.from({ length: 120 }, (_, i) => ({ chatId: `55119${String(i % 40).padStart(8, '0')}@c.us`, fromMe: false, timestamp: '2026-11-19T17:02:00.000Z', type: 'chat', body: long }));
    const big = cardFor('query', { query: 'delivery' }, { messages }) as SearchCard;
    const kept = big.groups.reduce((n, g) => n + g.messages.length, 0);
    expect(kept).toBeLessThanOrEqual(CARD_MAX_ITEMS);
    expect(big.total).toBe(120);
    expect(big.omitted).toBe(120 - kept);
    expect(big.groups[0].messages[0].text.length).toBeLessThanOrEqual(280);
    expect(big.groups[0].messages[0].text.endsWith('…')).toBe(true);
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(CARD_MAX_CHARS);
  });
});

describe('mcp-apps-cards.SENT', () => {
  it('mcp-apps-cards.SENT.1-2 — a direct send that went out and was read', () => {
    const card = cardFor('send_message', { conversation_id: '5511987654821@c.us', message: 'x' }, A.sent_read) as SentCard;
    expect(card).toEqual({
      kind: 'sent', id: 'loc_1', status: 'sent', whatsapp: 'read', to: 'Marina Costa', chat_id: '5511987654821@c.us', is_group: false,
      link: 'https://web.whatsapp.com/send?phone=5511987654821', text: 'Oi Marina! The delivery is confirmed for Friday before 11.', attachment: null,
      sent_at: '2026-11-19T17:06:12.000Z', expected_at: null, reason: null, reason_text: null, can_cancel: false,
    });
  });

  it('mcp-apps-cards.SENT.1, SENT.5 — queued by a limit: when, why in plain words, and it can be cancelled', () => {
    const card = cardFor('send_message', {}, A.sent_queued) as SentCard;
    expect(card).toMatchObject({ status: 'queued', whatsapp: null, sent_at: null, expected_at: '2026-11-19T17:32:00.000Z', reason: 'per-hour', can_cancel: true });
    expect(card.reason_text).toBe('Your hourly sending limit is reached, so it waits for the next free slot.');
  });

  it('mcp-apps-cards.SENT.2 — handed to WhatsApp but not confirmed is sending, never sent', () => {
    const card = cardFor('send_message', {}, A.sent_sending) as SentCard;
    expect(card).toMatchObject({ status: 'sending', whatsapp: null, is_group: true, link: null, can_cancel: false });
  });

  it('mcp-apps-cards.SENT.1 — held back: not sent with the reason', () => {
    const card = cardFor('send_message', {}, A.sent_failed) as SentCard;
    expect(card).toMatchObject({ status: 'not_sent', reason: 'they-wrote', can_cancel: false });
    expect(card.reason_text).toMatch(/other person wrote/);
  });

  it('mcp-apps-cards.SENT.1 — the older queued answer (MCP_DIRECT_SEND off)', () => {
    const card = cardFor('send_message', {}, A.sent_legacy_queued) as SentCard;
    expect(card).toMatchObject({ status: 'queued', expected_at: '2026-11-19T17:12:00.000Z', reason: null, reason_text: null, can_cancel: true });
  });

  it('mcp-apps-cards.SENT.3 — a refusal: not sent, its own sentence without the code, and the reason', () => {
    const card = errorCardFor('send_message', { conversation_id: '5511987654821@c.us', message: 'Hello there' }, A.refusal_text) as SentCard;
    expect(card).toMatchObject({ kind: 'sent', status: 'not_sent', reason: 'not-a-contact', text: 'Hello there', to: '+5511987654821', can_cancel: false });
    expect(card.reason_text!.startsWith("Nothing was sent. This person isn't in the user's saved contacts")).toBe(true);
    expect(card.reason_text).not.toMatch(/reason:/);
    expect((errorCardFor('send_message', {}, 'Error: boom') as SentCard).reason_text).toBe('boom');
  });

  it('mcp-apps-cards.SENT.4 — stored statuses as the sent card says them', () => {
    expect(['scheduled', 'unconfirmed', 'sending', 'sent', 'failed', 'missed', 'canceled', 'weird'].map(deliveryOf))
      .toEqual(['queued', 'sending', 'sending', 'sent', 'not_sent', 'not_sent', 'not_sent', null]);
    expect(reasonText(null)).toBeNull();
    expect(reasonText('some-new-reason')).toBe('Waiting (some new reason).');
  });
});

describe('mcp-apps-cards.SCHEDULED', () => {
  const card = cardFor('list_scheduled_messages', {}, A.scheduled_list) as ScheduledCard;

  it('mcp-apps-cards.SCHEDULED.1 — both modes, soonest first, the next time', () => {
    expect(card).toMatchObject({ kind: 'scheduled', count: 4, single: false, removed: null, omitted: 0 });
    expect(card.items.map((i) => i.id)).toEqual(['loc_11', 'loc_10', 'bot_1', 'bot_2']);
    expect(card.next_at).toBe('2026-11-20T12:00:00.000Z');
    expect(card.items.find((i) => i.id === 'bot_2')).toMatchObject({ mode: 'bot', name: 'Lucas Almeida', repeat: 'Repeats', chat_id: '5511933334444@c.us' });
  });

  it('mcp-apps-cards.SCHEDULED.2-4 — what each message allows', () => {
    const by = (id: string) => card.items.find((i) => i.id === id)!;
    expect(by('loc_10')).toMatchObject({ mode: 'local', can_send_now: true, can_change: true, can_cancel: true, delivery: 'queued', reason_text: null });
    expect(by('loc_11')).toMatchObject({ is_group: true, status: 'missed', can_send_now: true, reason_text: 'Missed: this computer or WhatsApp was closed at that time.' });
    expect(by('bot_1')).toMatchObject({ mode: 'bot', can_send_now: false, can_change: true, can_cancel: true, delivery: null });
  });

  it('mcp-apps-cards.SCHEDULED.5 — a get or a change answers one message; finished ones allow nothing', () => {
    const got = cardFor('get_scheduled_message', { id: 'loc_10', mode: 'local' }, A.scheduled_get) as ScheduledCard;
    expect(got).toMatchObject({ single: true, count: 1 });
    expect(got.items[0]).toMatchObject({ status: 'sent', delivery: 'sent', at: '2026-11-20T12:00:40.000Z', can_send_now: false, can_change: false, can_cancel: false });
    const cancelled = cardFor('manage_scheduled_messages', { action: 'cancel', mode: 'local', id: 'loc_10' }, A.scheduled_cancelled) as ScheduledCard;
    expect(cancelled.items[0]).toMatchObject({ status: 'canceled', delivery: 'not_sent', can_cancel: false });
    expect(cardFor('manage_scheduled_messages', { action: 'delete', id: 'bot_1' }, A.scheduled_deleted)).toEqual({
      kind: 'scheduled', count: 0, next_at: null, single: true, removed: 'bot_1', items: [], omitted: 0,
    });
  });

  it('mcp-apps-cards.SCHEDULED.5 — a missed message sent later no longer says why it was missed', () => {
    const later = cardFor('get_scheduled_message', {}, { scheduled_message: { ...A.scheduled_list.scheduled_messages[3], status: 'sending' } }) as ScheduledCard;
    expect(later.items[0]).toMatchObject({ status: 'sending', delivery: 'sending', reason_text: null, can_send_now: false });
  });

  it('WhatsApp\'s own scheduled messages are shown without buttons', () => {
    const wa = cardFor('list_scheduled_messages', { mode: 'whatsapp' }, { scheduled_messages: [{ id: 'wa_1', mode: 'whatsapp', message: 'x', datetime: '2026-11-20T12:00:00.000Z' }] }) as ScheduledCard;
    expect(wa.items[0]).toMatchObject({ mode: 'other', can_send_now: false, can_change: false, can_cancel: false });
  });

  it('mcp-apps-cards.DATA.3 — at most 30 items', () => {
    const many = { scheduled_messages: Array.from({ length: 45 }, (_, i) => ({ ...A.scheduled_list.scheduled_messages[0], id: `bot_${i}` })) };
    const big = cardFor('list_scheduled_messages', {}, many) as ScheduledCard;
    expect(big.items).toHaveLength(30);
    expect(big.omitted).toBe(15);
    expect(big.count).toBe(45);
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(CARD_MAX_CHARS);
  });

  it('an answer that is not a list or a message: no card', () => {
    expect(cardFor('manage_scheduled_messages', { action: 'create' }, { success: false })).toBeNull();
  });
});

describe('mcp-apps-cards.AVATAR get_avatars data', () => {
  const PIC = 'data:image/webp;base64,UklGRg==';
  it('AVATAR.1 — card-only tool meta', () => {
    expect(avatarsToolMeta()).toEqual({ ui: { resourceUri: CARDS_UI_URI, visibility: ['app'] }, 'openai/widgetAccessible': true, 'openai/visibility': 'private' });
  });
  it('AVATAR.2 — ids: strings only, de-duplicated, at most 8', () => {
    const ids = [...Array(12)].map((_, i) => `55510${i}@c.us`);
    expect(avatarIds({ ids: [...ids, ids[0], 4, null, ''] })).toHaveLength(AVATARS_MAX_IDS);
    expect(avatarIds({ ids: ['a', 'a', 'b'] })).toEqual(['a', 'b']);
    expect(avatarIds(null)).toEqual([]);
    expect(avatarIds({ ids: 'a' })).toEqual([]);
  });
  it('AVATAR.2-4 — only data: JPEG/PNG/WebP pass, for the ids asked; addresses and junk are null', () => {
    const answer = { avatars: { a: PIC, b: 'https://pps.whatsapp.net/v/x.jpg', c: 'data:image/svg+xml;base64,PHN2Zz4=', d: null, extra: PIC } };
    expect(avatarsAnswer(['a', 'b', 'c', 'd', 'e'], answer)).toEqual({ avatars: { a: PIC, b: null, c: null, d: null, e: null } });
    expect(avatarsAnswer(['a'], JSON.stringify(answer)).avatars.a).toBe(PIC);
    expect(avatarsAnswer(['a'], null)).toEqual({ avatars: { a: null } });
  });
  it('AVATAR.2 — the answer stays under the size budget', () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(40_000);
    const ids = [...Array(8)].map((_, i) => `id${i}`);
    const out = avatarsAnswer(ids, { avatars: Object.fromEntries(ids.map((id) => [id, big])) });
    const total = Object.values(out.avatars).reduce((n, v) => n + (v ? v.length : 0), 0);
    expect(total).toBeLessThanOrEqual(AVATARS_MAX_CHARS);
    expect(Object.values(out.avatars).filter(Boolean)).toHaveLength(2);
  });
});
