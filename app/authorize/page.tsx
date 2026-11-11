import { Suspense } from "react";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import SignIn from "./SignIn";
import { CONNECT_COOKIE, connectDeps, maskPhone, peekConnectCode, redirectDestination } from "@/src/connect-code";
import { hmacVerify } from "@/src/otp";
import { classifyWithPolicy, loadRedirectPolicy, type PolicyRedirectKind } from "@/src/redirect-policy";
import { DEFAULT_EXTENSION_IDS } from "./extension-bridge";
import type { Env } from "@/src/types";
import { getServerT } from "../i18n-server";

/**
 * mcp.CONNECT_CODE.5 — the app asking to connect, by the name it registered with (Claude, ChatGPT…), and where signing
 * in sends the person back. Anyone can register an app under any name, so the destination is what tells them apart.
 */
async function clientInfo(env: Env, oauthReqInfo: string): Promise<{ name: string | null; destination: string | null; kind: PolicyRedirectKind | null }> {
  try {
    const payload = await hmacVerify(oauthReqInfo, env.INTERNAL_API_KEY);
    if (!payload) return { name: null, destination: null, kind: null };
    const request = JSON.parse(atob(payload)) as { clientId?: string; redirectUri?: string };
    const destination = redirectDestination(request.redirectUri);
    // mcp.ANY_CLIENT.3 — an unknown website gets only the approval on this computer.
    const kind = classifyWithPolicy(request.redirectUri, await loadRedirectPolicy(env.OAUTH_KV));
    if (!request.clientId) return { name: null, destination, kind };
    const client = await env.OAUTH_PROVIDER.lookupClient(request.clientId);
    const name = client?.clientName?.trim();
    return { name: name ? name.slice(0, 60) : null, destination, kind };
  } catch {
    return { name: null, destination: null, kind: null };
  }
}

/** mcp.ANY_CLIENT.4 — the Kaption extension ids the page may ask (the stores' by default; a preview adds its own). */
function extensionIds(env: Env): string[] {
  const extra = (env.KAPTION_EXTENSION_IDS ?? "").split(",").map((id) => id.trim()).filter((id) => /^[a-p]{32}$/.test(id));
  return [...new Set([...extra, ...DEFAULT_EXTENSION_IDS])];
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const oauthReqInfo =
    typeof params._oauthReqInfo === "string" ? params._oauthReqInfo : "";
  const loginHint =
    typeof params._loginHint === "string" ? params._loginHint : "";
  // mcp.CONNECT_CODE.8 — ?lang=, the kaption_lang cookie /connect set, or Accept-Language.
  const { t } = await getServerT(params.lang);

  // mcp.CONNECT_CODE.4 — a code the /connect page remembered on this browser: only its masked phone reaches the page;
  // the code itself stays in the HttpOnly cookie and is spent server-side.
  let rememberedFor: string | null = null;
  let appName: string | null = null;
  let destination: string | null = null;
  let kind: PolicyRedirectKind | null = null;
  let ids: string[] = DEFAULT_EXTENSION_IDS;
  try {
    const { env } = getCloudflareContext() as unknown as { env: Env };
    const remembered = (await cookies()).get(CONNECT_COOKIE)?.value;
    if (remembered) {
      const phone = await peekConnectCode(connectDeps(env), remembered);
      rememberedFor = phone ? maskPhone(phone) : null;
    }
    ids = extensionIds(env);
    if (oauthReqInfo) ({ name: appName, destination, kind } = await clientInfo(env, oauthReqInfo));
  } catch {
    rememberedFor = null;
  }

  return (
    <div className="flex items-center justify-center min-h-screen p-5">
      <Suspense
        fallback={
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
            <p className="text-neutral-400">{t("common.loading")}</p>
          </div>
        }
      >
        <SignIn oauthReqInfo={oauthReqInfo} loginHint={loginHint} rememberedFor={rememberedFor} appName={appName} destination={destination} kind={kind} extensionIds={ids} />
      </Suspense>
    </div>
  );
}
