/**
 * Tool definitions for the MCP bridge (shared between local extension and cloud relay).
 * This is the canonical source of truth — copied from kaption-mcp/src/tools.ts.
 * The relay doesn't execute them — it forwards JSON-RPC to the extension.
 */

import { z } from "zod";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodType;
  annotations?: ToolAnnotations;
  /** MCP Apps / ChatGPT Apps metadata (mcp-manage-kaption.UI.1: kaption_plans links its UI resource). */
  _meta?: Record<string, unknown>;
}

/** mcp-manage-kaption.UI.1 — the plans UI resource kaption_plans links (MCP Apps and ChatGPT's outputTemplate). */
export const PLANS_UI_URI = "ui://kaption/plans.html";

/** Stable structured-output envelope used by every public cloud tool. */
export const PUBLIC_TOOL_OUTPUT_SCHEMA = z.object({
  result: z.unknown().describe("The JSON-compatible result returned by the Kaption extension"),
});

/**
 * mcp-manage-kaption.UI.2 — kaption_plans answers the extension's JSON itself as structuredContent (the plans page and
 * ChatGPT's output template read it there): any object.
 */
export const PLANS_TOOL_OUTPUT_SCHEMA = z.object({}).passthrough().describe("The plans answer of the Kaption extension");

// mcp-local-send.MEDIA.1 — 8 MiB decoded fits the relay's 16 MiB frame ceiling.
// mcp-local-send.REFERENCES.1 — strict alternatives preserve source exclusivity.
const attachmentName = z.string().min(1).max(200).regex(/^[^\\/\x00-\x1f\x7f]+$/);
const attachmentMime = z.string().min(3).max(200);
const localAttachmentSchema = z.union([
  z.object({
  name: z.string().min(1).max(200).regex(/^[^\\/\x00-\x1f\x7f]+$/).describe('Filename without a path'),
  mime: z.string().min(3).max(200).describe('MIME type, e.g. image/png, application/pdf, audio/ogg, video/mp4'),
  size: z.number().int().min(1).max(8388608).describe('Decoded byte count (maximum 8 MiB)'),
  dataB64: z.string().min(4).max(11184812).regex(/^[A-Za-z0-9+/]*={0,2}$/).describe('Standard padded base64 bytes, without a data URL prefix'),
}).strict(),
  z.object({ ref: z.string().regex(/^[a-f0-9]{64}$/).describe('One-time attachmentRef returned by create_attachment_upload after PUT of the bytes') }).strict(),
]).describe('Exactly one attachment source: dataB64 or uploaded ref (paths are never accepted); max 8 MiB. Only when sending from this computer is turned on for the account');

