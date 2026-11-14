import type { Metadata } from "next";
import { ConnectPanacodeInvalid, ConnectPanacodePage } from "@/components/connect-panacode";

export const metadata: Metadata = {
  title: "اتصال Panacode",
  description: "ورود یک‌کلیکی Panacode و ساخت کلید PanaAI",
  robots: { index: false, follow: false },
};

const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}(\/[\w./\-?]*)?$/i;

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const state = typeof params.state === "string" ? params.state : "";
  const redirectUri = typeof params.redirect_uri === "string"
    ? params.redirect_uri
    : typeof params.redirectUri === "string"
      ? params.redirectUri
      : "";

  if (!/^[A-Za-z0-9._~-]{8,128}$/.test(state)) {
    return <ConnectPanacodeInvalid message="پارامتر state از Panacode نامعتبر یا ناقص است." />;
  }
  if (!LOOPBACK_RE.test(redirectUri)) {
    return <ConnectPanacodeInvalid message="آدرس بازگشت باید روی http://127.0.0.1 یا localhost باشد." />;
  }

  return <ConnectPanacodePage state={state} redirectUri={redirectUri} />;
}
