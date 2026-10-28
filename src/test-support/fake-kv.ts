/** Workers KV as the OAuth library uses it, with expirations on the (fakeable) clock. */
export class FakeKV {
  private readonly entries = new Map<string, { value: string; expiration?: number }>();

  private entry(key: string) {
    const entry = this.entries.get(key);
    if (entry?.expiration !== undefined && entry.expiration <= Date.now() / 1000) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string, type?: string | { type?: string }) {
    const entry = this.entry(key);
    if (!entry) return null;
    const kind = typeof type === "string" ? type : type?.type;
    return kind === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options: { expiration?: number; expirationTtl?: number } = {}) {
    const expiration =
      options.expiration ??
      (options.expirationTtl === undefined ? undefined : Math.floor(Date.now() / 1000) + options.expirationTtl);
    this.entries.set(key, { value: String(value), expiration });
  }

  async delete(key: string) {
    this.entries.delete(key);
  }

  async list({ prefix = "", limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const names = [...this.entries.keys()].filter((name) => name.startsWith(prefix) && this.entry(name)).sort();
    const start = Number(cursor ?? 0);
    const end = start + limit;
    return {
      keys: names.slice(start, end).map((name) => ({ name, expiration: this.entries.get(name)?.expiration })),
      list_complete: end >= names.length,
      cursor: end >= names.length ? undefined : String(end),
    };
  }

  json<T = any>(key: string): T | null {
    const entry = this.entry(key);
    return entry ? (JSON.parse(entry.value) as T) : null;
  }

  expirationOf(key: string): number | undefined {
    return this.entry(key)?.expiration;
  }
}
