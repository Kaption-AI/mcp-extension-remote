/**
 * mcp.ANY_CLIENT.4, .6 — the sign-in page talking to the Kaption extension in this browser. Chrome lets only pages on
 * the connector's origin reach it (the extension's externally_connectable), and the extension checks the origin
 * again. The page hands over only the approval id it has just created itself (ANY_CLIENT.6).
 */

/** The Kaption extension in the Chrome Web Store and in Edge Add-ons. */
export const DEFAULT_EXTENSION_IDS = ["iinbhdejcemjafkabjokgeaffgnmijbh", "gdgohknecjblcncbokbhpaebebmeiidk"];

export const PING_TYPE = "kaption.mcp.ping";
export const APPROVE_TYPE = "kaption.mcp.approve";

type SendMessage = (id: string, message: unknown, callback: (reply: unknown) => void) => void;

interface ChromeLike {
  runtime?: { sendMessage?: SendMessage; lastError?: unknown };
}

function chromeRuntime(): ChromeLike["runtime"] | undefined {
  return (globalThis as unknown as { chrome?: ChromeLike }).chrome?.runtime;
}

function send(id: string, message: unknown, timeoutMs: number): Promise<unknown> {
  const runtime = chromeRuntime();
  if (!runtime?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      runtime.sendMessage!(id, message, (reply) => {
        clearTimeout(timer);
        // Reading lastError keeps Chrome from logging "Unchecked runtime.lastError" for an id that isn't installed.
        void runtime.lastError;
        resolve(reply ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** mcp.ANY_CLIENT.4 — the id of the Kaption extension that answers in this browser, or null (1.5 s). */
export async function findExtension(ids: string[], timeoutMs = 1500): Promise<string | null> {
  if (!chromeRuntime()?.sendMessage) return null;
  const replies = await Promise.all(ids.map(async (id) => ({ id, reply: await send(id, { type: PING_TYPE }, timeoutMs) })));
  const found = replies.find(({ reply }) => !!reply && typeof reply === "object" && (reply as { kaption?: unknown }).kaption === true);
  return found?.id ?? null;
}

export type HandOffResult = { ok: true } | { ok: false; reason: string };

/** mcp.ANY_CLIENT.6-7 — ask the extension to show the approval for this id. */
export async function handOffToExtension(extensionId: string, requestId: string): Promise<HandOffResult> {
  const reply = (await send(extensionId, { type: APPROVE_TYPE, requestId }, 5000)) as { ok?: unknown; reason?: unknown } | null;
  if (reply && reply.ok === true) return { ok: true };
  return { ok: false, reason: typeof reply?.reason === "string" ? reply.reason : "no_answer" };
}