export const TOOLS: ToolDefinition[] = [
  {
    name: "query",
    description: [
      "Query WhatsApp data: conversations, contacts, messages, transcriptions, labels, and communities.",
      "Supports listing, searching, filtering, and looking up by ID.",
      "",
      "Several WhatsApp accounts may be connected (e.g. personal + business), each with its own conversations, contacts and messages.",
      'entity="session" lists the connected accounts and their session IDs; target_session routes a query to one of them.',
      "",
      "Reading messages:",
      '  Passing a conversation id (e.g. "5491157390064@c.us") returns the conversation with its messages; limit sets how many.',
      '  entity="messages" is a global text search across conversations.',
      "",
      "Audio transcriptions:",
      '  entity="transcriptions" (with an optional query) returns voice-note transcriptions; messages read by conversation id include the transcription text of audio messages.',
      "",
      "Examples:",
      '  List sessions: { entity: "session" }',
      "  List conversations: {}",
      '  Target specific account: { entity: "conversations", target_session: "sess_abc123" }',
      '  Read messages: { id: "5491157390064@c.us" }',
      '  Read last 100 msgs: { id: "5491157390064@c.us", limit: 100 }',
      '  Search globally: { query: "meeting" }',
      '  Search in chat: { id: "5491157390064@c.us", query: "meeting" }',
      "  Unread conversations: { unread: true }",
      '  Search contacts: { query: "Alice", entity: "contacts" }',
      '  List labels: { entity: "labels" }',
      '  Filter by label: { label: "Important", entity: "conversations" }',
      '  List communities: { entity: "communities" }',
      '  Filter by community: { community: "My Community", entity: "conversations" }',
      '  Find which groups a contact is in: { id: "5491157390064@c.us", entity: "contacts", include_participants: true }',
      '  List members of a group: { entity: "contacts", group: "120363421729019499@g.us" }',
    ].join("\n"),
    inputSchema: z.object({
      query: z.string().optional().describe("Text to search for (names, messages, transcriptions)"),
      id: z.string().optional().describe("Look up a specific conversation, contact, or label by ID"),
      entity: z
        .enum(["conversations", "contacts", "messages", "transcriptions", "labels", "communities", "session"])
        .optional()
        .describe(
          'Entity type to query. Defaults to "conversations" when listing, or all when searching. Use "session" to list all connected WhatsApp accounts.'
        ),
      limit: z.number().min(1).max(5000).optional().default(25).describe("Max results (default 25, max 5000)"),
      unread: z.boolean().optional().describe("Only return conversations with unread messages"),
      label: z.string().optional().describe("Filter conversations by label name or ID (Business accounts)"),
      list: z.string().optional().describe("Filter conversations by list name or ID (Personal accounts)"),
      community: z.string().optional().describe("Filter conversations by community name or ID"),
      group: z.string().optional().describe("Filter contacts by group ID — only return contacts that are members of this group"),
      exclude_archived: z.boolean().optional().describe("Exclude archived conversations from listings (default true)"),
      exclude_muted: z.boolean().optional().describe("Exclude muted conversations from listings (default false)"),
      before: z.string().optional().describe('Return messages before this ISO 8601 datetime (e.g. "2026-03-01T12:00:00.000Z") for cursor-based pagination backward'),
      after: z.string().optional().describe('Return messages after this ISO 8601 datetime (e.g. "2026-03-01T12:00:00.000Z") for incremental sync'),
      include_participants: z.boolean().optional().describe("Include group participants in results. Useful when looking up a contact by ID to see which groups they belong to, or when querying a group to see its members."),
      target_session: z.string().optional().describe('Session ID to target a specific WhatsApp account. Get session IDs from entity="session". If omitted, routes to the most recently active account.'),
    }),
  },
  {
    name: "summarize_conversation",
    description: "Get or generate a summary of a conversation",
    inputSchema: z.object({
      conversation_id: z.string().describe("The conversation ID"),
      message_count: z.number().min(1).max(500).optional().describe("Number of messages to use for summary generation (default 50, max 500)"),
      target_session: z.string().optional().describe("Session ID to target a specific WhatsApp account"),
    }),
  },
  {
    name: "manage_labels",
    description: [
      "Manage WhatsApp Business labels. Requires a WhatsApp Business account.",
      "",
      "Actions:",
      "  add    - Add a label to a conversation (requires label_name/label_id + conversation_id)",
      "  remove - Remove a label from a conversation (requires label_name/label_id + conversation_id)",
      "  create - Create a new label (requires label_name)",
      "  delete - Delete a label (requires label_name or label_id)",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["add", "remove", "create", "delete"]).describe("Label action to perform"),
      label_name: z.string().optional().describe("Label name (for add/remove/create/delete)"),
      label_id: z.string().optional().describe("Label ID (alternative to label_name for add/remove/delete)"),
      conversation_id: z.union([z.string(), z.array(z.string())]).optional().describe("Conversation ID or array of IDs (required for add/remove)"),
    }),
  },
  {
    name: "manage_notes",
    description: [
      "Write or replace the note for a contact. Requires a WhatsApp Business account with notes enabled.",
      "Reading a note is get_contact_note.",
      "",
      "Actions:",
      "  set - Write/update the note for a contact",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["set"]).describe("Note action to perform"),
      contact_id: z.string().describe("The contact ID"),
      note: z.string().describe("Note text that replaces the contact's current note"),
    }),
  },
  {
    name: "download_media",
    description: [
      "Download media content (image, video, audio, document, sticker) from a WhatsApp message.",
      "Returns base64-encoded media data with metadata.",
      "",
      "Get message_id from query results. The message must be a media message.",
      "",
      "Examples:",
      '  Download an image: { message_id: "true_123@c.us_3EB0...", conversation_id: "123@c.us" }',
    ].join("\n"),
    inputSchema: z.object({
      message_id: z.string().describe("The message ID (from query results)"),
      conversation_id: z.string().describe("The conversation ID containing the message"),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "manage_chat",
    description: [
      "Manage chat state: archive, unarchive, mark as read/unread, pin, unpin, mute, unmute, set/clear draft.",
      "",
      "Actions:",
      "  archive     - Archive a conversation",
      "  unarchive   - Unarchive a conversation",
      "  mark_read   - Mark a conversation as read",
      "  mark_unread - Mark a conversation as unread",
      "  pin         - Pin a conversation (max 3 pinned)",
      "  unpin       - Unpin a conversation",
      "  mute        - Mute notifications (use mute_duration for duration)",
      "  unmute      - Unmute notifications",
      "  set_draft   - Set a draft message in the compose box (requires text)",
      "  clear_draft - Clear the draft message",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["archive", "unarchive", "mark_read", "mark_unread", "pin", "unpin", "mute", "unmute", "set_draft", "clear_draft"]).describe("Chat action to perform"),
      conversation_id: z.string().describe("The conversation ID"),
      mute_duration: z.enum(["8h", "1w", "forever"]).optional().describe('Mute duration (only for "mute" action). Default: "forever"'),
      text: z.string().optional().describe('Draft text (required for "set_draft" action)'),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "manage_reminders",
    description: [
      "Create, change, complete or delete personal reminders. Reminders are stored in the cloud and trigger notifications via the Kaption extension.",
      "Reading reminders is list_reminders and get_reminder.",
      "",
      "Actions:",
      "  create     - Create a new reminder (requires title + datetime)",
      "  update     - Update a reminder (requires id, optional title/datetime)",
      "  delete     - Delete a reminder (requires id)",
      "  complete   - Mark a reminder as completed (requires id)",
      "  uncomplete - Mark a reminder as not completed (requires id)",
      "",
      "Examples:",
      '  Create: { action: "create", title: "Follow up with client", datetime: "2026-03-07T14:00:00Z" }',
      '  Complete: { action: "complete", id: "rem_abc123" }',
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["create", "update", "delete", "complete", "uncomplete"]).describe("Reminder action to perform"),
      id: z.string().optional().describe("Reminder ID (required for update/delete/complete/uncomplete)"),
      title: z.string().optional().describe("Reminder text (required for create, optional for update)"),
      datetime: z.string().optional().describe("ISO 8601 datetime for the reminder (required for create, optional for update)"),
      notification_type: z.enum(["extension", "whatsapp", "automatic"]).optional().describe('How to notify. Default: "automatic"'),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: 'create_attachment_upload',
    description: 'Create a one-time attachment upload slot, authorized by your connected Kaption account (attachments from an assistant must be turned on for it). Returns uploadUrl, attachmentRef and expiresAt. PUT the raw file bytes to uploadUrl within 15 minutes (e.g. curl -T file.pdf), then pass attachment: {ref: attachmentRef} to send_message or a local schedule create/update within one hour. The extension consumes the ref once and stores the bytes locally. No third-party URLs. Needs a newer Kaption version; target_session selects the account.',
    inputSchema: z.object({
      name: attachmentName.describe('Filename without paths or control characters, max 200 characters'),
      mime: attachmentMime.describe('Allowed image, document, audio or video MIME type'),
      size: z.number().int().min(1).max(8388608).describe('Exact file size in bytes, maximum 8 MiB'),
      target_session: z.string().optional().describe('Session ID of the Kaption account that will send the attachment'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'send_message',
    description: 'Queue a WhatsApp message from this computer for the earliest permitted delivery. Needs a newer Kaption version, sending from this computer turned on for the account, and the user\'s consent in Kaption. Supports an existing person chat or eligible group (@g.us) and one image, document, audio or video attachment (8 MiB max). Message is optional with an attachment; audio cannot have captions. Returns queued plus a schedule ID, not proof of delivery. Existing ask-first prompts, 8/hour, 20/day, group limits and delays apply. An assistant cannot accept consent or confirmation. Computer and WhatsApp must remain open. The returned ID can be read with get_scheduled_message (mode local) and cancelled with manage_scheduled_messages (mode local).',
    inputSchema: z.object({
      conversation_id: z.string().min(1).describe('Existing person chat ID or eligible group ID ending @g.us'),
      message: z.string().max(2000).optional().describe('Message or attachment caption; omit for attachment-only sends'),
      attachment: localAttachmentSchema.optional(),
      target_session: z.string().optional().describe('Session ID for multi-account routing'),
    }),
  },
  {
    name: "manage_scheduled_messages",
    description: [
      "Schedule, change or cancel WhatsApp messages sent automatically at a specific time, in one of two modes:",
      "  bot (default) - sent from Kaption's WhatsApp number, not the user's own. Stored in Kaption's cloud and sent even when this computer is off. One-to-one chats only (no groups); one line, max 800 characters.",
      '  local ("From this computer") - sent from the user\'s own WhatsApp number, as them, while this computer and WhatsApp are open. Stays on this device. Kaption keeps it within safe limits automatically (a few messages an hour and a day, minutes apart, only to chats where the other person has written, at most 3 a day to groups) and refuses what does not fit. The only mode that can send to groups (ones the user can post in and posted in within 30 days). Supports one image, document, audio or video attachment (8 MiB max), when attachments from an assistant are turned on for the account and Kaption is up to date; audio captions are refused. A message whose time passes while this computer is off is missed, never sent late on its own.',
      'The local mode must first be turned on by the user in Kaption (its "From this computer" option, after reading the risks); an assistant cannot turn it on. A refused local request says why and ends with a reason code, e.g. "(reason: per-day)".',
      "",
      "Reading scheduled messages is list_scheduled_messages and get_scheduled_message.",
      "",
      "Actions:",
      "  create   - Schedule a new message (requires message + datetime + conversation_id)",
      "  update   - Change the message and/or datetime (requires id)",
      "  delete   - Cancel/delete a scheduled message (requires id); in local mode it cancels a waiting message and removes a finished one",
      "  cancel   - Local mode only: cancel a waiting, missed or failed message",
      "  remove   - Local mode only: remove a finished message from the list",
      "  send_now - Local mode only: send a missed or failed message now (still within the limits)",
      'Pass mode "local" for every action on a local message.',
      "",
      "Examples:",
      '  Schedule (Kaption bot): { action: "create", message: "Hey, just following up!", datetime: "2026-03-07T09:00:00Z", conversation_id: "5491157390064@c.us" }',
      '  Schedule from the user\'s own number: { action: "create", mode: "local", message: "Running 10 min late", datetime: "2026-03-07T09:00:00-03:00", conversation_id: "5491157390064@c.us" }',
      '  Schedule to a group: { action: "create", mode: "local", message: "Standup moved to 10", datetime: "2026-03-07T09:00:00Z", conversation_id: "120363000000000000@g.us" }',
      '  Cancel: { action: "delete", id: "msg_abc123" }',
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["create", "update", "delete", "cancel", "remove", "send_now"]).describe('Scheduled message action to perform (cancel, remove and send_now need mode "local")'),
      mode: z.enum(["bot", "local"]).optional().describe('"bot" (default): sent from Kaption\'s WhatsApp number. "local": sent from the user\'s own WhatsApp number while this computer and WhatsApp are open, within safe limits kept automatically; needed for groups'),
      id: z.string().optional().describe("Scheduled message ID (required for update/delete/cancel/remove/send_now)"),
      conversation_id: z.string().optional().describe('Chat to send the message to (required for create): a person, or a group with mode "local"'),
      message: z.string().optional().describe("Message text to send (required for create, optional for update). Bot: one line, max 800 characters. Local: text or caption up to 2000 characters; omit with an attachment"),
      attachment: localAttachmentSchema.nullable().optional().describe('Local create/update only. One attachment; null removes it on update. Omit message for attachment-only sends'),
      datetime: z.string().optional().describe("ISO 8601 datetime when the message should be sent (required for create, optional for update)"),
      notification_type: z.enum(["extension", "whatsapp", "automatic"]).optional().describe('Bot mode only. Notification type. Default: "automatic"'),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "manage_lists",
    description: [
      "Create, edit or delete personal chat lists (custom lists), and add or remove their chats. These are the personal account equivalent of Business labels.",
      "Lists organize chats into custom categories like \"Family\", \"Work\", etc. Not every account has lists; list_chat_lists says whether they are enabled.",
      "Reading lists is list_chat_lists and get_chat_list.",
      "",
      "Actions:",
      "  create      - Create a new list (requires name, optional conversation_id for initial chats)",
      "  edit        - Edit a list name or replace its chats (requires id or name)",
      "  delete      - Delete a list (requires id or name)",
      "  add_chat    - Add conversation(s) to a list (requires id/name + conversation_id)",
      "  remove_chat - Remove conversation(s) from a list (requires id/name + conversation_id)",
      "",
      "Examples:",
      '  Create: { action: "create", name: "Family", conversation_id: ["number@c.us"] }',
      '  Add chat: { action: "add_chat", name: "Family", conversation_id: "number@c.us" }',
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["create", "edit", "delete", "add_chat", "remove_chat"]).describe("List action to perform"),
      id: z.string().optional().describe("List ID (for edit/delete/add_chat/remove_chat)"),
      name: z.string().optional().describe("List name (for create/edit, or to resolve by name)"),
      conversation_id: z.union([z.string(), z.array(z.string())]).optional().describe("Chat ID or array of IDs to add/remove"),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "list_contacts",
    description: [
      "List WhatsApp contacts from the encrypted local cache (no network).",
      "Results are deduplicated by phone number — the same person across multiple labels collapses to one row.",
      "Saved contacts sort before unsaved, then alphabetically by display name.",
      'WhatsApp "@lid" privacy identifiers (opaque, non-dialable) are always excluded — only real phone-backed contacts are returned.',
      "",
      "Examples:",
      "  All contacts: {}",
      "  Saved contacts only: { is_my_contact: true }",
      '  Search by name: { query: "Maria" }',
      "  Page 2 of 50: { limit: 50, offset: 50 }",
    ].join("\n"),
    inputSchema: z.object({
      query: z.string().optional().describe("Case-insensitive substring matched against name, pushname, phone, and JID"),
      limit: z.number().min(1).max(500).optional().describe("Max contacts to return (default 50, max 500)"),
      offset: z.number().min(0).optional().describe("Skip N contacts for pagination (default 0)"),
      is_my_contact: z.boolean().optional().describe("If true, only contacts saved in the user address book. If false, only un-saved contacts. Omit to include both."),
    }),
  },
  {
    name: "get_contact",
    description: [
      "Look up a single WhatsApp contact by JID or phone number. Pass either parameter — both work.",
      "If multiple raw contacts share the same phone (label dupes), the saved variant wins.",
      "",
      "Examples:",
      '  By JID: { jid: "5491155550001@c.us" }',
      '  By phone with +: { phone: "+5491155550001" }',
      '  By phone bare: { phone: "5491155550001" }',
    ].join("\n"),
    inputSchema: z.object({
      jid: z.string().optional().describe('Full WhatsApp JID (e.g. "5491155550001@c.us")'),
      phone: z.string().optional().describe('Phone number — leading "+" and "00" are stripped during matching'),
    }),
  },
  {
    name: "get_contact_groups",
    description: [
      "List the WhatsApp groups a specific contact participates in. Reads from cached chat metadata — no network.",
      "",
      "Examples:",
      '  Groups for contact: { jid: "5491155550001@c.us" }',
    ].join("\n"),
    inputSchema: z.object({
      jid: z.string().describe("Contact JID — must be the full @c.us form (phone alone not accepted here)"),
    }),
  },
  {
    name: "list_groups",
    description: [
      "List all WhatsApp groups the user belongs to. Reads from the cache — no network.",
      "get_group returns one group with its membership fetched live from WhatsApp.",
      "",
      "Examples:",
      "  All groups: {}",
      '  Search by group name: { query: "family" }',
      "  Top 10: { limit: 10 }",
    ].join("\n"),
    inputSchema: z.object({
      query: z.string().optional().describe("Case-insensitive substring match against group name"),
      limit: z.number().min(1).max(500).optional().describe("Max groups to return (default 50, max 500)"),
    }),
  },
  {
    name: "get_group",
    description: [
      "Fetch a single group with a live participant list: membership is refreshed from WhatsApp before reading, so it includes recent joins and leaves.",
      "list_groups lists every group from the cache instead.",
      "",
      "Examples:",
      '  Live group fetch: { jid: "120363421729019499@g.us" }',
    ].join("\n"),
    inputSchema: z.object({
      jid: z.string().describe('Group JID — must end in "@g.us"'),
    }),
  },
  {
    name: "export_contacts",
    description: [
      "Export all WhatsApp contacts as CSV (RFC 4180) or JSON. Deduped, sorted alphabetically by display name.",
      "Default format is CSV. JSON projects the requested fields. Available fields: jid, phone, name, pushname, is_my_contact, is_business.",
      'WhatsApp "@lid" privacy identifiers (opaque, non-dialable) are always excluded — only real phone-backed contacts are returned.',
      "",
      "Examples:",
      '  CSV all fields: { format: "csv" }',
      '  JSON name + phone: { format: "json", fields: ["name", "phone"] }',
      '  Filtered CSV: { format: "csv", query: "Argentina" }',
      '  Saved contacts only: { format: "csv", is_my_contact: true }',
    ].join("\n"),
    inputSchema: z.object({
      format: z.enum(["csv", "json"]).optional().describe('Output format. Default "csv"'),
      query: z.string().optional().describe("Optional case-insensitive substring filter (matches name, pushname, phone, JID)"),
      fields: z.array(z.string()).optional().describe("Whitelist of fields to include. Defaults to all six: jid, phone, name, pushname, is_my_contact, is_business"),
      is_my_contact: z.boolean().optional().describe("If true, only contacts saved in the user address book. If false, only un-saved. Omit to include both."),
    }),
  },
  {
    name: "get_api_info",
    description: "Get HTTP REST API connection info for programmatic access without MCP overhead. Returns the URL, how to authenticate (where the token file is; the token itself is never returned) and the available endpoints.",
    inputSchema: z.object({}),
  },
  {
    name: "get_analytics",
    description: [
      "Get WhatsApp analytics data: KPIs, activity patterns, rankings, response times, call stats, labels, emojis, words, countries, and more.",
      "Supports section-based drill-down, date range filtering, chat/label/community filters, pagination, and chat/contact exports.",
      "",
      "section=\"overview\" (default) is a compact summary; the other sections give detail.",
      "",
      "Sections:",
      "  overview              — High-level summary with top 5 chats (~5KB)",
      "  kpis                  — Core + account KPIs + account overview",
      "  activity              — Daily/hourly/weekday/monthly + sent/received + message types",
      "  rankings              — Top chats/groups/DMs/senders (paginated)",
      "  response_times        — Avg/median/fastest/slowest + by-hour + by-chat",
      "  calls                 — Call statistics (total/answered/missed/video/voice)",
      "  labels                — Labels (business) or Lists (personal) with chat counts",
      "  emojis                — Top emojis (paginated)",
      "  words                 — Top words (paginated)",
      "  countries             — Contact country distribution",
      "  silences              — Longest-inactive chats",
      "  channels              — Newsletter/channel details + subscriber counts",
      "  communities           — Community details + sub-groups",
      "  conversation_starters — Who starts conversations, night msgs, unanswered",
      "  streaks               — Current/longest streak + last active date",
      "  gaps                  — Conversation gaps (>1 day silence periods)",
      "  organization          — Pinned/archived/muted/unread chat lists",
      "  chat_detail           — Full analytics for ONE specific chat (requires chat_id)",
      "  export_chat           — Export chat messages in format (requires chat_id + format)",
      "  export_contacts       — Export contacts in format (requires format)",
      "  community_growth      — Community member count history over time",
      "  channel_growth        — Channel subscriber count history over time",
      "",
      "Examples:",
      '  Overview: {}',
      '  Rankings: { section: "rankings", chat_type: "group", limit: 5 }',
      '  Filter by label: { section: "activity", label: "Family" }',
      '  Chat detail: { section: "chat_detail", chat_id: "120363406792713578@g.us" }',
      '  Export CSV: { section: "export_chat", chat_id: "...", format: "csv", limit: 100 }',
      '  Export contacts: { section: "export_contacts", format: "vcf" }',
    ].join("\n"),
    inputSchema: z.object({
      section: z.enum([
        "overview", "kpis", "activity", "rankings", "response_times", "calls",
        "labels", "emojis", "words", "countries", "silences", "channels",
        "communities", "conversation_starters", "streaks", "gaps", "organization",
        "chat_detail", "export_chat", "export_contacts",
        "community_growth", "channel_growth",
      ]).optional().default("overview").describe("Analytics section to retrieve"),
      date_range: z.enum(["7d", "30d", "90d", "1y", "all"]).optional().describe('Preset date range (default: "30d")'),
      date_from: z.string().optional().describe("Custom start date (ISO 8601) — overrides date_range"),
      date_to: z.string().optional().describe("Custom end date (ISO 8601) — overrides date_range"),
      chat_id: z.string().optional().describe("Filter to specific chat. Required for chat_detail/export_chat"),
      label: z.string().optional().describe("Filter by label/list name or ID"),
      community: z.string().optional().describe("Filter by community name or ID"),
      chat_type: z.enum(["all", "dm", "group"]).optional().describe("Filter rankings by chat type"),
      limit: z.number().min(1).max(500).optional().describe("Max items for paginated sections (default 20, max 500)"),
      offset: z.number().min(0).optional().describe("Skip N items for pagination"),
      format: z.enum(["json", "csv", "txt", "vcf"]).optional().describe("Export format (required for export_chat/export_contacts)"),
      query: z.string().optional().describe("Search keyword — filter analytics to only messages containing this text. Shows activity patterns for conversations mentioning a topic."),
      include_transcriptions: z.boolean().optional().describe("Include audio transcriptions in exports (default true)"),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "call_recordings",
    description: [
      "Read WhatsApp call recordings made by the Kaption extension and their transcripts, with every word timed.",
      "Each recording names its conversation (the other person, or the group for a group call), so it links to query, get_contact and get_group.",
      "Recordings of locked chats are never returned.",
      "",
      "Actions:",
      "  list   - Recordings, newest first (optional conversation_id, date_from, date_to, limit)",
      "  get    - One recording and its transcript: turns by speaker (\"you\" or \"contact\") with start/end seconds (requires id; include_words adds each word's timing)",
      "  search - Recordings whose name or transcript matches the search text, with the matching lines (requires search; same filters as list)",
      "",
      "Examples:",
      "  Recent calls: { action: \"list\", limit: 10 }",
      "  Calls with one person: { action: \"list\", conversation_id: \"5491157390064@c.us\" }",
      "  Read a transcript: { action: \"get\", id: \"1790000000000-a1b2c3d4\" }",
      "  What was said about the budget: { action: \"search\", search: \"budget\" }",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["list", "get", "search"]).describe("Call recordings action to perform"),
      id: z.string().optional().describe("Recording ID (required for get)"),
      search: z.string().optional().describe("Text to find in names and transcripts (required for search)"),
      conversation_id: z.string().optional().describe("Only recordings of this conversation (a contact or group ID)"),
      date_from: z.string().optional().describe("Only recordings started on or after this date (ISO 8601)"),
      date_to: z.string().optional().describe("Only recordings started on or before this date (ISO 8601)"),
      limit: z.number().min(1).max(100).optional().describe("Max recordings to return (default 20, max 100)"),
      include_words: z.boolean().optional().describe("For get: include each word with its start and end in seconds (default false)"),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  // mcp.TOOLS.19 — read-only halves of the manage_* tools (Claude's and Google's directories require reads and writes
  // in separate tools). They are answered by the same extension handlers: see TOOL_ROUTES.
  {
    name: "list_reminders",
    description: [
      "List the user's personal Kaption reminders (title, time, how they notify, completed or not).",
      "",
      "Examples:",
      "  Active reminders: {}",
      '  Everything: { filter: "all" }',
    ].join("\n"),
    inputSchema: z.object({
      filter: z.enum(["active", "completed", "all"]).optional().describe('Which reminders to list. Default: "active" (not completed)'),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "get_reminder",
    description: "Get one personal Kaption reminder by its ID (from list_reminders).",
    inputSchema: z.object({
      id: z.string().describe("Reminder ID"),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "list_scheduled_messages",
    description: [
      "List scheduled WhatsApp messages of both modes; each item says its mode:",
      "  bot   - sent from Kaption's WhatsApp number, stored in Kaption's cloud",
      '  local - "From this computer": sent from the user\'s own WhatsApp number while this computer and WhatsApp are open',
      "",
      "Examples:",
      "  Waiting to be sent: {}",
      '  Only local ones, any state: { mode: "local", filter: "all" }',
    ].join("\n"),
    inputSchema: z.object({
      mode: z.enum(["bot", "local"]).optional().describe("Only this mode; omit to list both"),
      filter: z.enum(["pending", "sent", "all"]).optional().describe('Default: "pending" (not sent yet; in local mode also missed or failed ones waiting for the user)'),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "get_scheduled_message",
    description: 'Get one scheduled WhatsApp message by its ID (from list_scheduled_messages or send_message). Pass mode "local" for a message sent from this computer.',
    inputSchema: z.object({
      id: z.string().describe("Scheduled message ID"),
      mode: z.enum(["bot", "local"]).optional().describe('"bot" (default) or "local"'),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "list_chat_lists",
    description: "List the personal account's custom chat lists (e.g. \"Family\", \"Work\") with their chat counts, and whether lists are enabled on this account.",
    inputSchema: z.object({
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "get_chat_list",
    description: "Get one custom chat list and the chats in it, by ID or name.",
    inputSchema: z.object({
      id: z.string().optional().describe("List ID (from list_chat_lists)"),
      name: z.string().optional().describe("List name, when the ID is not known"),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "get_contact_note",
    description: "Read the note saved for a contact. Requires a WhatsApp Business account with notes enabled.",
    inputSchema: z.object({
      contact_id: z.string().describe("The contact ID"),
    }),
  },
  // mcp-manage-kaption.LIST.2, LIST.5 — the manage tools below are listed only while a connected extension said so in
  // its features (manage-kaption.ts); the extension's core answers them, and reads and writes are separate tools there
  // already, so none needs a TOOL_ROUTES entry. Generated from kaptionai kext/scripts/mcp-manage-tools.json, the
  // same on the local hub and the cloud relay (tools-parity.test.ts).
  {
    name: "get_kaption_settings",
    description: "Reads Kaption's own settings for this WhatsApp account. Returns every visible setting, grouped (transcription, translation, dictation, media, notifications, app, features, backups, assistants, sending, plan), each with its id, current value, allowed values, what an assistant may do with it (change, off_only or read_only) and, for those it may not change, the Kaption screen where the user changes it. Also returns the local and cloud connections (connected, reconnecting or off) and which one carries this call. Sign-in, passwords, keys, the app lock and consents are never included. Changes nothing.",
    inputSchema: z.object({}),
  },
  {
    name: "update_kaption_settings",
    description: "Changes one Kaption setting for this WhatsApp account and returns the setting as it now reads. Accepted: changes that make Kaption do less or are neutral (turn a feature off, keep less media, transcribe or dictate on this computer, change the app language, show or hide a screen). Refused, with the Kaption screen where the user can change it: anything that would share, send or cost more, settings marked read_only, and values outside the allowed values. Setting ids and allowed values come from get_kaption_settings.",
    inputSchema: z.object({
      id: z.string().describe("The setting id, e.g. transcription.automatic"),
      value: z.unknown().optional().describe("The new value: one of the setting's allowed values (true/false, a choice, a number of bytes or a list of kinds)"),
    }),
  },
  {
    name: "reconnect_kaption_connection",
    description: "Restarts Kaption's local or cloud assistant connection when it is switched on and not connected. The connection that carries this call is never restarted, and a connection that is switched off stays off. Returns the connection's state.",
    inputSchema: z.object({
      bridge: z.enum(["local", "cloud"]).describe("Which connection to restart"),
    }),
  },
  {
    name: "kaption_help",
    description: "Reads Kaption's own guides and suggested prompts: how Kaption's features and plans work and how Claude and ChatGPT connect to it. action \"list\" returns every guide topic (id, title, one line); \"read\" with a topic returns that guide's text; \"prompts\" returns the prompts Kaption's AI assistants screen suggests, in the user's Kaption language.",
    inputSchema: z.object({
      action: z.enum(["list", "read", "prompts"]).describe("list, read or prompts"),
      topic: z.string().optional().describe("For read: a topic id from list, e.g. pricing"),
    }),
  },
  {
    name: "report_bug",
    description: "Reports a problem with Kaption to Kaption support, in two steps. A call with description (and optionally expected) sends nothing: it returns a preview of exactly what would be sent (the description and a few facts about this install: Kaption version, browser or app, operating system and the user's own WhatsApp number; never messages, chats or contacts) and a confirmation_token. A call with only that confirmation_token sends the previewed report. A token works once, for 10 minutes; at most 5 reports are sent per hour.",
    inputSchema: z.object({
      description: z.string().optional().describe("Step 1: what went wrong, in the user's words"),
      expected: z.string().optional().describe("Step 1, optional: what the user expected instead"),
      confirmation_token: z.string().optional().describe("Step 2: the token from the preview"),
    }),
  },
  {
    name: "get_business_agent",
    description: "Reads the user's Meta Business Agent (the AI that answers customers on their WhatsApp Business number). Changes nothing. action \"status\": connection (last 4 digits only), whether it answers and for whom, and credit. \"get_instructions\": its skills, their saved text and whether a draft differs from what is live. \"list_knowledge\": its knowledge files (name, kind, size). \"list_tools\": its custom tools (name, description, state). \"activity\": agent replies per day for the last 7 days (counts only). \"list_evals\" and \"eval_results\" (with job_id): its evaluations and their scores, where available. When the number is not connected, or the account lacks the Business Agent plan, the answer says what is needed and where.",
    inputSchema: z.object({
      action: z.enum(["status", "get_instructions", "list_knowledge", "list_tools", "activity", "list_evals", "eval_results"]).optional().describe("What to read (default status)"),
      job_id: z.string().optional().describe("eval_results: the run id that manage_business_agent run_evals returned"),
      eval_case_ids: z.array(z.string()).optional().describe("eval_results: exactly one eval id adds that eval's transcript"),
    }),
  },
  {
    name: "manage_business_agent",
    description: "Changes the user's Meta Business Agent (the AI that answers customers on their WhatsApp Business number). action \"pause\" stops its answers at once. \"resume\" and \"publish\" are two steps: the first call changes nothing and returns what will happen and a confirmation_token; the second call with that token turns answers on (resume) or puts a skill's draft live (publish). \"draft_instructions\" saves a skill's draft without publishing it. \"test_chat\" sends one message to Meta's private test chat for the agent, never to a customer, and returns its reply. \"run_evals\" (two steps, where available) starts an evaluation run. When the number is not connected, or the account lacks the Business Agent plan, nothing changes and the answer says what is needed and where.",
    inputSchema: z.object({
      action: z.enum(["pause", "resume", "draft_instructions", "publish", "test_chat", "run_evals"]).describe("What to change"),
      skill: z.string().optional().describe("draft_instructions, publish: the skill slug (from get_business_agent get_instructions; default instructions)"),
      description: z.string().optional().describe("draft_instructions: the skill's one-line description"),
      text: z.string().optional().describe("draft_instructions: the skill's full instructions text"),
      message: z.string().optional().describe("test_chat: the customer message to try"),
      conversation_id: z.string().optional().describe("test_chat: continue an earlier test chat"),
      eval_case_ids: z.array(z.string()).optional().describe("run_evals: the evals to run (from get_business_agent list_evals); empty runs all"),
      confirmation_token: z.string().optional().describe("resume, publish, run_evals: the token from the first call"),
    }),
  },
  {
    name: "kaption_plans",
    description: "Reads Kaption's plans exactly as the plans window in Kaption shows them to this user now: each plan's price per month and for each billing period in the user's currency, what it includes, which one the user has, and which payment methods are offered (card, Pix in Brazil, Alipay where available). Changes nothing.",
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: PLANS_UI_URI }, "openai/outputTemplate": PLANS_UI_URI },
  },
  {
    name: "create_kaption_checkout_link",
    description: "Creates the user's own private checkout link for one Kaption plan and billing period (with method alipay where kaption_plans offers it). It never collects payment details and never pays: payment happens on the checkout page. A plan that is coming soon or already the user's gets no link, and the answer says why.",
    inputSchema: z.object({
      plan: z.enum(["pro", "business", "business_agent"]).describe("The plan"),
      period: z.enum(["yearly", "quarterly", "monthly"]).optional().describe("The billing period (default yearly)"),
      method: z.enum(["card", "alipay"]).optional().describe("alipay only where kaption_plans offers it; card covers card and, in Brazil, Pix (default card)"),
    }),
  },
];

/**
 * mcp.TOOLS.19 — each read-only tool that is answered by a manage_* handler, and the action it runs there. Clients
 * call the read tool; the relay (and the local hub) send the extension the manage_* call, so every Kaption version
 * that answers manage_* answers these too.
 */
export const TOOL_ROUTES: Record<string, { method: string; action: string }> = {
  list_reminders: { method: "manage_reminders", action: "list" },
  get_reminder: { method: "manage_reminders", action: "get" },
  list_scheduled_messages: { method: "manage_scheduled_messages", action: "list" },
  get_scheduled_message: { method: "manage_scheduled_messages", action: "get" },
  list_chat_lists: { method: "manage_lists", action: "list" },
  get_chat_list: { method: "manage_lists", action: "get" },
  get_contact_note: { method: "manage_notes", action: "get" },
};

/** The call the extension receives for a tool call: a routed read becomes its manage_* method and action. */
export function routeToolCall(
  name: string,
  args: Record<string, unknown>,
): { method: string; params: Record<string, unknown> } {
  const route = TOOL_ROUTES[name];
  if (!route) return { method: name, params: args };
  return { method: route.method, params: { ...args, action: route.action } };
}

// mcp.TOOLS — human-readable titles and safety annotations advertised to MCP
// clients. These values are also snapshotted by the OpenAI plugin review flow.
const TOOL_TITLES: Record<string, string> = {
  query: "Search WhatsApp",
  summarize_conversation: "Summarize conversation",
  manage_labels: "Manage business labels",
  manage_notes: "Set contact note",
  download_media: "Download message media",
  manage_chat: "Manage chat",
  manage_reminders: "Manage reminders",
  create_attachment_upload: "Create attachment upload",
  send_message: "Send WhatsApp message",
  manage_scheduled_messages: "Manage scheduled messages",
  manage_lists: "Manage chat lists",
  list_contacts: "List contacts",
  get_contact: "Get contact",
  get_contact_groups: "List contact groups",
  list_groups: "List groups",
  get_group: "Get group",
  export_contacts: "Export contacts",
  get_api_info: "Get local API information",
  get_analytics: "Analyze WhatsApp activity",
  call_recordings: "Read call recordings",
  list_reminders: "List reminders",
  get_reminder: "Get reminder",
  list_scheduled_messages: "List scheduled messages",
  get_scheduled_message: "Get scheduled message",
  list_chat_lists: "List chat lists",
  get_chat_list: "Get chat list",
  get_contact_note: "Get contact note",
  get_kaption_settings: "Get Kaption settings",
  update_kaption_settings: "Update a Kaption setting",
  reconnect_kaption_connection: "Reconnect a Kaption connection",
  kaption_help: "Kaption help",
  report_bug: "Report a Kaption problem",
  get_business_agent: "Get Business Agent",
  manage_business_agent: "Manage Business Agent",
  kaption_plans: "Kaption plans",
  create_kaption_checkout_link: "Create a Kaption checkout link",
};

// Safety annotations use OpenAI's review definitions:
//   readOnlyHint    : tool does not modify state (pure read).
//   destructiveHint : may perform destructive/irreversible updates
//                     (delete, or a scheduled/deferred WhatsApp send).
//   idempotentHint  : repeating the call with the same args is a no-op.
//   openWorldHint   : acts on an independently controlled external system:
//                     changes state visible to another WhatsApp user, syncs to
//                     the account on WhatsApp's servers, or fetches live from
//                     WhatsApp's backend. Reading the local Store is false.
const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  query: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  summarize_conversation: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  manage_labels: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  manage_notes: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  download_media: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  manage_chat: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  manage_reminders: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  create_attachment_upload: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  send_message: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  manage_scheduled_messages: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  manage_lists: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  list_contacts: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_contact: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_contact_groups: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_groups: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_group: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  export_contacts: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_api_info: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_analytics: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  call_recordings: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_reminders: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_reminder: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_scheduled_messages: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_scheduled_message: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_chat_lists: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_chat_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_contact_note: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_kaption_settings: { title: "Get Kaption settings", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  update_kaption_settings: { title: "Update a Kaption setting", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  reconnect_kaption_connection: { title: "Reconnect a Kaption connection", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  kaption_help: { title: "Kaption help", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  report_bug: { title: "Report a Kaption problem", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  get_business_agent: { title: "Get Business Agent", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  manage_business_agent: { title: "Manage Business Agent", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  kaption_plans: { title: "Kaption plans", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  create_kaption_checkout_link: { title: "Create a Kaption checkout link", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

for (const tool of TOOLS) {
  tool.title = TOOL_TITLES[tool.name];
  tool.annotations = TOOL_ANNOTATIONS[tool.name];
}

/**
 * Public cloud tool surface. `get_api_info` is local-only: it describes the
 * local hub's REST API on this computer, which is never useful to a hosted client.
 */
export const CLOUD_TOOLS: ToolDefinition[] = TOOLS.filter(
  (tool) => tool.name !== "get_api_info",
);

/**
 * Get a tool definition by name
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Convert tool definitions to MCP-compatible format (JSON Schema)
 */
export function getToolsForMCP(): Array<{
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
    annotations: tool.annotations,
    ...(tool._meta ? { _meta: tool._meta } : {}),
  }));
}

/**
 * Simple zod-to-JSON-Schema converter for the subset we use
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const zodValue = value as z.ZodType;
      const propSchema = zodToJsonSchema(zodValue);
      properties[key] = propSchema;

      // Check if the field is required (not optional and not defaulted)
      if (!(zodValue instanceof z.ZodOptional) && !(zodValue instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    const result: Record<string, unknown> = {
      type: "object",
      properties,
      additionalProperties: false,
    };
    if (schema.description) result.description = schema.description;
    if (required.length > 0) {
      result.required = required;
    }
    return result;
  }

  if (schema instanceof z.ZodString) {
    return { type: "string", description: schema.description };
  }

  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: "number" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodBoolean) {
    const result: Record<string, unknown> = { type: "boolean" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: schema.options, description: schema.description };
  }

  if (schema instanceof z.ZodNullable) {
    return { oneOf: [zodToJsonSchema(schema.unwrap()), { type: 'null' }], ...(schema.description ? { description: schema.description } : {}) };
  }

  if (schema instanceof z.ZodOptional) {
    const inner = zodToJsonSchema(schema.unwrap());
    if (schema.description && !inner.description) {
      return { ...inner, description: schema.description };
    }
    return inner;
  }

  if (schema instanceof z.ZodDefault) {
    const inner = zodToJsonSchema(schema.removeDefault());
    const result: Record<string, unknown> = { ...inner, default: schema._def.defaultValue() };
    if (schema.description && !result.description) {
      result.description = schema.description;
    }
    return result;
  }

  if (schema instanceof z.ZodArray) {
    const result: Record<string, unknown> = { type: "array", items: zodToJsonSchema(schema.element) };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodUnion) {
    const options = (schema._def.options as z.ZodType[]).map(zodToJsonSchema);
    const result: Record<string, unknown> = { oneOf: options };
    if (schema.description) result.description = schema.description;
    return result;
  }

  // Any JSON value (update_kaption_settings.value).
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) {
    return schema.description ? { description: schema.description } : {};
  }

  return { type: "object" };
}
