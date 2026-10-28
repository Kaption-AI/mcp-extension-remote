/**
 * mcp.CLOUD_RELAY.19 — several WhatsApp numbers in one AI app.
 *
 * A connection (OAuth grant) belongs to one WhatsApp number, and AI apps keep one connection per server address: adding
 * https://mcp.kaptionai.com/mcp again for a second number either is refused as a duplicate or replaces the first
 * number's sign-in (#10002290). Each number therefore gets its own address — the same server with a label that
 * differs per number — and its own connector, signed in with that number. The label carries only the last four digits
 * the sign-in page already shows; it grants nothing (mcp.CLOUD_RELAY.20), and the relay treats every such address as
 * its one resource (mcp.CLOUD_RELAY.18).
 *
 * Kept free of server imports: the /connect page (a client component) uses it.
 */
export function connectorAddress(origin: string, maskedPhone: string | null | undefined): string {
  const last4 = (maskedPhone ?? "").replace(/\D/g, "").slice(-4);
  return last4.length === 4 ? `${origin}/mcp?account=${last4}` : `${origin}/mcp`;
}
