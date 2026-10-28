import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { accountRefForPhone, e164Digits, InternalRelay } from "./internal-relay";
import { deriveAccountRef } from "./otp";
import { accountRefsForPhone } from "./phone-alias";
import type { Env } from "./types";

const SECRET = "test-phone-ref-secret";
// Synthetic numbers only.
const US = "+15550001234";
const BR_WITH_NINE = "5511987654321";
const BR_WITHOUT_NINE = "551187654321";

function entrypoint(secret = SECRET): InternalRelay {
  return new InternalRelay({} as ExecutionContext, { PHONE_REF_SECRET: secret } as unknown as Env);
}

describe("mcp.CLOUD_RELAY.18 — InternalRelay.accountRefForPhone", () => {
  it("mcp.CLOUD_RELAY.18 — names the same room the relay derives for the phone (with or without +)", async () => {
    const expected = await deriveAccountRef(US, SECRET);
    expect(expected).toMatch(/^acct_[0-9a-f]{64}$/);
    expect(await entrypoint().accountRefForPhone(US)).toBe(expected);
    expect(await entrypoint().accountRefForPhone(US.slice(1))).toBe(expected);
  });

  it("mcp.CLOUD_RELAY.18 — uses the worker's own PHONE_REF_SECRET", async () => {
    const a = await entrypoint("one").accountRefForPhone(US);
    const b = await entrypoint("two").accountRefForPhone(US);
    expect(a).not.toBe(b);
  });

  it("mcp.CLOUD_RELAY.18 — refuses anything that is not an E.164 number", async () => {
    for (const bad of ["", "+", "1234567", "+1234567890123456", "+1 555 000 1234", "555-000-1234", "+1555abc1234", "+(1)5550001234"]) {
      expect(e164Digits(bad)).toBeNull();
      expect(await entrypoint().accountRefForPhone(bad)).toBeNull();
    }
    for (const bad of [undefined, null, 15550001234, { phone: US }]) {
      expect(await entrypoint().accountRefForPhone(bad as unknown as string)).toBeNull();
    }
  });

  it("mcp.CLOUD_RELAY.18 — no secret configured means no reference, never an unkeyed one", async () => {
    expect(await accountRefForPhone(US, "")).toBeNull();
  });

  it("mcp.CLOUD_RELAY.18 / CLOUD_RELAY.17 — a Brazilian mobile keeps its own form's reference (as the extension's room)", async () => {
    const withNine = await entrypoint().accountRefForPhone(BR_WITH_NINE);
    const withoutNine = await entrypoint().accountRefForPhone(`+${BR_WITHOUT_NINE}`);
    expect(withNine).toBe(await deriveAccountRef(BR_WITH_NINE, SECRET));
    expect(withoutNine).toBe(await deriveAccountRef(BR_WITHOUT_NINE, SECRET));
    expect(withNine).not.toBe(withoutNine);
    // Same order as phone-alias: the phone's own reference first.
    expect((await accountRefsForPhone(BR_WITH_NINE, SECRET))[0]).toBe(withNine);
    expect((await accountRefsForPhone(BR_WITHOUT_NINE, SECRET))[0]).toBe(withoutNine);
  });

  it("mcp.CLOUD_RELAY.18 — the deployed bundle exports the entrypoint; no public route reaches it", () => {
    const root = path.resolve(__dirname, "..");
    const wrapper = readFileSync(path.join(root, "scripts/wrap-worker.mjs"), "utf8");
    expect(wrapper).toMatch(/export \{ InternalRelay \} from "\.\.\/src\/index\.ts";/);
    const index = readFileSync(path.join(root, "src/index.ts"), "utf8");
    expect(index).toMatch(/export \{ InternalRelay \} from "\.\/internal-relay";/);
    // Only re-exported: the fetch handler never imports or dispatches to it.
    expect(index.match(/InternalRelay/g)?.length).toBe(1);
  });
});
