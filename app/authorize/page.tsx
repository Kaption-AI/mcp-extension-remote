import { Suspense } from "react";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import SignIn from "./SignIn";
import { CONNECT_COOKIE, connectDeps, maskPhone, peekConnectCode } from "@/src/connect-code";
import { hmacVerify } from "@/src/otp";
import type { Env } from "@/src/types";

/** mcp.CONNECT_CODE.5 — the app asking to connect, by the name it registered with (Claude, ChatGPT…), or null. */
async function clientName(env: Env, oauthReqInfo: string): Promise<string | null> {
  try {
    const payload = await hmacVerify(oauthReqInfo, env.INTERNAL_API_KEY);
    if (!payload) return null;
    const request = JSON.parse(atob(payload)) as { clientId?: string };
    if (!request.clientId) return null;
    const client = await env.OAUTH_PROVIDER.lookupClient(request.clientId);
    const name = client?.clientName?.trim();
    return name ? name.slice(0, 60) : null;
  } catch {
    return null;
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

  // mcp.CONNECT_CODE.4 — a code the /connect page remembered on this browser: only its masked phone reaches the page;
  // the code itself stays in the HttpOnly cookie and is spent server-side.
  let rememberedFor: string | null = null;
  let appName: string | null = null;
  try {
    const { env } = getCloudflareContext() as unknown as { env: Env };
    const remembered = (await cookies()).get(CONNECT_COOKIE)?.value;
    if (remembered) {
      const phone = await peekConnectCode(connectDeps(env), remembered);
      rememberedFor = phone ? maskPhone(phone) : null;
    }
    if (oauthReqInfo) appName = await clientName(env, oauthReqInfo);
  } catch {
    rememberedFor = null;
  }

  return (
    <div className="flex items-center justify-center min-h-screen p-5">
      <Suspense
        fallback={
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
            <p className="text-neutral-400">Loading...</p>
          </div>
        }
      >
        <SignIn oauthReqInfo={oauthReqInfo} loginHint={loginHint} rememberedFor={rememberedFor} appName={appName} />
      </Suspense>
    </div>
  );
}
