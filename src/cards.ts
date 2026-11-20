/**
 * mcp-apps-cards.DATA, SEARCH, SENT, SCHEDULED — the data the Kaption cards draw (structuredContent.card), built from
 * the extension's own answers. Pure functions, no I/O. Spec: kext/features/mcp/mcp-apps-cards.feature.yaml in the
 * kaptionai repo.
 *
 * Kept identical in the local hub (kaption-mcp/src/cards.ts) and the cloud relay (kaption-mcp-remote/src/cards.ts);
 * tools-parity.test.ts compares them.
 */

/** mcp-apps-cards.SHELL.1 — the one page that draws every card. */
export const CARDS_UI_URI = 'ui://kaption/cards.html';

/** mcp-apps-cards.FLAG.1 — the flags worker row. */
export const CARDS_FLAG = 'MCP_APPS_CARDS';

/** mcp-apps-cards.FLAG.3 — the tools that link the cards page while the flag is on. */
export const CARD_TOOLS: readonly string[] = Object.freeze([
  'query',
  'send_message',
  'manage_scheduled_messages',
  'list_scheduled_messages',
  'get_scheduled_message',
]);

/** mcp-apps-cards.DATA.3 — the bounds of one card. */
export const CARD_MAX_ITEMS = 30;
export const CARD_MAX_TEXT = 280;
export const CARD_MAX_CHARS = 16_000;
/** mcp-apps-cards.SEARCH.3 — chats shown before "Show N more". */
export const SEARCH_FIRST_CHATS = 3;

/** mcp-apps-cards.FLAG.3 — what a card tool adds to its _meta while the flag is on. */
export function cardToolMeta(): Record<string, unknown> {
  // mcp-apps-cards.SHELL.6 — ChatGPT lets the card call a tool only when the tool says widgetAccessible.
  return { ui: { resourceUri: CARDS_UI_URI }, 'openai/outputTemplate': CARDS_UI_URI, 'openai/widgetAccessible': true };
}

/**
 * mcp-apps-cards.AVATAR.1-2 — get_avatars: the profile pictures of the chats a card shows, asked by the card itself
 * (batched, after it drew its initials) so the tool result stays small. Card-only: hidden from the model in Claude
 * (visibility app) and ChatGPT (openai/visibility private). The extension answers data: pictures read in the user's
 * own WhatsApp page; nothing is stored on the way.
 */
export const AVATARS_TOOL = 'get_avatars';
export const AVATARS_MAX_IDS = 8;
export const AVATARS_MAX_CHARS = 120_000;
export const AVATARS_TOOL_TITLE = 'Kaption card pictures';
export const AVATARS_TOOL_DESCRIPTION =
  'Used only by the Kaption card: the small profile pictures of the chats the card shows. Not for the assistant.';

export function avatarsToolMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: CARDS_UI_URI, visibility: ['app'] },
    'openai/widgetAccessible': true,
    'openai/visibility': 'private',
  };
}

/** mcp-apps-cards.AVATAR.2 — the ids a card asked for: strings, de-duplicated, at most AVATARS_MAX_IDS. */
export function avatarIds(args: unknown): string[] {
  const raw = args && typeof args === 'object' ? (args as Obj).ids : undefined;
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 200);
  return [...new Set(ids)].slice(0, AVATARS_MAX_IDS);
}

const PICTURE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * mcp-apps-cards.AVATAR.2-4 — the answer the card reads: `{ avatars: { [id]: dataUrl | null } }` for the ids asked.
 * Only data: JPEG/PNG/WebP pictures pass (never an address); anything else, or past the size budget, is null and the
 * card keeps its initials.
 */
export function avatarsAnswer(ids: string[], data: unknown): { avatars: Record<string, string | null> } {
  const answer = answerObject(data);
  const got = answer && answer.avatars && typeof answer.avatars === 'object' ? (answer.avatars as Obj) : {};
  const avatars: Record<string, string | null> = {};
  let total = 0;
  for (const id of ids) {
    const pic = got[id];
    if (typeof pic === 'string' && PICTURE.test(pic) && total + pic.length <= AVATARS_MAX_CHARS) {
      avatars[id] = pic;
      total += pic.length;
    } else avatars[id] = null;
  }
  return { avatars };
}

