import { Suspense } from "react";
import PhoneForm from "./PhoneForm";

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

  return (
    <div className="flex items-center justify-center min-h-screen p-5">
      <Suspense
        fallback={
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 max-w-[400px] w-full">
            <p className="text-neutral-400">Loading...</p>
          </div>
        }
      >
        <PhoneForm oauthReqInfo={oauthReqInfo} loginHint={loginHint} />
      </Suspense>
    </div>
  );
}
