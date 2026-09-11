/**
 * How long an AI app may stay connected — the choices a person picks from on
 * the consent page (mcp.CLOUD_RELAY.9). Shared by that client-side page and
 * the Worker, so this module imports nothing.
 */
export const CONNECTION_LIFETIMES = ["inactive-90d", "fixed-1y", "until-revoked"] as const;

export type ConnectionLifetime = (typeof CONNECTION_LIFETIMES)[number];

/** Preselected on the consent page, and applied to connections that never chose. */
export const DEFAULT_CONNECTION_LIFETIME: ConnectionLifetime = "inactive-90d";

export const IDLE_LIMIT_DAYS = 90;

export const FIXED_LIFETIME_DAYS = 365;

/** Unknown or missing values fall back to the default rather than failing. */
export function parseConnectionLifetime(value: unknown): ConnectionLifetime {
  return typeof value === "string" && (CONNECTION_LIFETIMES as readonly string[]).includes(value)
    ? (value as ConnectionLifetime)
    : DEFAULT_CONNECTION_LIFETIME;
}
