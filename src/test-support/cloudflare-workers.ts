/**
 * Test stand-in for the Workers runtime module, which only exists inside
 * workerd. The OAuth library and the Durable Objects import these classes;
 * vitest.config.ts points `cloudflare:workers` here.
 */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    public ctx?: unknown,
    public env?: Env,
  ) {}
}

export class DurableObject<Env = unknown> {
  constructor(
    public ctx?: unknown,
    public env?: Env,
  ) {}
}