export function isCardTool(name: string): boolean {
  return CARD_TOOLS.includes(name);
}

type Obj = Record<string, any>;

export interface SearchMessage {
  from_me: boolean;
  sender: string | null;
  at: string | null;
  text: string;
}

export interface SearchGroup {
  chat_id: string | null;
  name: string;
  is_group: boolean;
  link: string | null;
  messages: SearchMessage[];
}

export interface SearchCard {
  kind: 'search';
  query: string;
  total: number;
  chats: number;
  first_chats: number;
  groups: SearchGroup[];
  omitted: number;
}

export type Delivery = 'queued' | 'sending' | 'sent' | 'not_sent';

export interface SentCard {
  kind: 'sent';
  id: string | null;
  status: Delivery;
  whatsapp: 'sent' | 'delivered' | 'read' | null;
  to: string;
  chat_id: string | null;
  is_group: boolean;
  link: string | null;
  text: string;
  attachment: string | null;
  sent_at: string | null;
  expected_at: string | null;
  reason: string | null;
  reason_text: string | null;
  can_cancel: boolean;
}

export interface ScheduledItem {
  id: string;
  mode: 'bot' | 'local' | 'other';
  name: string;
  chat_id: string | null;
  is_group: boolean;
  text: string;
  at: string | null;
  repeat: string | null;
  status: string;
  /** mcp-apps-cards.SENT.4 — a message from this computer as the sent card says it. */
  delivery: Delivery | null;
  reason_text: string | null;
  can_send_now: boolean;
  can_change: boolean;
  can_cancel: boolean;
}

export interface ScheduledCard {
  kind: 'scheduled';
  count: number;
  next_at: string | null;
  single: boolean;
  removed: string | null;
  items: ScheduledItem[];
  omitted: number;
}

export type Card = SearchCard | SentCard | ScheduledCard;

