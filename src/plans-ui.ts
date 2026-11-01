/**
 * mcp-manage-kaption.UI.1-3 — the MCP Apps page for kaption_plans (ui://kaption/plans.html).
 *
 * It holds no prices and no text of its own beyond fallbacks: it draws the tool result's structuredContent (the
 * extension's kaption_plans list answer, already in the account's language). A card's button calls
 * create_kaption_checkout_link through the host (MCP Apps JSON-RPC over postMessage, or window.openai on ChatGPT) and opens the link.
 * Inline CSS and JS only; nothing is loaded from elsewhere.
 *
 * Kept identical in the local hub (kaption-mcp/src/plansUi.ts) and the cloud relay (kaption-mcp-remote/src/plans-ui.ts);
 * tools-parity.test.ts compares them.
 */

export const PLANS_UI_MIME_TYPE = 'text/html;profile=mcp-app';

export const PLANS_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kaption plans</title>
<style>
:root {
  --bg: #ffffff; --card: #f7f7f8; --text: #16181d; --muted: #5d6270; --line: #e2e4e9;
  --accent: #1f7a5c; --accent-text: #ffffff; --badge: #e3f3ec; --badge-text: #17604a; --current: #eef1f6;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #15171b; --card: #1f2228; --text: #eceef2; --muted: #a2a8b5; --line: #2f333b;
    --accent: #3fb68b; --accent-text: #0d1512; --badge: #1d3a30; --badge-text: #8fe0bf; --current: #262a32;
  }
}
:root[data-theme="dark"] {
  --bg: #15171b; --card: #1f2228; --text: #eceef2; --muted: #a2a8b5; --line: #2f333b;
  --accent: #3fb68b; --accent-text: #0d1512; --badge: #1d3a30; --badge-text: #8fe0bf; --current: #262a32;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 16px; }
h1 { font-size: 17px; margin: 0 0 12px; }
.periods { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 3px; border: 1px solid var(--line); border-radius: 999px; margin-bottom: 14px; }
.periods button { border: 0; background: transparent; color: var(--muted); padding: 6px 12px; border-radius: 999px; font: inherit; cursor: pointer; }
.periods button[aria-pressed="true"] { background: var(--accent); color: var(--accent-text); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.card.recommended { border-color: var(--accent); }
.card.current { background: var(--current); }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.name { font-weight: 650; font-size: 15px; }
.badge { background: var(--badge); color: var(--badge-text); font-size: 12px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.price { font-size: 22px; font-weight: 700; }
.price small { font-size: 13px; font-weight: 400; color: var(--muted); }
.total, .trial, .note, .hl-label { color: var(--muted); font-size: 13px; }
ul { margin: 0; padding-left: 18px; }
li { margin: 2px 0; overflow-wrap: anywhere; }
.highlights li { font-weight: 550; }
.spacer { flex: 1; }
.card button.go { border: 0; border-radius: 10px; padding: 9px 12px; background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer; }
.card button.go[disabled] { opacity: .6; cursor: default; }
.foot { color: var(--muted); font-size: 12px; margin-top: 14px; }
.status { margin-top: 10px; font-size: 13px; overflow-wrap: anywhere; }
.status a { color: var(--accent); }
.empty { color: var(--muted); }
</style>
</head>
<body>
<div id="app"><p class="empty">…</p></div>
<script>
(function () {
  "use strict";
  var state = { data: null, period: null, busy: null, status: null };
  var app = document.getElementById("app");
  var openai = window.openai || null;
  var nextId = 1;
  var pending = {};

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null && text !== "") node.textContent = String(text);
    return node;
  }

  // The answer of kaption_plans "list": structuredContent, the relay's {result: ...} envelope, or the text content.
  function answerOf(result) {
    if (!result || typeof result !== "object") return null;
    var sc = result.structuredContent || result;
    if (sc && Array.isArray(sc.plans)) return sc;
    if (sc && sc.result && typeof sc.result === "object") return answerOf(sc.result);
    var content = result.content;
    if (Array.isArray(content)) {
      for (var i = 0; i < content.length; i++) {
        if (content[i] && content[i].type === "text") {
          try { var parsed = JSON.parse(content[i].text); if (parsed && typeof parsed === "object") return parsed.result && !parsed.plans ? parsed.result : parsed; } catch (e) {}
        }
      }
    }
    return sc && typeof sc === "object" ? sc : null;
  }

  function setData(data) {
    if (!data || !Array.isArray(data.plans)) return;
    state.data = data;
    var periods = Array.isArray(data.periods) ? data.periods : [];
    if (!state.period || periods.indexOf(state.period) < 0) {
      state.period = periods.indexOf(data.default_period) >= 0 ? data.default_period : periods[0] || null;
    }
    render();
  }

  function setTheme(theme) {
    if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);
  }

  function render() {
    var data = state.data;
    app.textContent = "";
    if (!data) { app.appendChild(el("p", "empty", "…")); return; }
    var labels = data.labels || {};
    var periodLabels = labels.periods || {};
    if (labels.title) app.appendChild(el("h1", "", labels.title));

    var periods = Array.isArray(data.periods) ? data.periods : [];
    if (periods.length > 1) {
      var switcher = el("div", "periods");
      switcher.setAttribute("role", "group");
      periods.forEach(function (p) {
        var b = el("button", "", periodLabels[p] || p);
        b.type = "button";
        b.setAttribute("aria-pressed", p === state.period ? "true" : "false");
        b.addEventListener("click", function () { state.period = p; render(); });
        switcher.appendChild(b);
      });
      app.appendChild(switcher);
    }

    var cards = el("div", "cards");
    data.plans.forEach(function (plan) { cards.appendChild(card(plan, labels)); });
    app.appendChild(cards);

    if (state.status) {
      var status = el("div", "status");
      if (state.status.message) status.appendChild(el("span", "", state.status.message + (state.status.url ? " " : "")));
      if (state.status.url) {
        var a = el("a", "", state.status.url);
        a.href = state.status.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.addEventListener("click", function (ev) { ev.preventDefault(); openLink(state.status.url); });
        status.appendChild(a);
      }
      app.appendChild(status);
    }
    if (labels.pay_note) app.appendChild(el("p", "foot", labels.pay_note));
    reportSize();
  }

  function card(plan, labels) {
    var c = el("div", "card " + (plan.state || ""));
    var head = el("div", "head");
    head.appendChild(el("span", "name", plan.name || plan.id));
    if (plan.badge) head.appendChild(el("span", "badge", plan.badge));
    c.appendChild(head);

    var price = plan.prices && state.period ? plan.prices[state.period] : null;
    if (price && price.per_month) {
      var p = el("div", "price", price.per_month);
      if (labels.per_month) p.appendChild(el("small", "", " " + labels.per_month));
      c.appendChild(p);
    }
    if (price && price.total) c.appendChild(el("div", "total", price.total));
    if (plan.trial) c.appendChild(el("div", "trial", plan.trial));

    if (Array.isArray(plan.highlights) && plan.highlights.length) {
      if (plan.highlights_label) c.appendChild(el("div", "hl-label", plan.highlights_label));
      var hl = el("ul", "highlights");
      plan.highlights.forEach(function (h) { hl.appendChild(el("li", "", h)); });
      c.appendChild(hl);
    }
    if (Array.isArray(plan.features) && plan.features.length) {
      var fl = el("ul", "features");
      plan.features.forEach(function (f) { fl.appendChild(el("li", "", f)); });
      c.appendChild(fl);
    }
    c.appendChild(el("div", "spacer"));
    if (plan.checkout) {
      var b = el("button", "go", plan.button || "Subscribe");
      b.type = "button";
      if (state.busy) b.disabled = true;
      b.addEventListener("click", function () { checkout(plan); });
      c.appendChild(b);
      if (plan.note) c.appendChild(el("div", "note", plan.note));
    } else if (plan.note) {
      c.appendChild(el("div", "note", plan.note));
    }
    return c;
  }

  function checkout(plan) {
    if (state.busy) return;
    state.busy = plan.id;
    state.status = null;
    render();
    var args = { plan: plan.id, period: state.period || "yearly" };
    callTool("create_kaption_checkout_link", args).then(function (result) {
      var answer = answerOf(result) || {};
      state.busy = null;
      state.status = { message: answer.message || (result && result.isError ? textOf(result) : ""), url: answer.url || null };
      render();
      if (answer.url) openLink(answer.url);
    }, function (err) {
      state.busy = null;
      state.status = { message: (err && err.message) || String(err), url: null };
      render();
    });
  }

  function textOf(result) {
    var content = result && result.content;
    return Array.isArray(content) && content[0] && content[0].text ? String(content[0].text) : "";
  }

  // ─── Host bridge ────────────────────────────────────────────────────
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

  function notify(method, params) {
    post({ jsonrpc: "2.0", method: method, params: params || {} });
  }

  function callTool(name, args) {
    if (openai && typeof openai.callTool === "function") return Promise.resolve(openai.callTool(name, args));
    return request("tools/call", { name: name, arguments: args });
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
    if (msg.method === "ui/notifications/tool-result") setData(answerOf(params));
    else if (msg.method === "ui/notifications/host-context-changed") setTheme(params.theme);
    else if (msg.method === "ui/resource-teardown" && msg.id != null) post({ jsonrpc: "2.0", id: msg.id, result: {} });
    else if (msg.method === "ping" && msg.id != null) post({ jsonrpc: "2.0", id: msg.id, result: {} });
  });

  if (openai) {
    setTheme(openai.theme);
    if (openai.toolOutput) setData(answerOf(openai.toolOutput));
    window.addEventListener("openai:set_globals", function (event) {
      var globals = (event && event.detail && event.detail.globals) || {};
      if (globals.theme) setTheme(globals.theme);
      if (globals.toolOutput) setData(answerOf(globals.toolOutput));
    });
  } else if (window.parent && window.parent !== window) {
    request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "Kaption plans", version: "1.0.0" },
      appCapabilities: {},
    }).then(function (result) {
      var ctx = (result && result.hostContext) || {};
      setTheme(ctx.theme);
      notify("ui/notifications/initialized", {});
    }, function () { notify("ui/notifications/initialized", {}); });
  }
  render();
})();
</script>
</body>
</html>
`;
