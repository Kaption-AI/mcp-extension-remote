/** mcp.ANY_CLIENT.5 — the cookie that binds an approval request to the browser that started it (one per request). */
export const approvalCookieName = (id: string) => `kaption_approval_${id.slice(0, 16)}`;
