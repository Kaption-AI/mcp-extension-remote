/**
 * mcp-apps-cards.SHELL.1-8, SEARCH, SENT, SCHEDULED — the MCP Apps page for the Kaption cards (ui://kaption/cards.html).
 *
 * One page draws every card from structuredContent.card of the tool result (built by cards.ts). Buttons that only
 * show more stay in the page; buttons that ask the assistant use ui/message; buttons that change something ask
 * "Are you sure?" in the card first, then call the normal public tool through the host (tools/call, or
 * window.openai.callTool on ChatGPT), so consent and sending limits are unchanged. Inline CSS and JS only; nothing is
 * loaded from elsewhere. The embedded script uses no template literals (this file is one).
 *
 * Kept identical in the local hub (kaption-mcp/src/cardsUi.ts) and the cloud relay (kaption-mcp-remote/src/cards-ui.ts);
 * tools-parity.test.ts compares them.
 */

export const CARDS_UI_MIME_TYPE = 'text/html;profile=mcp-app';

export const CARDS_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kaption</title>
<style>
:root {
  --bg: var(--color-background-primary, #ffffff); --sf: var(--color-background-secondary, #f3f5f5);
  --ln: var(--color-border-primary, #e3e6e7); --tx: var(--color-text-primary, #111b21);
  --tx2: var(--color-text-secondary, #54656f); --tx3: var(--color-text-tertiary, #667781);
  --acc: #0a6e5a; --acc-tx: #ffffff; --acc-soft: #e3f2ec; --acc-strong: #08513f;
  --mark: #ffeaa0; --mark-tx: #111b21; --avatar: #e2e8ea;
  --danger: #b42318; --danger-soft: #fdecea; --danger-btn: #b42318; --danger-btn-tx: #ffffff; --danger-line: #f1c4bf;
  --wait-bg: #fdf0dc; --wait-tx: #7a4a00; --ok-bg: #e3f2ec; --ok-tx: #0a5a49;
  --chat-bg: #efeae2; --bubble: #d9fdd3; --blue: #0270a3; --bar-off: #dfe3e4;
  --font: var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: var(--color-background-primary, #1b2329); --sf: var(--color-background-secondary, #232d33);
    --ln: var(--color-border-primary, #323d44); --tx: var(--color-text-primary, #e9edef);
    --tx2: var(--color-text-secondary, #a9b5bc); --tx3: var(--color-text-tertiary, #8f9aa0);
    --acc: #68a387; --acc-tx: #0d1512; --acc-soft: #1f3a31; --acc-strong: #9fd6bd;
    --mark: #5a4810; --mark-tx: #fff6d6; --avatar: #34424a;
    --danger: #f97066; --danger-soft: #3a1f1d; --danger-btn: #f97066; --danger-btn-tx: #1b0c0b; --danger-line: #5c2b27;
    --wait-bg: #3a2c14; --wait-tx: #f3c27a; --ok-bg: #1f3a31; --ok-tx: #9fd6bd;
    --chat-bg: #0b141a; --bubble: #005c4b; --blue: #53bdeb; --bar-off: #323d44;
  }
}
:root[data-theme="dark"] {
  --bg: var(--color-background-primary, #1b2329); --sf: var(--color-background-secondary, #232d33);
  --ln: var(--color-border-primary, #323d44); --tx: var(--color-text-primary, #e9edef);
  --tx2: var(--color-text-secondary, #a9b5bc); --tx3: var(--color-text-tertiary, #8f9aa0);
  --acc: #68a387; --acc-tx: #0d1512; --acc-soft: #1f3a31; --acc-strong: #9fd6bd;
  --mark: #5a4810; --mark-tx: #fff6d6; --avatar: #34424a;
  --danger: #f97066; --danger-soft: #3a1f1d; --danger-btn: #f97066; --danger-btn-tx: #1b0c0b; --danger-line: #5c2b27;
  --wait-bg: #3a2c14; --wait-tx: #f3c27a; --ok-bg: #1f3a31; --ok-tx: #9fd6bd;
  --chat-bg: #0b141a; --bubble: #005c4b; --blue: #53bdeb; --bar-off: #323d44;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; color: var(--tx); }
body { font: 14px/1.4 var(--font); padding: 2px; }
button, input { font: inherit; }
.card { background: var(--bg); border: 1px solid var(--ln); border-radius: 16px; padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.logo { width: 28px; height: 28px; border-radius: 8px; background: var(--acc); color: var(--acc-tx); display: flex; align-items: center; justify-content: center; font-weight: 700; flex: 0 0 auto; }
.titles { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.title { font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
.sub, .muted { font-size: 12px; color: var(--tx3); overflow-wrap: anywhere; }
.pill { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; white-space: nowrap; flex: 0 0 auto; background: var(--sf); color: var(--tx2); }
.pill.ok { background: var(--ok-bg); color: var(--ok-tx); }
.pill.wait { background: var(--wait-bg); color: var(--wait-tx); }
.pill.bad { background: var(--danger-soft); color: var(--danger); }
.box { border: 1px solid var(--ln); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.box.confirming { border-color: var(--danger-line); }
.row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--avatar); color: var(--tx2); display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 13px; flex: 0 0 auto; overflow: hidden; }
.avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.head .avatar { width: 28px; height: 28px; font-size: 12px; }
.grow { flex: 1 1 auto; min-width: 0; }
.name { font-weight: 600; overflow-wrap: anywhere; }
.name-link { background: none; border: 0; padding: 0; color: inherit; font-weight: 600; cursor: pointer; text-align: left; text-decoration: underline; text-decoration-color: var(--ln); text-underline-offset: 3px; overflow-wrap: anywhere; }
.right { text-align: right; flex: 0 0 auto; }
.when { font-weight: 600; font-size: 13px; white-space: nowrap; }
.snips { background: var(--sf); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
.snips .me { color: var(--tx2); }
mark { background: var(--mark); color: var(--mark-tx); border-radius: 3px; padding: 0 2px; }
.ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.btns { display: flex; gap: 8px; flex-wrap: wrap; }
.btn { min-height: 36px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--ln); background: var(--bg); color: var(--tx); font-size: 13px; font-weight: 600; cursor: pointer; }
.btn.danger { color: var(--danger); }
.btn.solid-danger { background: var(--danger-btn); color: var(--danger-btn-tx); border: 0; }
.btn.solid { background: var(--acc); color: var(--acc-tx); border: 0; }
.btn[disabled] { opacity: .6; cursor: default; }
.more { min-height: 40px; border-radius: 10px; border: 0; background: var(--acc-soft); color: var(--acc-strong); font-size: 13px; font-weight: 600; cursor: pointer; width: 100%; }
.chip { font-size: 12px; padding: 2px 9px; border-radius: 999px; background: var(--sf); color: var(--tx2); }
.chip.bad { background: var(--danger-soft); color: var(--danger); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.ask { background: var(--danger-soft); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.ask.neutral { background: var(--sf); }
.ask label { font-size: 13px; }
.ask input { min-height: 36px; border: 1px solid var(--ln); border-radius: 8px; padding: 0 8px; background: var(--bg); color: var(--tx); max-width: 100%; }
.chat { background: var(--chat-bg); border-radius: 12px; padding: 14px; display: flex; justify-content: flex-end; }
.bubble { max-width: 86%; background: var(--bubble); color: var(--tx); border-radius: 10px 10px 2px 10px; padding: 8px 10px 6px; display: flex; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }
.meta { display: flex; justify-content: flex-end; align-items: center; gap: 4px; font-size: 11px; color: var(--tx3); }
.tick { display: flex; color: var(--tx3); }
.tick.read { color: var(--blue); }
.tick.bad { color: var(--danger); }
.steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.step { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--tx3); min-width: 0; }
.step .bar { height: 4px; border-radius: 4px; background: var(--bar-off); }
.step.on .bar { background: var(--acc); }
.step.now { color: var(--tx); font-weight: 700; }
.note { background: var(--sf); color: var(--tx2); border-radius: 10px; padding: 10px 12px; font-size: 13px; overflow-wrap: anywhere; }
.note.wait { background: var(--wait-bg); color: var(--wait-tx); }
.note.bad { background: var(--danger-soft); color: var(--danger); }
.status { font-size: 13px; color: var(--tx2); overflow-wrap: anywhere; }
.status.bad { color: var(--danger); }
.empty { color: var(--tx3); }
</style>
</head>
<body>
<div id="app"><p class="empty">…</p></div>
<script>
(function () {
  "use strict";
  var app = document.getElementById("app");
  var openai = window.openai || null;
  var host = { locale: "en", timeZone: undefined };
  var state = { card: null, fallback: "", expanded: false, ask: null, busy: null, notes: {}, banner: null };
  // mcp-apps-cards.AVATAR.4 — pictures by chat id: a data: picture, null (none: initials), "asking". Page memory only.
  var pics = {};
  var picsQueued = false;
  var nextId = 1;
  var pending = {};

  // ─── DOM helpers (text only: nothing from the answer becomes markup) ─────
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null && text !== "") node.textContent = String(text);
    return node;
  }
  var ICONS = {
    group: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"></circle><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"></path><circle cx="17" cy="9" r="2.4"></circle><path d="M16 14.4c2.3.1 4 1.6 4.5 4.1"></path></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle><path d="M8 4.8V8l2.2 1.4"></path></svg>',
    one: '<svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 6.5l3.2 3.2L12 2.5"></path></svg>',
    two: '<svg width="18" height="12" viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 6.5l3.2 3.2L11 2.5"></path><path d="M7.4 9.4l.3.3L15.4 2.5"></path></svg>',
    bang: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"></circle><path d="M8 4.6v4.2"></path><path d="M8 11.2v.1"></path></svg>'
  };
  function icon(name, cls, label) {
    var span = el("span", cls || "");
    span.innerHTML = ICONS[name];
    if (label) { span.setAttribute("role", "img"); span.setAttribute("aria-label", label); }
    return span;
  }
  function button(label, cls, onClick, disabled) {
    var b = el("button", "btn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    if (disabled) b.disabled = true;
    b.addEventListener("click", onClick);
    return b;
  }
  function initials(name) {
    var words = String(name || "").replace(/[^\\p{L}\\p{N} ]/gu, " ").trim().split(/\\s+/).filter(Boolean);
    if (!words.length) return "?";
    return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
  }
  var PICTURE = /^data:image\\/(?:jpeg|png|webp);base64,[A-Za-z0-9+\\/]+={0,2}$/;
  // mcp-apps-cards.AVATAR.3-4 — the person's picture when it arrived; initials (or the group icon) until then or
  // when there is none. A picture that fails to draw falls back to initials too.
  function avatar(name, isGroup, chatId) {
    var a = el("div", "avatar");
    var pic = chatId ? pics[chatId] : null;
    var plain = function () { a.textContent = ""; if (isGroup) a.appendChild(icon("group")); else a.textContent = initials(name); };
    if (typeof pic === "string" && PICTURE.test(pic)) {
      var img = el("img");
      img.alt = ""; img.decoding = "async"; img.src = pic;
      img.addEventListener("error", function () { pics[chatId] = null; plain(); });
      a.appendChild(img);
    } else plain();
    if (chatId && pics[chatId] === undefined) wantPicture(chatId);
    return a;
  }
  // mcp-apps-cards.AVATAR.2 — asked after the card is drawn, at most 8 per call, each id once.
  var wanted = [];
  function wantPicture(chatId) {
    if (wanted.indexOf(chatId) < 0) wanted.push(chatId);
    if (picsQueued) return;
    picsQueued = true;
    setTimeout(loadPictures, 0);
  }
  function loadPictures() {
    picsQueued = false;
    var ids = wanted.filter(function (id) { return pics[id] === undefined; }).slice(0, 8);
    wanted = wanted.filter(function (id) { return ids.indexOf(id) < 0 && pics[id] === undefined; });
    if (!ids.length) return;
    ids.forEach(function (id) { pics[id] = "asking"; });
    var done = function (result) {
      var sc = result && typeof result === "object" ? (result.structuredContent || result) : null;
      var got = sc && sc.avatars && typeof sc.avatars === "object" ? sc.avatars : {};
      var any = false;
      ids.forEach(function (id) {
        var pic = got[id];
        if (typeof pic === "string" && PICTURE.test(pic)) { pics[id] = pic; any = true; } else pics[id] = null;
      });
      if (any) render();
      if (wanted.length) wantPicture(wanted[0]);
    };
    var failed = function () { ids.forEach(function (id) { pics[id] = null; }); if (wanted.length) wantPicture(wanted[0]); };
    try { callTool("get_avatars", { ids: ids }).then(function (r) { if (r && r.isError) failed(); else done(r); }, failed); }
    catch (e) { failed(); }
  }
  function firstName(name) {
    var s = String(name || "");
    return /^[+\\d]/.test(s) ? s : s.split(/\\s+/)[0];
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  // ─── Times (the host's locale and time zone when it says them) ─────────
  function dayKey(d) {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: host.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
    catch (e) { return d.toISOString().slice(0, 10); }
  }
  function fmt(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    if (host.timeZone) opts.timeZone = host.timeZone;
    var time;
    try { time = new Intl.DateTimeFormat("en-GB", opts).format(d); } catch (e) { time = d.toISOString().slice(11, 16); }
    var now = new Date();
    var diff = Math.round((Date.parse(dayKey(d)) - Date.parse(dayKey(now))) / 86400000);
    if (diff === 0) return "Today " + time;
    if (diff === -1) return "Yesterday " + time;
    if (diff === 1) return "Tomorrow " + time;
    var dayOpts = Math.abs(diff) < 7 ? { weekday: "short" } : { day: "numeric", month: "short" };
    if (host.timeZone) dayOpts.timeZone = host.timeZone;
    try { return new Intl.DateTimeFormat("en-GB", dayOpts).format(d) + " " + time; } catch (e) { return d.toISOString().slice(0, 16).replace("T", " "); }
  }
  function localInputValue(iso) {
    var d = iso ? new Date(iso) : new Date(Date.now() + 3600000);
    if (isNaN(d.getTime())) d = new Date(Date.now() + 3600000);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // ─── Reading results ───────────────────────────────────────────────────
  function cardOf(result) {
    if (!result || typeof result !== "object") return null;
    var sc = result.structuredContent || result;
    return sc && sc.card && typeof sc.card === "object" && sc.card.kind ? sc.card : null;
  }
  function textOf(result) {
    var content = result && result.content;
    if (!Array.isArray(content)) return "";
    for (var i = 0; i < content.length; i++) if (content[i] && content[i].type === "text" && content[i].text) return String(content[i].text);
    return "";
  }
  function errorWords(result, err) {
    if (err) return (err && err.message) || String(err);
    var t = textOf(result).replace(/^Error:\\s*/, "");
    return t.replace(/\\s*\\(reason: [a-z0-9-]+\\)\\s*$/, "") || "That didn't work.";
  }
  function setResult(result) {
    var card = cardOf(result);
    state.card = card;
    state.fallback = card ? "" : textOf(result).split("\\n")[0].slice(0, 400);
    state.expanded = false; state.ask = null; state.busy = null; state.notes = {}; state.banner = null;
    render();
  }

  // ─── Render ────────────────────────────────────────────────────────────
  function header(title, sub, pill, pillCls, lead) {
    var h = el("div", "head");
    h.appendChild(lead || el("div", "logo", "K"));
    var t = el("div", "titles");
    t.appendChild(el("div", "title", title));
    if (sub) t.appendChild(el("div", "sub", sub));
    h.appendChild(t);
    if (pill) h.appendChild(el("div", "pill " + (pillCls || ""), pill));
    return h;
  }

  function render() {
    app.textContent = "";
    var card = state.card;
    if (!card) {
      var c = el("div", "card");
      c.appendChild(header("Kaption", ""));
      c.appendChild(el("div", state.fallback ? "status" : "empty", state.fallback || "…"));
      app.appendChild(c);
    } else if (card.kind === "search") app.appendChild(renderSearch(card));
    else if (card.kind === "sent") app.appendChild(renderSent(card));
    else if (card.kind === "scheduled") app.appendChild(renderScheduled(card));
    reportSize();
  }

  // mcp-apps-cards.SEARCH.1-6
  function highlight(parent, text, query) {
    var words = String(query || "").toLowerCase().split(/\\s+/).filter(function (w) { return w.length > 1; });
    if (!words.length) { parent.appendChild(document.createTextNode(text)); return; }
    var lower = text.toLowerCase();
    var i = 0;
    while (i < text.length) {
      var best = -1, len = 0;
      for (var w = 0; w < words.length; w++) {
        var at = lower.indexOf(words[w], i);
        if (at >= 0 && (best < 0 || at < best)) { best = at; len = words[w].length; }
      }
      if (best < 0) { parent.appendChild(document.createTextNode(text.slice(i))); break; }
      if (best > i) parent.appendChild(document.createTextNode(text.slice(i, best)));
      parent.appendChild(el("mark", "", text.slice(best, best + len)));
      i = best + len;
    }
  }

  function renderSearch(card) {
    var c = el("div", "card");
    var title = card.total ? plural(card.total, "message", "messages") + " in " + plural(card.chats, "chat", "chats") : "No messages found";
    c.appendChild(header(title, card.query ? "\\u201c" + card.query + "\\u201d" : ""));
    if (state.banner) c.appendChild(el("div", "status" + (state.banner.bad ? " bad" : ""), state.banner.text));
    var groups = card.groups || [];
    var shown = state.expanded ? groups : groups.slice(0, card.first_chats || 3);
    shown.forEach(function (g) { c.appendChild(searchGroup(g, card.query)); });
    var hidden = groups.length - shown.length;
    if (hidden > 0) {
      var count = 0;
      groups.slice(shown.length).forEach(function (g) { count += g.messages.length; });
      var more = el("button", "more", "Show " + plural(count, "more message", "more messages"));
      more.type = "button";
      more.addEventListener("click", function () { state.expanded = true; render(); });
      c.appendChild(more);
    }
    if (card.omitted > 0) c.appendChild(el("div", "muted", plural(card.omitted, "more message isn't", "more messages aren't") + " shown here. Ask to see more."));
    return c;
  }

  function searchGroup(g, query) {
    var box = el("div", "box");
    var row = el("div", "row");
    row.appendChild(avatar(g.name, g.is_group, g.chat_id));
    var mid = el("div", "grow");
    if (g.link) {
      var link = el("button", "name-link", g.name);
      link.type = "button";
      link.title = "Open in WhatsApp";
      link.addEventListener("click", function () { openLink(g.link); });
      mid.appendChild(link);
    } else mid.appendChild(el("div", "name", g.name));
    var sub = g.is_group ? "Group" : (g.chat_id && /^\\d+@c\\.us$/.test(g.chat_id) && g.name.charAt(0) !== "+" ? "+" + g.chat_id.split("@")[0] : "");
    if (sub) mid.appendChild(el("div", "muted", sub));
    row.appendChild(mid);
    var latest = g.messages[0] && g.messages[0].at;
    if (latest) row.appendChild(el("div", "muted right", fmt(latest)));
    box.appendChild(row);
    var snips = el("div", "snips");
    g.messages.slice(0, 3).forEach(function (m) {
      var line = el("div", m.from_me ? "me" : "");
      if (m.sender) line.appendChild(document.createTextNode(m.sender + ": "));
      highlight(line, m.text, query);
      snips.appendChild(line);
    });
    if (g.messages.length > 3) snips.appendChild(el("div", "muted", plural(g.messages.length - 3, "more message", "more messages") + " in this chat"));
    box.appendChild(snips);
    {
      var btns = el("div", "btns");
      btns.appendChild(button("Summarize chat", "", function () { askAssistant("Summarize my WhatsApp chat with " + g.name + "."); }));
      btns.appendChild(button("Draft a reply", "", function () {
        askAssistant("Draft a reply to " + g.name + (query ? " about \\u201c" + query + "\\u201d" : "") + " and put it in the chat's message box in WhatsApp so I can review it before sending.");
      }));
      box.appendChild(btns);
    }
    return box;
  }

  // mcp-apps-cards.SENT.1-6
  var SENT_TITLES = { sent: "Sent", queued: "Waiting to send", sending: "Sending", not_sent: "Not sent" };
  function renderSent(card) {
    var c = el("div", "card");
    var label, cls;
    if (card.status === "sent") { label = card.whatsapp === "read" ? "Read" : card.whatsapp === "delivered" ? "Delivered" : "Sent"; cls = "ok"; }
    else if (card.status === "not_sent") { label = "Not sent"; cls = "bad"; }
    else { label = card.status === "sending" ? "Sending" : "Queued"; cls = "wait"; }
    var title = card.status === "sent" ? "Sent to " + card.to : SENT_TITLES[card.status] || "Message";
    // mcp-apps-cards.AVATAR.3 — the person (or group) the message is for, at the top.
    c.appendChild(header(title, card.status === "sent" ? "From your WhatsApp" : "To " + card.to, label, cls, card.chat_id || card.to ? avatar(card.to, card.is_group, card.chat_id) : null));

    if (card.text || card.attachment) {
      var chat = el("div", "chat");
      var bubble = el("div", "bubble");
      if (card.attachment) bubble.appendChild(el("div", "muted", card.attachment));
      if (card.text) bubble.appendChild(el("div", "", card.text));
      var meta = el("div", "meta");
      var at = card.sent_at || card.expected_at;
      if (at) meta.appendChild(el("span", "", fmt(at)));
      if (card.status === "not_sent") meta.appendChild(icon("bang", "tick bad", "Not sent"));
      else if (card.status !== "sent") meta.appendChild(icon("clock", "tick", "Waiting to send"));
      else if (card.whatsapp === "read") meta.appendChild(icon("two", "tick read", "Read"));
      else if (card.whatsapp === "delivered") meta.appendChild(icon("two", "tick", "Delivered"));
      else meta.appendChild(icon("one", "tick", "Sent"));
      bubble.appendChild(meta);
      chat.appendChild(bubble);
      c.appendChild(chat);
    }

    if (card.status !== "not_sent") {
      var upto = card.status === "sent" ? (card.whatsapp === "read" ? 3 : card.whatsapp === "delivered" ? 2 : 1) : 0;
      var steps = el("div", "steps");
      ["Queued", "Sent", "Delivered", "Read"].forEach(function (name, i) {
        var s = el("div", "step" + (i <= upto ? " on" : "") + (i === upto ? " now" : ""));
        s.appendChild(el("div", "bar"));
        s.appendChild(el("div", "", name));
        steps.appendChild(s);
      });
      c.appendChild(steps);
    }

    var note = sentNote(card);
    if (note) c.appendChild(el("div", "note " + (card.status === "not_sent" ? "bad" : card.status === "sent" ? "" : "wait"), note));
    var notice = state.notes.sent;
    if (notice) c.appendChild(el("div", "status" + (notice.bad ? " bad" : ""), notice.text));

    if (state.ask && state.ask.action === "cancel-sent") {
      var ask = el("div", "ask");
      ask.appendChild(el("div", "", "Cancel this message to " + firstName(card.to) + "? It won't be sent."));
      var ab = el("div", "btns");
      ab.appendChild(button("Keep it", "", function () { state.ask = null; render(); }));
      ab.appendChild(button("Don't send", "solid-danger", function () { cancelSent(card); }, !!state.busy));
      ask.appendChild(ab);
      c.appendChild(ask);
    } else {
      var btns = el("div", "btns");
      if (card.id && card.status !== "not_sent") btns.appendChild(button(state.busy === "check" ? "Checking…" : "Check again", "", function () { checkSent(card); }, !!state.busy));
      if (card.can_cancel) btns.appendChild(button("Don't send", "danger", function () { state.ask = { action: "cancel-sent" }; render(); }, !!state.busy));
      if (card.link) btns.appendChild(button("Open chat", "", function () { openLink(card.link); }));
      if (btns.childNodes.length) c.appendChild(btns);
    }
    return c;
  }

  function sentNote(card) {
    if (card.status === "sent") {
      if (card.whatsapp === "read") return "Read" + (card.sent_at ? " · sent " + fmt(card.sent_at) : "") + ".";
      if (card.whatsapp === "delivered") return "Delivered to their phone" + (card.sent_at ? " at " + fmt(card.sent_at) : "") + ". Not read yet.";
      return "Went out from your WhatsApp" + (card.sent_at ? " at " + fmt(card.sent_at) : "") + ".";
    }
    if (card.status === "queued") {
      var when = card.expected_at ? "Goes at about " + fmt(card.expected_at) + "." : "";
      return [when, card.reason_text || (when ? "" : "Waiting to send.")].filter(Boolean).join(" ") + " Keep this computer and WhatsApp open.";
    }
    if (card.status === "sending") return card.reason_text || "Handed to WhatsApp, waiting for its tick.";
    return card.reason_text || "Nothing was sent.";
  }

  function checkSent(card) {
    state.busy = "check"; state.notes.sent = null; render();
    callTool("get_scheduled_message", { id: card.id, mode: "local" }).then(function (result) {
      state.busy = null;
      var got = cardOf(result);
      var item = got && got.items && got.items[0];
      if (result && result.isError) state.notes.sent = { text: errorWords(result), bad: true };
      else if (item && item.delivery) {
        var was = card.status;
        card.status = item.delivery;
        if (card.status === "sent") { card.whatsapp = card.whatsapp || "sent"; card.sent_at = item.at || card.sent_at; card.expected_at = null; card.reason_text = null; }
        else if (card.status === "queued") { card.expected_at = item.at || card.expected_at; card.reason_text = item.reason_text; }
        else card.reason_text = item.reason_text || (item.status === "canceled" ? "Cancelled." : card.reason_text);
        card.can_cancel = card.status === "queued";
        state.notes.sent = { text: was === card.status ? "No change yet." : "Updated." };
      } else state.notes.sent = { text: "Checked." };
      render();
    }, function (err) { state.busy = null; state.notes.sent = { text: errorWords(null, err), bad: true }; render(); });
  }

  function cancelSent(card) {
    state.busy = "cancel"; render();
    callTool("manage_scheduled_messages", { action: "cancel", mode: "local", id: card.id }).then(function (result) {
      state.busy = null; state.ask = null;
      if (result && result.isError) state.notes.sent = { text: errorWords(result), bad: true };
      else { card.status = "not_sent"; card.can_cancel = false; card.reason_text = "Cancelled. It won't be sent."; state.notes.sent = null; }
      render();
    }, function (err) { state.busy = null; state.ask = null; state.notes.sent = { text: errorWords(null, err), bad: true }; render(); });
  }

  // mcp-apps-cards.SCHEDULED.1-6
  var STATUS_WORDS = { missed: "Missed", failed: "Failed", sent: "Sent", unconfirmed: "Sending", sending: "Sending", canceled: "Cancelled" };
  function renderScheduled(card) {
    var c = el("div", "card");
    var items = card.items || [];
    var title = card.removed && !items.length ? "Scheduled message removed" : !items.length ? "No scheduled messages" : card.single ? "Scheduled message" : plural(card.count, "scheduled message", "scheduled messages");
    c.appendChild(header(title, card.next_at && !card.single ? "Next one " + fmt(card.next_at) : ""));
    if (state.banner) c.appendChild(el("div", "status" + (state.banner.bad ? " bad" : ""), state.banner.text));
    items.forEach(function (it) { c.appendChild(scheduledRow(it)); });
    if (card.omitted > 0) c.appendChild(el("div", "muted", plural(card.omitted, "more isn't", "more aren't") + " shown here. Ask to see them."));
    {
      var more = el("button", "more", "Schedule another");
      more.type = "button";
      more.addEventListener("click", function () { askAssistant("Schedule another WhatsApp message."); });
      c.appendChild(more);
    }
    return c;
  }

  function scheduledRow(it) {
    var asking = state.ask && state.ask.id === it.id ? state.ask : null;
    var box = el("div", "box" + (asking && asking.step === "confirm" && asking.action !== "change" ? " confirming" : ""));
    var row = el("div", "row");
    row.appendChild(avatar(it.name, it.is_group, it.chat_id));
    var mid = el("div", "grow");
    mid.appendChild(el("div", "name", it.name));
    if (it.text) mid.appendChild(el("div", "muted ellipsis", it.text));
    row.appendChild(mid);
    var right = el("div", "right");
    if (it.at) right.appendChild(el("div", "when", fmt(it.at)));
    right.appendChild(el("div", "muted", it.repeat || (it.mode === "bot" ? "Once" : "")));
    row.appendChild(right);
    box.appendChild(row);

    var chips = el("div", "chips");
    chips.appendChild(el("span", "chip", it.mode === "local" ? "From this computer" : it.mode === "bot" ? "Kaption bot" : "WhatsApp"));
    if (STATUS_WORDS[it.status]) chips.appendChild(el("span", "chip" + (it.status === "missed" || it.status === "failed" ? " bad" : ""), STATUS_WORDS[it.status]));
    box.appendChild(chips);
    if (it.reason_text) box.appendChild(el("div", "muted", it.reason_text));
    var note = state.notes[it.id];
    if (note) box.appendChild(el("div", "status" + (note.bad ? " bad" : ""), note.text));

    if (asking) box.appendChild(askPanel(it, asking));
    else if (it.can_send_now || it.can_change || it.can_cancel) {
      var btns = el("div", "btns");
      var busy = !!state.busy;
      if (it.can_send_now) btns.appendChild(button("Send now", "", function () { state.ask = { id: it.id, action: "send_now", step: "confirm" }; render(); }, busy));
      if (it.can_change) btns.appendChild(button("Change time", "", function () { state.ask = { id: it.id, action: "change", step: "pick", value: localInputValue(it.at) }; render(); }, busy));
      if (it.can_cancel) btns.appendChild(button("Cancel", "danger", function () { state.ask = { id: it.id, action: "cancel", step: "confirm" }; render(); }, busy));
      box.appendChild(btns);
    }
    return box;
  }

  function askPanel(it, ask) {
    var who = firstName(it.name);
    var keep = function () { state.ask = null; render(); };
    var busy = state.busy === it.id;
    var p = el("div", "ask" + (ask.action === "cancel" ? "" : " neutral"));
    var btns = el("div", "btns");
    if (ask.action === "change" && ask.step === "pick") {
      var id = "when-" + String(it.id).replace(/[^A-Za-z0-9_-]/g, "");
      var label = el("label", "", "New time for the message to " + who);
      label.setAttribute("for", id);
      var input = el("input");
      input.type = "datetime-local"; input.id = id; input.value = ask.value;
      input.addEventListener("input", function () { ask.value = input.value; });
      p.appendChild(label); p.appendChild(input);
      btns.appendChild(button("Keep it", "", keep));
      btns.appendChild(button("Continue", "solid", function () {
        var d = new Date(ask.value);
        if (!ask.value || isNaN(d.getTime())) { state.notes[it.id] = { text: "Pick a date and time.", bad: true }; render(); return; }
        ask.iso = d.toISOString(); ask.step = "confirm"; state.notes[it.id] = null; render();
      }));
    } else {
      var q = ask.action === "send_now" ? "Send this message to " + who + " now? It goes from your WhatsApp."
        : ask.action === "cancel" ? "Cancel this message to " + who + "? It won't be sent."
        : "Move the message to " + who + " to " + fmt(ask.iso) + "?";
      p.appendChild(el("div", "", q));
      btns.appendChild(button("Keep it", "", keep, busy));
      var go = ask.action === "send_now" ? "Send now" : ask.action === "cancel" ? "Cancel message" : "Change time";
      btns.appendChild(button(busy ? "Working…" : go, ask.action === "cancel" ? "solid-danger" : "solid", function () { runChange(it, ask); }, busy));
    }
    p.appendChild(btns);
    return p;
  }

  function changeArgs(it, ask) {
    if (ask.action === "send_now") return { action: "send_now", mode: "local", id: it.id };
    if (ask.action === "change") return it.mode === "local" ? { action: "update", mode: "local", id: it.id, datetime: ask.iso } : { action: "update", id: it.id, datetime: ask.iso };
    return it.mode === "local" ? { action: "cancel", mode: "local", id: it.id } : { action: "delete", id: it.id };
  }

  function runChange(it, ask) {
    if (state.busy) return;
    state.busy = it.id; state.notes[it.id] = null; render();
    callTool("manage_scheduled_messages", changeArgs(it, ask)).then(function (result) {
      state.busy = null; state.ask = null;
      if (result && result.isError) { state.notes[it.id] = { text: errorWords(result), bad: true }; render(); return; }
      applyChange(it, ask, cardOf(result));
      render();
    }, function (err) { state.busy = null; state.ask = null; state.notes[it.id] = { text: errorWords(null, err), bad: true }; render(); });
  }

  function applyChange(it, ask, got) {
    var card = state.card;
    var fresh = got && got.items && got.items[0];
    var gone = ask.action === "cancel" && (!fresh || fresh.status === "canceled" || (got && got.removed));
    if (gone) {
      card.items = card.items.filter(function (x) { return x.id !== it.id; });
      card.count = Math.max(0, card.count - 1);
      state.banner = { text: "Message to " + it.name + " cancelled." };
      return;
    }
    if (fresh) {
      for (var i = 0; i < card.items.length; i++) if (card.items[i].id === it.id) card.items[i] = fresh;
    }
    state.notes[it.id] = { text: ask.action === "send_now" ? "Sending now." : "Time changed." };
  }

  // ─── Host bridge ───────────────────────────────────────────────────────
  function post(message) {
    if (window.parent && window.parent !== window) window.parent.postMessage(message, "*");
  }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function callTool(name, args) {
    if (openai && typeof openai.callTool === "function") return Promise.resolve(openai.callTool(name, args));
    return request("tools/call", { name: name, arguments: args });
  }
  // mcp-apps-cards.SEARCH.4 — a host that can't take the request: the card says what to type instead.
  function askAssistant(text) {
    if (openai && typeof openai.sendFollowUpMessage === "function") { openai.sendFollowUpMessage({ prompt: text }); return; }
    var failed = function () { state.banner = { text: "Type this in the chat: " + text }; render(); };
    request("ui/message", { role: "user", content: [{ type: "text", text: text }] })
      .then(function (r) { if (r && r.isError) failed(); }, failed);
  }
  function openLink(url) {
    if (openai && typeof openai.openExternal === "function") { openai.openExternal({ href: url }); return; }
    if (window.parent && window.parent !== window) {
      request("ui/open-link", { url: url }).catch(function () { window.open(url, "_blank", "noopener"); });
      return;
    }
    window.open(url, "_blank", "noopener");
  }
  var lastHeight = 0;
  function reportSize() {
    if (openai) return;
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (h === lastHeight) return;
    lastHeight = h;
    notify("ui/notifications/size-changed", { width: Math.ceil(document.documentElement.scrollWidth), height: h });
  }
  var hostVars = [];
  function applyContext(ctx) {
    if (!ctx || typeof ctx !== "object") return;
    var root = document.documentElement;
    var vars = ctx.styles && ctx.styles.variables;
    var themed = ctx.theme === "dark" || ctx.theme === "light";
    // mcp-apps-cards.SHELL.2 — a theme change without the host's new colours drops the old ones (our own palette for
    // that theme takes over), so text never ends up light on light.
    if (themed && ctx.theme !== root.getAttribute("data-theme") && !(vars && typeof vars === "object")) {
      hostVars.forEach(function (k) { root.style.removeProperty(k); });
      hostVars = [];
    }
    if (themed) root.setAttribute("data-theme", ctx.theme);
    if (vars && typeof vars === "object") {
      Object.keys(vars).forEach(function (k) {
        if (/^--[a-z0-9-]+$/.test(k) && typeof vars[k] === "string") { root.style.setProperty(k, vars[k]); if (hostVars.indexOf(k) < 0) hostVars.push(k); }
      });
    }
    if (typeof ctx.locale === "string") host.locale = ctx.locale;
    if (typeof ctx.timeZone === "string") host.timeZone = ctx.timeZone;
    if (state.card) render();
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    if (msg.id != null && !msg.method && pending[msg.id]) {
      var p = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) p.reject(new Error(msg.error.message || "Error")); else p.resolve(msg.result);
      return;
    }
    var params = msg.params || {};
    if (msg.method === "ui/notifications/tool-result") setResult(params);
    else if (msg.method === "ui/notifications/host-context-changed") applyContext(params);
    else if (msg.method === "ui/notifications/tool-cancelled") { state.fallback = "Cancelled."; if (!state.card) render(); }
    else if (msg.method === "ui/resource-teardown" && msg.id != null) post({ jsonrpc: "2.0", id: msg.id, result: {} });
    else if (msg.method === "ping" && msg.id != null) post({ jsonrpc: "2.0", id: msg.id, result: {} });
  });
  if (typeof ResizeObserver === "function") new ResizeObserver(function () { reportSize(); }).observe(document.documentElement);

  if (openai) {
    applyContext({ theme: openai.theme, locale: openai.locale });
    if (openai.toolOutput) setResult({ structuredContent: openai.toolOutput });
    window.addEventListener("openai:set_globals", function (event) {
      var globals = (event && event.detail && event.detail.globals) || {};
      if (globals.theme) applyContext({ theme: globals.theme });
      if (globals.toolOutput) setResult({ structuredContent: globals.toolOutput });
    });
  } else if (window.parent && window.parent !== window) {
    request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "Kaption cards", version: "1.0.0" },
      appCapabilities: {},
    }).then(function (result) {
      applyContext((result && result.hostContext) || {});
      notify("ui/notifications/initialized", {});
    }, function () { notify("ui/notifications/initialized", {}); });
  }
  render();
})();
</script>
</body>
</html>
`;
