/**
 * mcp.CLOUD_RELAY.21 — the text a failed tool call answers with. Claude's and Google's directory reviews reject bare,
 * generic errors, so each relay-level failure says what happened and what the person can do. Messages written by the
 * extension itself (a refusal with its reason code, a plan limit, a bad argument) already say both and pass through.
 */

/** The relay's own failures, matched on the messages relay-room.ts throws. */
const RELAY_FAILURES: Array<{ match: RegExp; text: string }> = [
  {
    match: /^Extension not connected/,
    text:
      "Extension not connected: Kaption is not online for this WhatsApp account. Open WhatsApp Web with the Kaption " +
      "extension (or open the Kaption desktop app), check that Claude and ChatGPT access is turned on in Kaption, then try again.",
  },
  {
    match: /^Extension disconnected/,
    text:
      "Kaption disconnected before it answered (WhatsApp Web was closed or reloaded). Nothing is known about the " +
      "result: check WhatsApp is open with Kaption, then look before retrying a change.",
  },
  {
    match: /^Request timed out after (\d+)s/,
    text:
      "Kaption did not answer within $1 seconds. Keep WhatsApp Web open with Kaption and try again; for a large read, " +
      "ask for fewer results with limit.",
  },
  {
    match: /^Too many pending requests/,
    text: "Too many requests are waiting for Kaption on this account. Wait a few seconds, then try again.",
  },
  {
    match: /^Message too large/,
    text: "The answer was too large to pass on. Ask for fewer results with limit, or a narrower date range.",
  },
];

/** JSON-RPC "method not found": a Kaption version that predates the tool. */
const METHOD_NOT_FOUND = -32601;

export function toolErrorText(tool: string, err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const code = (err as { code?: unknown } | null)?.code;
  if (code === METHOD_NOT_FOUND || /^Method not found|^Unknown (method|tool)/i.test(message)) {
    return `Error: this Kaption version cannot run ${tool} yet. Update the Kaption extension or desktop app, reload WhatsApp Web, then try again.`;
  }
  for (const failure of RELAY_FAILURES) {
    const found = message.match(failure.match);
    if (found) return `Error: ${failure.text.replace("$1", found[1] ?? "")}`;
  }
  if (!message || message === "Extension returned error") {
    return `Error: Kaption could not complete ${tool} and gave no reason. Check WhatsApp Web is open with Kaption and try again.`;
  }
  return `Error: ${message}`;
}

export const NO_ACCOUNT_TEXT =
  "Not signed in: this connection carries no Kaption account. Disconnect Kaption in your assistant's connector " +
  "settings and connect it again with your WhatsApp number.";
