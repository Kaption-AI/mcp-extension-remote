import { Suspense } from "react";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import SignIn from "./SignIn";
import { CONNECT_COOKIE, connectDeps, maskPhone, peekConnectCode, redirectDestination } from "@/src/connect-code";
import { hmacVerify } from "@/src/otp";
import type { Env } from "@/src/types";
import { getServerT } from "../i18n-server";

/**
 * mcp.CONNECT_CODE.5 — the app asking to connect, by the name it registered with (Claude, ChatGPT…), and where signing
 * in sends the person back. Anyone can register an app under any name, so the destination is what tells them apart.
 */
async function clientInfo(env: Env, oauthReqInfo: string): Promise<{ name: string | null; destination: string | null }> {
  try {
    const payload = await hmacVerify(oauthReqInfo, env.INTERNAL_API_KEY);
    if (!payload) return { name: null, destination: null };
    const request = JSON.parse(atob(payload)) as { clientId?: string; redirectUri?: string };
    const destination = redirectDestination(request.redirectUri);
    if (!request.clientId) return { name: null, destination };
    const client = await env.OAUTH_PROVIDER.lookupClient(request.clientId);
    const name = client?.clientName?.trim();
    return { name: name ? name.slice(0, 60) : null, destination };
  } catch {
    return { name: null, destination: null };
  }
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
  try {
    const { env } = getCloudflareContext() as unknown as { env: Env };
    const remembered = (await cookies()).get(CONNECT_COOKIE)?.value;
    if (remembered) {
      const phone = await peekConnectCode(connectDeps(env), remembered);
      rememberedFor = phone ? maskPhone(phone) : null;
    }
    if (oauthReqInfo) ({ name: appName, destination } = await clientInfo(env, oauthReqInfo));
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
        <SignIn oauthReqInfo={oauthReqInfo} loginHint={loginHint} rememberedFor={rememberedFor} appName={appName} destination={destination} />
      </Suspense>
    </div>
  );
}
