/**
 * CheapVibeCode reseller API client (contract from reseller-api-agent.md).
 *
 * Architecture for this MVP:
 * - PanaAI keeps its own customer wallet, FEFO lots and platform API keys.
 * - One platform CVC key (`CVC_PRIMARY_API_KEY`) is enough: it can manage keys
 *   and call balance/models/runtime. An optional `CVC_RUNTIME_API_KEY` may
 *   override the key used for balance/models/dispatch if you later split roles.
 * - Live inference stays fail-closed until dispatch is explicitly enabled and
 *   metering against CVC `cost_tokens` is verified.
 *
 * Do not append `/v1` to CVC_BASE_URL; every path already includes it.
 */

export const CVC_DEFAULT_BASE_URL = "https://ru.cheapvibecode.ru";

export type CvcConfig = {
  baseUrl: string;
  primaryKey: string | null;
  /** Key used for balance/models/runtime (primary unless a runtime override is set). */
  runtimeKey: string | null;
  /** Legacy override: full URL used instead of `${baseUrl}/v1/balance`. */
  legacyBalanceUrl: string | null;
  legacyApiKey: string | null;
};

export function cvcConfig(env: NodeJS.ProcessEnv = process.env): CvcConfig {
  const trim = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  const base = trim(env.CVC_BASE_URL) ?? CVC_DEFAULT_BASE_URL;
  const primaryKey = trim(env.CVC_PRIMARY_API_KEY);
  return {
    baseUrl: base.replace(/\/+$/, ""),
    primaryKey,
    // One key is enough: primary covers catalog, balance and management.
    runtimeKey: trim(env.CVC_RUNTIME_API_KEY) ?? trim(env.CVC_API_KEY) ?? primaryKey,
    legacyBalanceUrl: trim(env.CVC_BALANCE_URL),
    legacyApiKey: trim(env.CVC_API_KEY) ?? primaryKey,
  };
}

/** True when a live balance source can be called. */
export function cvcBalanceConfigured(cfg: CvcConfig = cvcConfig()): boolean {
  if (cfg.legacyBalanceUrl && cfg.legacyApiKey) return true;
  return !!cfg.runtimeKey;
}

export function cvcBalanceUrl(cfg: CvcConfig = cvcConfig()): string {
  if (cfg.legacyBalanceUrl) return cfg.legacyBalanceUrl;
  return `${cfg.baseUrl}/v1/balance`;
}

export function cvcModelsUrl(cfg: CvcConfig = cvcConfig()): string {
  return `${cfg.baseUrl}/v1/models`;
}

export function redactSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 12) return `${value.slice(0, 4)}…`;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/**
 * Parse a balance observation from CVC.
 * Prefer integer token fields documented for the account; accept a few common shapes
 * so a verified live response can land without another code change.
 */
export function parseCvcBalance(body: unknown): number | null {
  if (body == null || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const candidates: unknown[] = [
    root.balance,
    root.tokens,
    root.available_tokens,
    root.availableTokens,
    root.token_balance,
    root.remaining_tokens,
  ];
  if (root.balance && typeof root.balance === "object") {
    const nested = root.balance as Record<string, unknown>;
    candidates.push(nested.tokens, nested.available, nested.amount, nested.balance);
  }
  if (root.data && typeof root.data === "object") {
    const data = root.data as Record<string, unknown>;
    candidates.push(data.balance, data.tokens, data.available_tokens);
  }
  for (const value of candidates) {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    if (Number.isSafeInteger(n) && n >= 0) return n;
  }
  return null;
}

export type CvcModel = {
  id: string;
  object?: string;
  owned_by?: string;
  multiplier?: number | null;
  base_multiplier?: number | null;
  claude_provider?: string | null;
};

/** Extract OpenAI-style model list rows; ignore unknown fields. */
export function parseCvcModels(body: unknown): CvcModel[] {
  if (body == null || typeof body !== "object") return [];
  const root = body as Record<string, unknown>;
  const list = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : Array.isArray(body) ? body : [];
  const out: CvcModel[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    out.push({
      id,
      object: typeof item.object === "string" ? item.object : undefined,
      owned_by: typeof item.owned_by === "string" ? item.owned_by : undefined,
      multiplier: num(item.multiplier),
      base_multiplier: num(item.base_multiplier),
      claude_provider: typeof item.claude_provider === "string" ? item.claude_provider : null,
    });
  }
  return out;
}

export type CvcFetchResult<T> =
  | { ok: true; status: number; data: T; source: string }
  | { ok: false; status: number; source: string; code?: string; message?: string };

async function cvcFetchJson(url: string, key: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(init.headers || {}),
    },
    signal: init.signal ?? AbortSignal.timeout(8000),
    cache: "no-store",
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const err = (body as { error?: { code?: unknown } }).error;
  return err && typeof err.code === "string" ? err.code : undefined;
}

function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const err = (body as { error?: { message?: unknown } }).error;
  return err && typeof err.message === "string" ? err.message : undefined;
}

