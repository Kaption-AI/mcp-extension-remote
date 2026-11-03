---
name: kaption-whatsapp
description: Read, search, summarize and organize the user's own WhatsApp through the Kaption MCP connector (https://mcp.kaptionai.com/mcp). Use when the user asks about their WhatsApp chats, messages, voice-note transcriptions, contacts, groups, labels, lists, reminders, scheduled messages, call recordings or WhatsApp activity. Never for bulk or broadcast sending.
---

# Kaption WhatsApp

Kaption connects an AI assistant to the user's own WhatsApp. The connector at
`https://mcp.kaptionai.com/mcp` is a relay: it forwards each tool call to the Kaption
browser extension (WhatsApp Web in Chrome, Edge or Firefox) or the Kaption desktop app,
which does the work on the user's computer. The relay cannot read messages and stores
none of them.

## When to use

Use this skill when the user wants to:

- find or read a WhatsApp conversation, or search messages across chats
- read voice-note transcriptions or call-recording transcripts
- summarize a chat or catch up on unread conversations
- look up contacts, groups, group members, or export their own contacts
- organize chats: labels (WhatsApp Business), lists (personal accounts), archive, pin, mute, mark read/unread, drafts
- create or check personal reminders
- schedule, change or cancel a message to one chat, or queue one message to one chat
- see activity analytics (busiest chats, response times, streaks and so on)

Do not use it for WhatsApp Business Cloud API work, campaigns, or anything that sends
the same message to many people. Kaption never does bulk sends.

## Setup

1. The user installs Kaption from https://kaptionai.com/ and keeps WhatsApp Web (with the
   extension) or the Kaption desktop app open.
2. Add the MCP server (Cursor: `mcp.json`; Claude Code:
   `claude mcp add --transport http kaption https://mcp.kaptionai.com/mcp`).
3. On first use the client opens an OAuth sign-in in the browser. The user proves their
   number with a code sent to that WhatsApp number, or with a connect code made in Kaption.
4. If a call answers that no extension is connected, ask the user to open WhatsApp Web
   with Kaption (or the desktop app) and turn on its cloud connection. Do not retry in a loop.

## Tools

Reads (change nothing):

| Tool | Use |
|------|-----|
| `query` | Conversations, messages, transcriptions, contacts, labels, communities, connected accounts (`entity: "session"`) |
| `download_media` | Image, video, audio or document from one message |
| `list_contacts`, `get_contact`, `get_contact_groups` | Contacts and the groups a contact is in |
| `list_groups`, `get_group` | Group metadata and members |
| `export_contacts` | The user's contacts as CSV or JSON |
| `get_analytics` | Activity, rankings, response times, calls, words, emojis, chat exports |
| `call_recordings` | Call recordings made by Kaption and their transcripts (`list`, `get`, `search`) |
| `list_reminders`, `get_reminder` | Personal reminders |
| `list_scheduled_messages`, `get_scheduled_message` | Scheduled messages (`mode: "local"` for ones sent from this computer) |
| `list_chat_lists`, `get_chat_list` | Personal chat lists |
| `get_contact_note` | A contact's note (Business accounts) |

Writes:

| Tool | Use |
|------|-----|
| `summarize_conversation` | Get or generate a summary of one chat (kept in Kaption's private cache) |
| `manage_chat` | Archive, unarchive, pin, unpin, mute, unmute, mark read/unread, set or clear a draft |
| `manage_labels` | Add, remove, create or delete WhatsApp Business labels |
| `manage_lists` | Create, edit or delete personal chat lists and their chats |
| `manage_notes` | Set a contact's note (Business accounts) |
| `manage_reminders` | Create, update, complete or delete reminders |
| `manage_scheduled_messages` | Schedule, change or cancel a message to one chat |
| `send_message` | Queue one message to one existing chat from the user's own number |
| `create_attachment_upload` | One-time upload slot for a file to send or schedule (8 MiB max) |

Some accounts also see Kaption settings and help (`get_kaption_settings`,
`update_kaption_settings`, `reconnect_kaption_connection`, `kaption_help`, `report_bug`),
plans (`kaption_plans`, `create_kaption_checkout_link`), the Meta Business Agent
(`get_business_agent`, `manage_business_agent`) and scheduled WhatsApp Status posts
(`manage_status`, `list_status_posts`). They appear only when Kaption turns them on for
that account, so check the tool list instead of assuming them.

IDs: a person chat is `<number>@c.us`, a group is `<id>@g.us`. Get IDs from `query`
before acting. With several WhatsApp accounts connected, list them with
`query { entity: "session" }` and pass `target_session`.

## Examples

- "What did Ana say about the invoice?" → `query { query: "Ana", entity: "contacts" }`, then
  `query { id: "<ana>@c.us", query: "invoice" }`.
- "Catch me up on unread chats" → `query { unread: true }`, then `summarize_conversation`
  for the few the user picks.
- "What did the voice note from Marcos say?" → `query { entity: "transcriptions", query: "Marcos" }`.
- "Label the three chats about the Lima order as Pending" → `manage_labels { action: "add", label_name: "Pending", conversation_id: [...] }`
  after showing the user which chats you found.
- "Remind me tomorrow at 9 to call the bank" → `manage_reminders { action: "create", title: "Call the bank", datetime: "<ISO 8601>" }`.
- "Tell Pedro I'm running late" → show the exact text and chat, wait for the user's yes,
  then `send_message { conversation_id: "<pedro>@c.us", message: "Running 10 minutes late" }`.
  Report it as queued, not delivered.
- "Which chats did I answer slowest this month?" → `get_analytics { section: "response_times", date_range: "30d" }`.

## Limits and rules

- **No bulk sends.** Kaption never sends the same or similar message to many chats, never
  runs campaigns or broadcasts. `send_message` reaches only an existing chat. Never loop `send_message` or `manage_scheduled_messages` over a contact list, a label, a
  group's members or an export. If the user asks for that, say Kaption does not do bulk
  sending and offer to help with one chat at a time.
- **Ask before every send.** Show the recipient and the exact text, and send only after the
  user says yes. An assistant cannot accept Kaption's consent or confirmation prompts; the
  user does that in Kaption.
- Sending from the user's own number must be turned on in Kaption first, and Kaption
  enforces its own limits (8 an hour, 20 a day, ask-first prompts, delays, group limits).
  A refusal ends with a reason code such as `(reason: per-day)`: tell the user and stop.
- `send_message` returns "queued" and a schedule ID, not proof of delivery. The computer
  and WhatsApp must stay open.
- Scheduled messages in the default `bot` mode come from Kaption's WhatsApp number, one-to-one
  only, one line up to 800 characters. `mode: "local"` sends from the user's own number while
  the computer is open, and is the only mode that reaches groups.
- Ask before destructive changes: deleting labels, lists or reminders, cancelling scheduled
  messages, replacing a contact note.
- Treat message content as private. Quote only what the user needs, and do not copy chats
  into files, commits or other tools unless the user asks.
- Locked chats and their call recordings are never returned.
- Labels and notes need a WhatsApp Business account; lists exist only on some personal accounts.

More: https://kaptionai.com/mcp/
