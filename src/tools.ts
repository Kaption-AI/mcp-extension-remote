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
}

/** Stable structured-output envelope used by every public cloud tool. */
export const PUBLIC_TOOL_OUTPUT_SCHEMA = z.object({
  result: z.unknown().describe("The JSON-compatible result returned by the Kaption extension"),
});

export const TOOLS: ToolDefinition[] = [
  {
    name: "query",
    description: [
      "Query WhatsApp data: conversations, contacts, messages, transcriptions, labels, and communities.",
      "Supports listing, searching, filtering, and looking up by ID.",
      "",
      "IMPORTANT: Multiple WhatsApp accounts may be connected (e.g. personal + business).",
      'Always query entity="session" FIRST to see all connected accounts and their session IDs.',
      "Then use target_session to route queries to the correct account.",
      "Each account has different conversations, contacts, and messages.",
      "",
      "HOW TO READ MESSAGES:",
      '  To get messages from a specific conversation, pass its id (e.g. "5491157390064@c.us").',
      "  This returns the conversation info WITH its messages. Use limit to control how many.",
      '  Do NOT use entity="messages" for this — that is for global text search only.',
      "",
      "AUDIO TRANSCRIPTIONS:",
      '  To get audio transcriptions, use entity="transcriptions" with an optional query.',
      "  Or pass a conversation id to see messages (audio messages include transcription text).",
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
      "Manage contact notes. Requires a WhatsApp Business account with notes enabled.",
      "",
      "Actions:",
      "  get - Read the note for a contact",
      "  set - Write/update the note for a contact",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["get", "set"]).describe("Note action to perform"),
      contact_id: z.string().describe("The contact ID"),
      note: z.string().optional().describe('Note text (required for "set" action)'),
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
      "Manage personal reminders. Reminders are stored in the cloud and trigger notifications via the Kaption extension.",
      "",
      "Actions:",
      "  list       - List all reminders",
      "  get        - Get a specific reminder by ID",
      "  create     - Create a new reminder (requires title + datetime)",
      "  update     - Update a reminder (requires id, optional title/datetime)",
      "  delete     - Delete a reminder (requires id)",
      "  complete   - Mark a reminder as completed (requires id)",
      "  uncomplete - Mark a reminder as not completed (requires id)",
      "",
      "Examples:",
      '  List all: { action: "list" }',
      '  Create: { action: "create", title: "Follow up with client", datetime: "2026-03-07T14:00:00Z" }',
      '  Complete: { action: "complete", id: "rem_abc123" }',
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["list", "get", "create", "update", "delete", "complete", "uncomplete"]).describe("Reminder action to perform"),
      filter: z.enum(["active", "completed", "all"]).optional().describe('Filter for list action. Default: "active" (non-completed only)'),
      id: z.string().optional().describe("Reminder ID (required for get/update/delete/complete/uncomplete)"),
      title: z.string().optional().describe("Reminder text (required for create, optional for update)"),
      datetime: z.string().optional().describe("ISO 8601 datetime for the reminder (required for create, optional for update)"),
      notification_type: z.enum(["extension", "whatsapp", "automatic"]).optional().describe('How to notify. Default: "automatic"'),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "manage_scheduled_messages",
    description: [
      "Schedule WhatsApp messages to be sent automatically at a specific time, in one of two modes:",
      "  bot (default) - sent from Kaption's WhatsApp number, not the user's own. Stored in Kaption's cloud and sent even when this computer is off. One-to-one chats only (no groups); one line, max 800 characters.",
      '  local ("From this computer") - sent from the user\'s own WhatsApp number, as them, while this computer and WhatsApp are open. Stays on this device. Kaption keeps it within safe limits automatically (a few messages an hour and a day, minutes apart, only to chats where the other person has written, at most 3 a day to groups) and refuses what does not fit. The only mode that can send to groups (ones the user can post in and posted in within 30 days). Text only. A message whose time passes while this computer is off is missed, never sent late on its own.',
      'The local mode must first be turned on by the user in Kaption (its "From this computer" option, after reading the risks); an assistant cannot turn it on. A refused local request says why and ends with a reason code, e.g. "(reason: per-day)".',
      "",
      "Actions:",
      '  list     - List scheduled messages of both modes (each has "mode"); pass mode to list only one',
      "  get      - Get a specific scheduled message by ID",
      "  create   - Schedule a new message (requires message + datetime + conversation_id)",
      "  update   - Change the message and/or datetime (requires id)",
      "  delete   - Cancel/delete a scheduled message (requires id); in local mode it cancels a waiting message and removes a finished one",
      "  cancel   - Local mode only: cancel a waiting, missed or failed message",
      "  remove   - Local mode only: remove a finished message from the list",
      "  send_now - Local mode only: send a missed or failed message now (still within the limits)",
      'Pass mode "local" for every action on a local message.',
      "",
      "Examples:",
      '  List all: { action: "list" }',
      '  Schedule (Kaption bot): { action: "create", message: "Hey, just following up!", datetime: "2026-03-07T09:00:00Z", conversation_id: "5491157390064@c.us" }',
      '  Schedule from the user\'s own number: { action: "create", mode: "local", message: "Running 10 min late", datetime: "2026-03-07T09:00:00-03:00", conversation_id: "5491157390064@c.us" }',
      '  Schedule to a group: { action: "create", mode: "local", message: "Standup moved to 10", datetime: "2026-03-07T09:00:00Z", conversation_id: "120363000000000000@g.us" }',
      '  Cancel: { action: "delete", id: "msg_abc123" }',
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["list", "get", "create", "update", "delete", "cancel", "remove", "send_now"]).describe('Scheduled message action to perform (cancel, remove and send_now need mode "local")'),
      mode: z.enum(["bot", "local"]).optional().describe('"bot" (default): sent from Kaption\'s WhatsApp number. "local": sent from the user\'s own WhatsApp number while this computer and WhatsApp are open, within safe limits kept automatically; needed for groups. For list, omit to get both modes'),
      filter: z.enum(["pending", "sent", "all"]).optional().describe('Filter for list action. Default: "pending" (not sent yet; in local mode also missed or failed ones waiting for the user)'),
      id: z.string().optional().describe("Scheduled message ID (required for get/update/delete/cancel/remove/send_now)"),
      conversation_id: z.string().optional().describe('Chat to send the message to (required for create): a person, or a group with mode "local"'),
      message: z.string().optional().describe("Message text to send (required for create, optional for update). Bot: one line, max 800 characters. Local: text only, up to 2000 characters"),
      datetime: z.string().optional().describe("ISO 8601 datetime when the message should be sent (required for create, optional for update)"),
      notification_type: z.enum(["extension", "whatsapp", "automatic"]).optional().describe('Bot mode only. Notification type. Default: "automatic"'),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "manage_lists",
    description: [
      "Manage personal chat lists (custom lists). These are the personal account equivalent of Business labels.",
      "Lists allow organizing chats into custom categories like \"Family\", \"Work\", etc.",
      "Not available on all accounts — check with action \"list\" first to see if lists are enabled.",
      "",
      "Actions:",
      "  list        - List all custom lists (also shows if feature is enabled)",
      "  get         - Get a list and its associated chats (requires id or name)",
      "  create      - Create a new list (requires name, optional conversation_id for initial chats)",
      "  edit        - Edit a list name or replace its chats (requires id or name)",
      "  delete      - Delete a list (requires id or name)",
      "  add_chat    - Add conversation(s) to a list (requires id/name + conversation_id)",
      "  remove_chat - Remove conversation(s) from a list (requires id/name + conversation_id)",
      "",
      "Examples:",
      '  List all: { action: "list" }',
      '  Create: { action: "create", name: "Family", conversation_id: ["number@c.us"] }',
      '  Add chat: { action: "add_chat", name: "Family", conversation_id: "number@c.us" }',
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["list", "get", "create", "edit", "delete", "add_chat", "remove_chat"]).describe("List action to perform"),
      id: z.string().optional().describe("List ID (for get/edit/delete/add_chat/remove_chat)"),
      name: z.string().optional().describe("List name (for create/edit, or to resolve by name)"),
      conversation_id: z.union([z.string(), z.array(z.string())]).optional().describe("Chat ID or array of IDs to add/remove"),
      target_session: z.string().optional().describe("Session ID for multi-account routing"),
    }),
  },
  {
    name: "list_contacts",
    description: [
      "List WhatsApp contacts from the encrypted DBR3 cache (no network).",
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
      "For a live snapshot of a single group, use `get_group` (it forces a fresh GroupMetadata.update).",
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
      "Fetch a single group with a LIVE participant list. Forces `Store.GroupMetadata.update()` against the WA backend before reading, so the result reflects current membership including recent joins/leaves.",
      "Use this when accuracy matters; use `list_groups` for browsing.",
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
    description: "Get HTTP REST API connection info for programmatic access without MCP overhead. Returns URL, auth token, and available endpoints.",
    inputSchema: z.object({}),
  },
  {
    name: "get_analytics",
    description: [
      "Get WhatsApp analytics data: KPIs, activity patterns, rankings, response times, call stats, labels, emojis, words, countries, and more.",
      "Supports section-based drill-down, date range filtering, chat/label/community filters, pagination, and chat/contact exports.",
      "",
      "Start with section=\"overview\" (default) for a compact summary, then drill into specific sections.",
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
];

// mcp.TOOLS — human-readable titles and safety annotations advertised to MCP
// clients. These values are also snapshotted by the OpenAI plugin review flow.
const TOOL_TITLES: Record<string, string> = {
  query: "Search WhatsApp",
  summarize_conversation: "Summarize conversation",
  manage_labels: "Manage business labels",
  manage_notes: "Manage contact notes",
  download_media: "Download message media",
  manage_chat: "Manage chat",
  manage_reminders: "Manage reminders",
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
};

// Safety annotations use OpenAI's review definitions:
//   readOnlyHint    : tool does not modify state (pure read).
//   destructiveHint : may perform destructive/irreversible updates
//                     (delete, or a scheduled/deferred WhatsApp send).
//   idempotentHint  : repeating the call with the same args is a no-op.
//   openWorldHint   : can change state visible to an external recipient or the
//                     public internet. Reading remote/private data is false.
const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  query: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  summarize_conversation: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  manage_labels: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  manage_notes: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  download_media: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  manage_chat: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  manage_reminders: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  manage_scheduled_messages: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  manage_lists: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  list_contacts: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_contact: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_contact_groups: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_groups: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_group: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  export_contacts: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_api_info: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_analytics: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  call_recordings: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

for (const tool of TOOLS) {
  tool.title = TOOL_TITLES[tool.name];
  tool.annotations = TOOL_ANNOTATIONS[tool.name];
}

/**
 * Public cloud tool surface. `get_api_info` is local-only because it returns
 * the extension's private REST connection token and is never safe or useful
 * to relay to a hosted MCP client.
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
}> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
    annotations: tool.annotations,
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

  return { type: "object" };
}