/** GET /v1/balance (or legacy CVC_BALANCE_URL) with the runtime customer key. */
export async function fetchCvcBalance(cfg: CvcConfig = cvcConfig()): Promise<CvcFetchResult<number>> {
  const key = cfg.legacyBalanceUrl ? cfg.legacyApiKey : cfg.runtimeKey;
  const source = cfg.legacyBalanceUrl ? "cvc_legacy_balance_url" : "cvc_balance";
  if (!key) return { ok: false, status: 0, source: "not_configured", code: "not_configured" };
  try {
    const { status, body } = await cvcFetchJson(cvcBalanceUrl(cfg), key);
    if (status === 401 || status === 403) return { ok: false, status, source, code: errorCode(body) ?? "auth_failed", message: errorMessage(body) };
    if (status === 429 || status === 503) return { ok: false, status, source, code: errorCode(body) ?? "transient", message: errorMessage(body) };
    if (status < 200 || status >= 300) return { ok: false, status, source, code: errorCode(body) ?? "http_error", message: errorMessage(body) };
    const balance = parseCvcBalance(body);
    if (balance === null) return { ok: false, status, source: "cvc_invalid_response", code: "invalid_balance_shape" };
    return { ok: true, status, data: balance, source };
  } catch {
    return { ok: false, status: 0, source: "cvc_unreachable", code: "network_error" };
  }
}

/** GET /v1/models with the runtime customer key. Admin/sync only — never expose upstream names to customers. */
export async function fetchCvcModels(cfg: CvcConfig = cvcConfig()): Promise<CvcFetchResult<CvcModel[]>> {
  if (!cfg.runtimeKey) return { ok: false, status: 0, source: "not_configured", code: "not_configured" };
  try {
    const { status, body } = await cvcFetchJson(cvcModelsUrl(cfg), cfg.runtimeKey);
    if (status < 200 || status >= 300) return { ok: false, status, source: "cvc_models", code: errorCode(body) ?? "http_error", message: errorMessage(body) };
    return { ok: true, status, data: parseCvcModels(body), source: "cvc_models" };
  } catch {
    return { ok: false, status: 0, source: "cvc_unreachable", code: "network_error" };
  }
}

/** True when the gateway should forward to CVC instead of the sandbox simulator. */
export function cvcLiveDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CVC_LIVE_DISPATCH === "true") return cvcBalanceConfigured(cvcConfig(env));
  return env.PLATFORM_MODE === "live" && cvcBalanceConfigured(cvcConfig(env));
}

export type CvcUsage = { inputTokens: number; outputTokens: number; costTokens: number };

/** Pull usage / cost_tokens from an OpenAI-style or CVC response body. */
export function parseCvcUsage(body: unknown): CvcUsage {
  if (!body || typeof body !== "object") return { inputTokens: 0, outputTokens: 0, costTokens: 0 };
  const root = body as Record<string, unknown>;
  const usage = (root.usage && typeof root.usage === "object" ? root.usage : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const inputTokens = num(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = num(usage.completion_tokens ?? usage.output_tokens);
  const costTokens = num(usage.cost_tokens ?? usage.total_tokens ?? (inputTokens + outputTokens));
  return { inputTokens, outputTokens, costTokens };
}

export type CvcProxyResult =
  | { ok: true; status: number; body: unknown; usage: CvcUsage; latencyMs: number }
  | { ok: false; status: number; code: string; message: string; retryAfter?: number; body?: unknown };

/**
 * Forward a non-streaming OpenAI-compatible JSON body to CVC.
 * Streaming is rejected by the gateway before this is called (settlement needs a final cost).
 * `runtimeKey` must be the customer's delegated upstream key — never share one platform key across wallets.
 */
export async function proxyCvcJson(
  path: "chat/completions" | "responses",
  payload: unknown,
  opts: { runtimeKey: string; cfg?: CvcConfig },
): Promise<CvcProxyResult> {
  const cfg = opts.cfg ?? cvcConfig();
  const runtimeKey = opts.runtimeKey?.trim();
  if (!runtimeKey) return { ok: false, status: 503, code: "not_configured", message: "Upstream runtime key is not configured." };
  const started = Date.now();
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
      cache: "no-store",
    });
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfter = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code: errorCode(body) ?? (res.status === 429 ? "rate_limited" : res.status === 402 ? "insufficient_balance" : "upstream_error"),
        message: errorMessage(body) ?? "Upstream request failed.",
        retryAfter,
        body,
      };
    }
    return { ok: true, status: res.status, body, usage: parseCvcUsage(body), latencyMs: Date.now() - started };
  } catch {
    return { ok: false, status: 503, code: "network_error", message: "Upstream unreachable." };
  }
}

/**
 * Control-plane helper: create a delegated customer key. Requires PRIMARY_API_KEY.
 * Used by ensureUserUpstreamKey so each wallet has its own upstream credential.
 */
export async function createDelegatedKey(
  input: { name?: string; token_limit?: number | null; allowed_models?: string[] },
  cfg: CvcConfig = cvcConfig(),
): Promise<CvcFetchResult<{ key: string; meta: Record<string, unknown> }>> {
  if (!cfg.primaryKey) return { ok: false, status: 0, source: "not_configured", code: "primary_not_configured" };
  try {
    const { status, body } = await cvcFetchJson(`${cfg.baseUrl}/v1/keys`, cfg.primaryKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (status !== 201 && (status < 200 || status >= 300)) {
      return { ok: false, status, source: "cvc_keys_create", code: errorCode(body) ?? "http_error", message: errorMessage(body) };
    }
    const row = body as { key?: unknown; meta?: unknown };
    if (typeof row.key !== "string" || !row.key) {
      return { ok: false, status, source: "cvc_invalid_response", code: "missing_key" };
    }
    return {
      ok: true,
      status,
      data: { key: row.key, meta: row.meta && typeof row.meta === "object" ? row.meta as Record<string, unknown> : {} },
      source: "cvc_keys_create",
    };
  } catch {
    return { ok: false, status: 0, source: "cvc_unreachable", code: "network_error" };
  }
}