/** The extension's answer as JSON: an object as is, a JSON string parsed, an MCP text result's JSON parsed. */
export function answerObject(data: unknown): Obj | null {
  if (typeof data === 'string') {
    try {
      return answerObject(JSON.parse(data));
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const content = (data as Obj).content;
  if (Array.isArray(content) && Object.keys(data).every((k) => k === 'content' || k === 'isError')) {
    const text = content.find((c: any) => c?.type === 'text')?.text;
    return typeof text === 'string' ? answerObject(text) : null;
  }
  return data as Obj;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** mcp-apps-cards.DATA.3 — one text, cut to CARD_MAX_TEXT characters. */
export function cut(text: unknown, max = CARD_MAX_TEXT): string {
  const s = str(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const isGroupId = (id: string | null): boolean => !!id && id.endsWith('@g.us');

/** The digits of a person's chat id (…@c.us), else null. */
function phoneDigits(id: string | null): string | null {
  const m = /^(\d{6,})@c\.us$/.exec(id ?? '');
  return m ? m[1] : null;
}

/** mcp-apps-cards.SEARCH.5, SENT.6 — a one-to-one chat in WhatsApp Web; groups and hidden people have none. */
export function chatLink(id: string | null): string | null {
  const digits = phoneDigits(id);
  return digits ? `https://web.whatsapp.com/send?phone=${digits}` : null;
}

/** mcp-apps-cards.SEARCH.2 — a name for a chat id when the answer has none. */
function fallbackName(id: string | null): string {
  if (isGroupId(id)) return 'Group';
  const digits = phoneDigits(id);
  if (digits) return `+${digits}`;
  return id ? id.replace(/@.*$/, '') : 'Unknown chat';
}

const MEDIA_WORDS: Record<string, string> = {
  ptt: 'Voice note',
  audio: 'Audio',
  image: 'Photo',
  video: 'Video',
  document: 'Document',
  sticker: 'Sticker',
  location: 'Location',
  vcard: 'Contact card',
};

function messageText(m: Obj): string {
  const body = cut(m.body ?? m.caption ?? m.transcription?.text);
  if (body) return body;
  return MEDIA_WORDS[str(m.type)] ?? 'Message';
}

/** mcp-apps-cards.SEARCH.1-2, SEARCH.6 — a query answer with a messages list, else null. */
export function searchCard(args: Obj, answer: Obj | null): SearchCard | null {
  if (!answer || !Array.isArray(answer.messages)) return null;
  if (typeof args.id === 'string' && args.id) return null;
  const names = new Map<string, string>();
  for (const list of [answer.contacts, answer.conversations]) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      const id = strOrNull(row?.id);
      const name = strOrNull(row?.name);
      if (id && name) names.set(id, name);
    }
  }
  const groups = new Map<string, SearchGroup>();
  let total = 0;
  for (const m of answer.messages as Obj[]) {
    if (!m || typeof m !== 'object') continue;
    total++;
    const chatId = strOrNull(m.chatId) ?? strOrNull(m.chat_id);
    const key = chatId ?? '';
    let group = groups.get(key);
    if (!group) {
      group = {
        chat_id: chatId,
        name: (chatId && names.get(chatId)) || cut(m.chatName ?? m.chat_name, 80) || fallbackName(chatId),
        is_group: isGroupId(chatId),
        link: chatLink(chatId),
        messages: [],
      };
      groups.set(key, group);
    }
    const fromMe = m.fromMe === true || m.from_me === true;
    const from = strOrNull(m.from);
    let sender: string | null = null;
    if (fromMe) sender = 'You';
    else if (group.is_group) sender = (from && names.get(from)) || cut(m.senderName ?? m.sender_name, 80) || (from && from !== 'me' ? fallbackName(from) : null);
    group.messages.push({ from_me: fromMe, sender, at: strOrNull(m.timestamp) ?? strOrNull(m.at), text: messageText(m) });
  }
  const card: SearchCard = {
    kind: 'search',
    query: cut(args.query, 120),
    total,
    chats: groups.size,
    first_chats: SEARCH_FIRST_CHATS,
    groups: [...groups.values()],
    omitted: 0,
  };
  return boundSearch(card);
}

function boundSearch(card: SearchCard): SearchCard {
  let kept = 0;
  for (const g of card.groups) {
    const room = Math.max(0, CARD_MAX_ITEMS - kept);
    if (g.messages.length > room) {
      card.omitted += g.messages.length - room;
      g.messages = g.messages.slice(0, room);
    }
    kept += g.messages.length;
  }
  card.groups = card.groups.filter((g) => g.messages.length > 0);
  while (JSON.stringify(card).length > CARD_MAX_CHARS && card.groups.length) {
    const last = card.groups[card.groups.length - 1];
    last.messages.pop();
    card.omitted++;
    if (!last.messages.length) card.groups.pop();
  }
  return card;
}

const REASON_TEXT: Record<string, string> = {
  paused: 'Sending from this computer is paused in Kaption.',
  consent: 'Sending from this computer is turned off in Kaption.',
  'per-hour': 'Your hourly sending limit is reached, so it waits for the next free slot.',
  'per-day': 'Your daily sending limit is reached, so it waits for the next free slot.',
  'group-per-hour': 'The hourly limit for groups is reached, so it waits for the next free slot.',
  'group-per-day': 'The daily limit for groups is reached, so it waits for the next free slot.',
  'waiting-for-whatsapp': 'It goes as soon as WhatsApp on this computer can send it.',
  sending: 'Handed to WhatsApp, waiting for its tick.',
  'same-chat': 'Kaption waits a little after your last message in this chat.',
  gap: 'Kaption keeps a short gap between messages.',
  'they-wrote': 'Held: the other person wrote after it was queued, so you can decide.',
  unanswered: 'Held: your last messages in this chat are still unanswered.',
  'not-a-contact': "This person isn't in your saved contacts.",
  'flag-off': "Sending from an assistant isn't turned on for this account.",
  'computer-off': 'Missed: this computer or WhatsApp was closed at that time.',
  canceled: 'Cancelled.',
};

/** mcp-apps-cards.SENT.1 — a reason code in plain words (null when there is none). */
export function reasonText(reason: string | null): string | null {
  if (!reason) return null;
  return REASON_TEXT[reason] ?? `Waiting (${reason.replace(/-/g, ' ')}).`;
}

/** mcp-apps-cards.SENT.4 — a stored message from this computer as the sent card says it. */
export function deliveryOf(status: unknown): Delivery | null {
  switch (status) {
    case 'scheduled':
    case 'queued':
      return 'queued';
    case 'sending':
    case 'unconfirmed':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'failed':
    case 'missed':
    case 'canceled':
    case 'not_sent':
      return 'not_sent';
    default:
      return null;
  }
}

function attachmentWord(att: unknown): string | null {
  const kind = str((att as Obj | null)?.kind);
  return kind ? (MEDIA_WORDS[kind] ?? kind) : null;
}

/** mcp-apps-cards.SENT.1-2 — a send_message answer (MCP_DIRECT_SEND's or the older queued one). */
export function sentCard(args: Obj, answer: Obj | null): SentCard | null {
  if (!answer) return null;
  const item: Obj = answer.scheduled_message && typeof answer.scheduled_message === 'object' ? answer.scheduled_message : {};
  const status = deliveryOf(answer.status) ?? deliveryOf(item.status) ?? 'queued';
  const chatId = strOrNull(item.conversation_id) ?? strOrNull(args.conversation_id);
  const whatsapp = ['sent', 'delivered', 'read'].includes(answer.whatsapp_status) ? answer.whatsapp_status : status === 'sent' ? 'sent' : null;
  const reason = strOrNull(answer.failure_reason) ?? strOrNull(answer.waiting_reason) ?? strOrNull(item.failure_reason) ?? null;
  return {
    kind: 'sent',
    id: strOrNull(item.id),
    status,
    whatsapp,
    to: cut(item.chat_name, 80) || fallbackName(chatId),
    chat_id: chatId,
    is_group: item.is_group === true || isGroupId(chatId),
    link: chatLink(chatId),
    text: cut(item.message ?? args.message),
    attachment: attachmentWord(item.attachment),
    sent_at: status === 'sent' ? strOrNull(answer.sent_at) ?? strOrNull(item.sent_at) : null,
    expected_at: status === 'queued' ? strOrNull(answer.expected_at) ?? strOrNull(item.expected_at) : null,
    reason: status === 'sent' ? null : reason,
    reason_text: status === 'sent' ? null : reasonText(reason),
    can_cancel: status === 'queued' && !!strOrNull(item.id),
  };
}

/** mcp-apps-cards.SENT.3 — a refused send: the refusal's own sentence and its reason code. */
export function refusalCard(args: Obj, errorText: string): SentCard {
  const text = str(errorText).replace(/^Error:\s*/, '');
  const m = /\(reason: ([a-z0-9-]+)\)\s*$/.exec(text);
  const chatId = strOrNull(args.conversation_id);
  return {
    kind: 'sent',
    id: null,
    status: 'not_sent',
    whatsapp: null,
    to: fallbackName(chatId),
    chat_id: chatId,
    is_group: isGroupId(chatId),
    link: chatLink(chatId),
    text: cut(args.message),
    attachment: null,
    sent_at: null,
    expected_at: null,
    reason: m ? m[1] : null,
    reason_text: cut(m ? text.slice(0, m.index) : text, 600) || 'Nothing was sent.',
    can_cancel: false,
  };
}

const PENDING_LOCAL = ['scheduled', 'missed', 'failed'];

/** mcp-apps-cards.SCHEDULED.1-2 — one scheduled message of either mode. */
export function scheduledItem(m: Obj): ScheduledItem | null {
  const id = strOrNull(m?.id);
  if (!id) return null;
  if (m.mode === 'local') {
    const status = str(m.status) || 'scheduled';
    const chatId = strOrNull(m.conversation_id);
    const open = PENDING_LOCAL.includes(status);
    // Only a waiting, missed or failed message says why (an older missed_reason stays on a message sent later).
    const reason = status === 'failed' ? strOrNull(m.failure_reason) ?? strOrNull(m.missed_reason)
      : status === 'missed' ? strOrNull(m.missed_reason) ?? strOrNull(m.failure_reason)
        : status === 'scheduled' ? strOrNull(m.waiting_reason) : null;
    return {
      id,
      mode: 'local',
      name: cut(m.chat_name, 80) || fallbackName(chatId),
      chat_id: chatId,
      is_group: m.is_group === true || isGroupId(chatId),
      text: cut(m.message) || attachmentWord(m.attachment) || '',
      at: strOrNull(m.sent_at && status === 'sent' ? m.sent_at : null) ?? strOrNull(m.expected_at) ?? strOrNull(m.datetime),
      repeat: null,
      status,
      delivery: deliveryOf(status),
      reason_text: status === 'scheduled' && (!reason || ['queued', 'jitter'].includes(reason)) ? null : reasonText(reason),
      can_send_now: open,
      can_change: open,
      can_cancel: open,
    };
  }
  if (m.mode === 'bot' || m.mode === undefined) {
    const contact: Obj = m.contact && typeof m.contact === 'object' ? m.contact : {};
    const chatId = strOrNull(contact.id);
    const done = m.completed === true;
    return {
      id,
      mode: 'bot',
      name: cut(contact.name, 80) || (strOrNull(contact.phone) ? `+${String(contact.phone).replace(/^\+/, '')}` : fallbackName(chatId)),
      chat_id: chatId,
      is_group: false,
      text: cut(m.message),
      at: strOrNull(m.datetime),
      repeat: m.recurring === true ? 'Repeats' : null,
      status: done ? 'sent' : 'scheduled',
      delivery: null,
      reason_text: null,
      can_send_now: false,
      can_change: !done,
      can_cancel: !done,
    };
  }
  const chatId = strOrNull(m.conversation_id);
  return {
    id,
    mode: 'other',
    name: cut(m.chat_name, 80) || fallbackName(chatId),
    chat_id: chatId,
    is_group: isGroupId(chatId),
    text: cut(m.message),
    at: strOrNull(m.datetime),
    repeat: null,
    status: str(m.status) || 'scheduled',
    delivery: null,
    reason_text: null,
    can_send_now: false,
    can_change: false,
    can_cancel: false,
  };
}

/** mcp-apps-cards.SCHEDULED.1, SCHEDULED.5 — a list, a get, or a change's answer. */
export function scheduledCard(answer: Obj | null): ScheduledCard | null {
  if (!answer) return null;
  const removed = strOrNull(answer.deleted) ?? strOrNull(answer.removed);
  if (removed) return { kind: 'scheduled', count: 0, next_at: null, single: true, removed, items: [], omitted: 0 };
  let raw: Obj[];
  let single = false;
  if (Array.isArray(answer.scheduled_messages)) raw = answer.scheduled_messages;
  else if (answer.scheduled_message && typeof answer.scheduled_message === 'object') {
    raw = [answer.scheduled_message];
    single = true;
  } else return null;
  const items = raw.map(scheduledItem).filter((i): i is ScheduledItem => i !== null);
  if (!single) items.sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'));
  const next = items.find((i) => i.status === 'scheduled' && i.at)?.at ?? null;
  const card: ScheduledCard = { kind: 'scheduled', count: items.length, next_at: next, single, removed: null, items, omitted: 0 };
  if (card.items.length > CARD_MAX_ITEMS) {
    card.omitted = card.items.length - CARD_MAX_ITEMS;
    card.items = card.items.slice(0, CARD_MAX_ITEMS);
  }
  while (JSON.stringify(card).length > CARD_MAX_CHARS && card.items.length) {
    card.items.pop();
    card.omitted++;
  }
  return card;
}

/**
 * mcp-apps-cards.DATA.1 — the card for one card tool's successful answer, or null (no card: the host shows the page
 * with the text answer only). `args` are the arguments the AI app sent.
 */
export function cardFor(tool: string, args: Record<string, unknown> | null | undefined, data: unknown): Card | null {
  const a: Obj = args && typeof args === 'object' ? args : {};
  try {
    const answer = answerObject(data);
    switch (tool) {
      case 'query':
        return searchCard(a, answer);
      case 'send_message':
        return sentCard(a, answer);
      case 'list_scheduled_messages':
      case 'get_scheduled_message':
      case 'manage_scheduled_messages':
        return scheduledCard(answer);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** mcp-apps-cards.SENT.3 — the card for a card tool's error (only send_message has one). */
export function errorCardFor(tool: string, args: Record<string, unknown> | null | undefined, errorText: string): Card | null {
  if (tool !== 'send_message') return null;
  return refusalCard(args && typeof args === 'object' ? args : {}, errorText);
}
