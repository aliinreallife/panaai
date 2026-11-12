import "server-only";
import { ApiError } from "@/lib/server";
import { logger } from "@/lib/logger";

const BASE = "https://api.kavenegar.com/v1";

export type KavenegarLookupResult = {
  messageId: string;
  costRial: number;
  status: number;
  statusText: string;
  receptor: string;
};

export function kavenegarConfigured() {
  return Boolean(process.env.KAVENEGAR_API_KEY?.trim() && process.env.KAVENEGAR_OTP_TEMPLATE?.trim());
}

function apiKey() {
  const key = process.env.KAVENEGAR_API_KEY?.trim();
  if (!key) throw new ApiError("sms_not_configured", "ارسال پیامک پیکربندی نشده است.", 503);
  return key;
}

function template() {
  const name = process.env.KAVENEGAR_OTP_TEMPLATE?.trim();
  if (!name) throw new ApiError("sms_not_configured", "الگوی پیامک OTP تنظیم نشده است.", 503);
  return name;
}

/** Send OTP via Kavenegar Verify Lookup. Cost is returned in IRR (rial). */
export async function sendLookupOtp(phone: string, token: string): Promise<KavenegarLookupResult> {
  const receptor = phone.replace(/\s+/g, "");
  if (!/^09\d{9}$/.test(receptor)) throw new ApiError("invalid_phone", "شماره موبایل معتبر نیست.");
  if (!/^\d{4,10}$/.test(token)) throw new ApiError("invalid_otp", "کد تأیید معتبر نیست.");

  const url = new URL(`${BASE}/${apiKey()}/verify/lookup.json`);
  url.searchParams.set("receptor", receptor);
  url.searchParams.set("token", token);
  url.searchParams.set("template", template());
  url.searchParams.set("type", "sms");

  let response: Response;
  try {
    response = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(15000) });
  } catch (error) {
    logger.error("kavenegar.fetch_failed", { error });
    throw new ApiError("sms_unreachable", "ارسال پیامک ممکن نشد. چند لحظه دیگر دوباره تلاش کنید.", 503);
  }

  let payload: { return?: { status?: number; message?: string }; entries?: Array<Record<string, unknown>> | Record<string, unknown> } = {};
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("sms_invalid_response", "پاسخ سرویس پیامک قابل خواندن نیست.", 502);
  }

  const status = Number(payload.return?.status ?? response.status);
  if (!response.ok || status !== 200) {
    logger.warn("kavenegar.lookup_rejected", { status, message: payload.return?.message });
    const map: Record<number, string> = {
      418: "اعتبار حساب پیامک کافی نیست.",
      422: "کد تأیید برای ارسال مناسب نیست.",
      424: "الگوی پیامک پیدا نشد یا هنوز تأیید نشده است.",
      426: "سرویس اعتبارسنجی پیامک فعال نیست.",
      431: "ساختار کد تأیید برای پیامک معتبر نیست.",
      432: "الگوی پیامک باید شامل token باشد.",
    };
    throw new ApiError("sms_send_failed", map[status] || payload.return?.message || "ارسال پیامک ناموفق بود.", status >= 400 && status < 600 ? status : 502);
  }

  const entry = Array.isArray(payload.entries) ? payload.entries[0] : payload.entries;
  if (!entry || typeof entry !== "object") throw new ApiError("sms_invalid_response", "سرویس پیامک نتیجهٔ ارسال برنگرداند.", 502);

  const costRial = Math.max(0, Number((entry as { cost?: unknown }).cost) || 0);
  const messageId = String((entry as { messageid?: unknown }).messageid ?? "");
  return {
    messageId,
    costRial,
    status: Number((entry as { status?: unknown }).status) || 0,
    statusText: String((entry as { statustext?: unknown }).statustext ?? ""),
    receptor: String((entry as { receptor?: unknown }).receptor ?? receptor),
  };
}
