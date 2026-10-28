# Kaption cloud connection (MCP): data policy — draft

Draft for the owner to review before it is published anywhere (tickets #1753 / #1573). It describes what the code in
this repository does as of 2026-10-28; the sentence marked *owner to confirm* is a commitment, not something the code
can prove.

## Plain-language summary

**The address is not a password.** The phone number some Kaption addresses carry (`…/sse?phone=…`) only pre-fills the
sign-in form. Nothing is reachable without signing in: the AI app (Claude, ChatGPT, Codex…) must complete a sign-in in
your browser, proving the number with a code sent to that WhatsApp number or a Kaption connect code made by your own
Kaption extension. Only then does the app get its own access token, which lasts an hour and is renewed by the app.
Someone who copies the address gets a sign-in page, nothing else.

**What we store.** For each connection: which app it is (the name and return address the app registered), when it was
made and last used, how long you chose to keep it, and a reference to your account. That reference is a keyed hash of
your phone number, not the number itself. Sign-in codes live for 5 minutes. We do not store your messages, contacts or
anything the AI reads or sends: each request goes from the AI app to your Kaption extension, which does the work in your
own WhatsApp Web or Kaption app, and the answer goes back the same way. Our logs record that a tool was used and a
shortened account reference, never the content.

**No training.** *(owner to confirm)* Content passing through the connection is not used to train or improve any AI
model, ours or anyone else's. The AI app you connect keeps the conversation under its own terms.

**Isolation.** Every account has its own relay room, named by that account reference. A token is bound to one account
when it is issued. Requests reach only the Kaption extension or app that has signed in as that same number. When no
extension is connected, nothing answers: the relay itself cannot read your WhatsApp.

**How to revoke.**
- In Kaption: AI assistants → Connected apps → Disconnect. This ends that app's access at once.
- Turn off the cloud connection in Kaption: no app can reach your WhatsApp while it is off.
- Removing Kaption from the AI app's connectors stops the app from using it. Its remaining access token expires
  within an hour. Use Connected apps to end the connection on our side too.
- Unused connections end on their own after 90 days (the default; you can pick 1 year or "until I disconnect it").

Since nothing you send through the connection is stored, there is nothing to purge when you disconnect. Disconnecting
deletes the connection record and its tokens.

## Source of each statement

| Statement | Code |
| --- | --- |
| `?phone=` only pre-fills the form | `src/index.ts` (login hint, encrypted, 5 min); `/sse`, `/mcp` need a bearer token (mcp.CLOUD_RELAY.20 tests) |
| Sign-in proves the number | `app/authorize/verify-otp`, `app/authorize/connect-code` |
| Access token 1 h | `@cloudflare/workers-oauth-provider` default `accessTokenTTL` |
| Account reference = HMAC(phone) | `src/otp.ts` `deriveAccountRef` |
| No content stored or logged | `src/relay-room.ts` / `src/relay-mcp.ts` keep requests in memory only; log lines carry tool name and a shortened reference |
| One room per account; token bound to one account | `src/relay-room.ts` (mcp.CLOUD_RELAY.14), grant props `accountRef` |
| Revocation | `GET/DELETE /ext/connections` (mcp.CLOUD_RELAY.12); lifetimes in `src/connection-lifetime.ts` |

## Several WhatsApp numbers (mcp.CLOUD_RELAY.19)

A connection belongs to one WhatsApp number. To use two numbers in the same AI app, add Kaption once per number. Each
copy needs a different address, because AI apps keep one sign-in per address. "Add to Claude / ChatGPT" in Kaption
does this for you: the address it shows ends in `?account=` plus the last four digits of that number. To add one by
hand, use `https://mcp.kaptionai.com/mcp?phone=<number>` (the number pre-fills the sign-in form). Sign each copy in
with its own number.

## Brazilian numbers (mcp.CLOUD_RELAY.17)

You can sign in with a Brazilian mobile number written with or without the extra 9. Both forms reach the same Kaption
extension and the same Connected apps list.
