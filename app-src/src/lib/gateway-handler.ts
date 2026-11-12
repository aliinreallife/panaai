import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { keys, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ApiError, isDemo, limit, verifier } from "@/lib/server";
import { evaluateProvider } from "@/lib/provider";
import { release, reserve, settle } from "@/lib/wallet";
import {
  MODEL_PRICES,
  PROVIDER_STATE_INFO,
  actualCost,
  creditsFromCvcCost,
  estimateTokens,
  liveReservationBound,
  reservationBound,
  systemSettings,
} from "@/lib/rules";
import { MODEL_CATALOG } from "@/lib/shared";
import { cvcLiveDispatchEnabled, proxyCvcJson } from "@/lib/cvc";
import { ensureUserUpstreamKey } from "@/lib/upstream-keys";
import { resolveModelCatalog } from "@/lib/models";
import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";

const MAX_BODY = 256 * 1024;
type Message = { role?: unknown; content?: unknown };
const textLength = (value: unknown): number => typeof value === "string" ? value.length : Array.isArray(value) ? value.reduce((a: number, part) => a + textLength((part as { text?: unknown })?.text ?? part), 0) : 0;

export async function handle(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const headers = (extra: Record<string, string> = {}) => ({ "Cache-Control": "no-store", "X-Request-Id": requestId, ...extra });
  const error = (code: string, message: string, status: number, extra: Record<string, string> = {}) => NextResponse.json({ error: { code, message, request_id: requestId } }, { status, headers: headers(extra) });
  let reserved = false;
  try {
    const authorization = req.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ") || authorization.length > 200) return error("invalid_api_key", "کلید API معتبر ارائه کنید.", 401);
    const [key] = await db.select().from(keys).where(eq(keys.verifier, await verifier(authorization.slice(7)))).limit(1);
    if (!key) return error("invalid_api_key", "کلید API معتبر نیست.", 401);
    if (!key.enabled) return error("key_revoked", "این کلید لغو شده است.", 401);
    const [user] = await db.select().from(users).where(eq(users.id, key.userId)).limit(1);
    if (!user || (!isDemo && user.demo)) return error("invalid_api_key", "کلید API معتبر نیست.", 401);
    if (user.state !== "active") return error("account_suspended", "حساب کاربری این کلید معلق است.", 403);
    await limit(`api-key:${key.id}`, key.rateLimit);
    if (key.budget !== null && key.spent >= key.budget) return error("key_budget_exceeded", "بودجه کلید به پایان رسیده است.", 403);

    const path = (await context.params).path.join("/");
    const live = cvcLiveDispatchEnabled();
    const catalog = await resolveModelCatalog(user.settings);
    const enabledCatalog = catalog.filter(m => user.settings[`model:${m.id}`] !== false && (!key.allowedModels.length || key.allowedModels.includes(m.id)));
    const sandboxModels = MODEL_CATALOG.filter(m => user.settings[`model:${m.id}`] !== false && (!key.allowedModels.length || key.allowedModels.includes(m.id)));

    if (path === "models" && req.method === "GET") {
      const provider = await evaluateProvider(user);
      const admits = provider.admits && (isDemo || live);
      const rows = live ? enabledCatalog : sandboxModels;
      const data = admits ? rows.map(m => ({ id: m.id, object: "model", owned_by: "panaai", created: 0 })) : [];
      return NextResponse.json({ object: "list", data }, { headers: headers() });
    }
    if (!["chat/completions", "responses"].includes(path)) return error("unsupported_endpoint", "این مسیر پشتیبانی نمی‌شود.", 404);
    if (req.method !== "POST") return error("method_not_allowed", "فقط POST پشتیبانی می‌شود.", 405);

    // 1. Admission: provider state machine (fails closed when unverified, zero or paused).
    // Live mode additionally requires CVC credentials + live dispatch readiness.
    const provider = await evaluateProvider(user);
    if (!provider.admits || (!isDemo && !live)) {
      const state = provider.admits && !isDemo && !live ? "unverified" : provider.state;
      return error("service_unavailable", `${PROVIDER_STATE_INFO[state].notice} هیچ اعتباری کسر و هیچ محتوایی ذخیره نشده است.`, 503, { "Retry-After": state === "unverified" ? "3600" : "60" });
    }

    // 2. Validate the request. Content is measured, never stored or logged.
    if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return error("payload_too_large", "حجم درخواست بیش از حد مجاز است.", 413);
    let raw = "";
    let body: { model?: unknown; messages?: unknown; input?: unknown; max_tokens?: unknown; max_output_tokens?: unknown; stream?: unknown };
    try {
      raw = await req.text();
      if (raw.length > MAX_BODY) return error("payload_too_large", "حجم درخواست بیش از حد مجاز است.", 413);
      body = JSON.parse(raw);
    } catch {
      return error("invalid_json", "بدنه JSON معتبر نیست.", 400);
    }
    if (body.stream === true) return error("streaming_not_supported", "پاسخ جریانی هنوز پشتیبانی نمی‌شود؛ stream را false بگذارید.", 400);

    const model = String(body.model || "");
    const synced = catalog.find(m => m.id === model);
    const knownSandbox = !!MODEL_PRICES[model];
    if (live) {
      if (!enabledCatalog.some(m => m.id === model) && !knownSandbox) return error("model_not_found", "مدل درخواستی وجود ندارد.", 404);
      if (key.allowedModels.length && !key.allowedModels.includes(model)) return error("model_not_allowed", "این مدل برای این کلید یا حساب مجاز نیست.", 403);
      if (user.settings[`model:${model}`] === false) return error("model_not_allowed", "این مدل برای این کلید یا حساب مجاز نیست.", 403);
    } else {
      if (!knownSandbox) return error("model_not_found", "مدل درخواستی وجود ندارد.", 404);
      if (!sandboxModels.some(m => m.id === model)) return error("model_not_allowed", "این مدل برای این کلید یا حساب مجاز نیست.", 403);
    }

    const chars = path === "chat/completions"
      ? (Array.isArray(body.messages) ? (body.messages as Message[]).reduce((a, m) => a + textLength(m?.content), 0) : -1)
      : textLength(body.input);
    if (chars < 0 || (path === "chat/completions" && !(body.messages as Message[]).length)) return error("invalid_request", "فیلد messages الزامی است.", 400);
    const maxTokensRaw = body.max_tokens ?? body.max_output_tokens;
    const maxTokens = maxTokensRaw === undefined ? null : Number(maxTokensRaw);
    if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens < 1)) return error("invalid_request", "max_tokens باید عدد صحیح مثبت باشد.", 400);
    const inputTokens = estimateTokens(chars);
    const settings = systemSettings(user.settings);

    // 3. Reserve the worst-case cost (FEFO, row-locked) so concurrent calls cannot overdraw.
    const bound = live
      ? (knownSandbox ? reservationBound(model, inputTokens, maxTokens) : liveReservationBound(inputTokens, maxTokens, synced?.multiplier && synced.multiplier > 0 ? synced.multiplier : 1, settings.creditsPerCvcToken))
      : reservationBound(model, inputTokens, maxTokens);
    await reserve({ userId: user.id, keyId: key.id, requestId, model, amount: bound });
    reserved = true;

    // 4. Dispatch: sandbox simulator, or live upstream proxy when enabled.
    // Each customer wallet gets its own delegated upstream key — never one shared platform key.
    if (live) {
      const upstreamCred = await ensureUserUpstreamKey(user, {
        budgetCredits: key.budget,
        platformKeyId: key.id,
        reason: "first_use",
      });
      const upstream = await proxyCvcJson(path as "chat/completions" | "responses", { ...body, stream: false }, { runtimeKey: upstreamCred.key });
      if (!upstream.ok) {
        await release(requestId);
        reserved = false;
        const retry: Record<string, string> = upstream.retryAfter ? { "Retry-After": String(upstream.retryAfter) } : {};
        if (upstream.status === 401 || upstream.status === 403) {
          logger.error("gateway.upstream_auth", { requestId, code: upstream.code });
          return error("service_unavailable", "سرویس در حال حاضر آماده ارسال درخواست نیست. اعتباری کسر نشد.", 503, { "Retry-After": "3600" });
        }
        if (upstream.status === 402) return error("service_unavailable", "سرویس موقتاً ظرفیت ندارد. اعتباری کسر نشد.", 503, { "Retry-After": retry["Retry-After"] || "60" });
        if (upstream.status === 429) return error("rate_limit_exceeded", "تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.", 429, retry);
        if (upstream.status >= 400 && upstream.status < 500) return error("invalid_request", "درخواست توسط سرویس پذیرفته نشد.", upstream.status);
        return error("service_unavailable", "سرویس در حال حاضر آماده ارسال درخواست نیست. اعتباری کسر نشد.", 503, Object.keys(retry).length ? retry : { "Retry-After": "60" });
      }
      const cost = Math.min(bound, creditsFromCvcCost(upstream.usage.costTokens, settings.creditsPerCvcToken) || (knownSandbox ? actualCost(model, upstream.usage.inputTokens || inputTokens, upstream.usage.outputTokens || 1) : 1));
      const settled = await settle(requestId, cost, {
        keyName: key.name,
        inputTokens: upstream.usage.inputTokens || inputTokens,
        outputTokens: upstream.usage.outputTokens,
        latency: upstream.latencyMs,
        status: "success",
      });
      reserved = false;
      const payload = upstream.body && typeof upstream.body === "object" ? { ...(upstream.body as object), usage: { ...(typeof (upstream.body as { usage?: object }).usage === "object" ? (upstream.body as { usage: object }).usage : {}), platform_credits: settled.settled, reserved_credits: bound } } : upstream.body;
      return NextResponse.json(payload, { headers: headers({ "X-Platform-Credits": String(settled.settled) }) });
    }

    const started = Date.now();
    const outputTokens = Math.min(maxTokens ?? 256, 64 + (inputTokens % 97));
    const content = "این یک پاسخ نمونه از محیط آزمایشی PanaAI است.";
    const latency = Date.now() - started + 180;
    const cost = actualCost(model, inputTokens, outputTokens);
    const settled = await settle(requestId, cost, { keyName: key.name, inputTokens, outputTokens, latency, status: "success" });
    reserved = false;
    const usage = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens, platform_credits: settled.settled, reserved_credits: bound };
    const payload = path === "chat/completions"
      ? { id: requestId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage, sandbox: true }
      : { id: requestId, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }], usage, sandbox: true };
    return NextResponse.json(payload, { headers: headers({ "X-Platform-Credits": String(settled.settled) }) });
  } catch (e) {
    if (reserved) await release(requestId).catch(() => undefined);
    if (e instanceof ApiError) return error(e.code, e.message, e.status, e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {});
    logger.error("gateway.request_failed", { requestId, error: e });
    return error("service_unavailable", "سرویس در حال حاضر آماده ارسال درخواست نیست. اعتباری کسر نشد.", 503);
  }
}
