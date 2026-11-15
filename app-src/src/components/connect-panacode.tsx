"use client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { AppData, fa, compact } from "@/lib/shared";
import { Button, Icon, Notice, api, type ApiFailure } from "@/components/ui";
import { NumericField } from "@/components/ux-fields";
import { PanaBrand } from "@/components/brand-art";
import { LoginForm } from "@/components/platform";

type CreditGate = {
  ok: boolean;
  reason?: "no_credit" | "allocation_exceeded";
  available: number;
  unallocated: number;
  allocated: number;
  requiredBudget: number | null;
};

type ConnectStatus = {
  id: string;
  status: string;
  product: string;
  keyName: string;
  budget: number | null;
  rateLimit: number;
  expiresAt: string;
  credit: CreditGate;
  ready: boolean;
};

type Mode = "unlimited" | "capped";

function purchaseHref(state: string, redirectUri: string) {
  const returnTo = `/connect/panacode?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  return `/purchase?returnTo=${encodeURIComponent(returnTo)}&connect=panacode`;
}

export function ConnectPanacodePage({
  state,
  redirectUri,
}: {
  state: string;
  redirectUri: string;
}) {
  const [data, setData] = useState<AppData | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [mode, setMode] = useState<Mode>("unlimited");
  const [budget, setBudget] = useState("");
  const [keyName, setKeyName] = useState("Panacode");
  const [rateLimit, setRateLimit] = useState("60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [doneUrl, setDoneUrl] = useState("");
  const [bootError, setBootError] = useState("");

  const returnPurchase = useMemo(() => purchaseHref(state, redirectUri), [state, redirectUri]);

  const refreshStatus = useCallback(async () => {
    const next = await api<ConnectStatus>(`connect/panacode/status?state=${encodeURIComponent(state)}`);
    setStatus(next);
    setKeyName(next.keyName || "Panacode");
    setRateLimit(String(next.rateLimit || 60));
    if (next.budget == null) {
      setMode("unlimited");
      setBudget("");
    } else {
      setMode("capped");
      setBudget(String(next.budget));
    }
    return next;
  }, [state]);

  const bootstrap = useCallback(async () => {
    setBootError("");
    try {
      await api("connect/panacode/session", {
        body: { state, redirectUri, product: "panacode", keyName: "Panacode" },
      });
      const boot = await api<AppData | { needsAuth: true }>("bootstrap", { method: "POST" });
      if ("needsAuth" in boot && boot.needsAuth) {
        setNeedsAuth(true);
        setData(null);
        return;
      }
      const app = boot as AppData;
      setData(app);
      setNeedsAuth(false);
      await api("connect/panacode/attach", { body: { state } });
      await refreshStatus();
    } catch (e) {
      setBootError((e as Error).message);
    }
  }, [state, redirectUri, refreshStatus]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  useEffect(() => {
    if (!data || doneUrl) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshStatus().catch(() => undefined);
      void api<AppData>("data").then(setData).catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, [data, doneUrl, refreshStatus]);

  const onAuthed = async (payload: AppData) => {
    setData(payload);
    setNeedsAuth(false);
    await api("connect/panacode/attach", { body: { state } });
    await refreshStatus();
  };

  const complete = async () => {
    setBusy(true);
    setError("");
    try {
      const body = {
        state,
        keyName: keyName.trim() || "Panacode",
        rateLimit: Number(rateLimit) || 60,
        budget: mode === "unlimited" ? null : Number(budget),
      };
      if (mode === "capped" && (!Number.isInteger(body.budget) || (body.budget as number) <= 0)) {
        throw new Error("سقف بودجه معتبر وارد کنید.");
      }
      const result = await api<{ redirectUrl: string }>("connect/panacode/complete", { body });
      setDoneUrl(result.redirectUrl);
      // Navigate to desktop loopback — CSP allows top-level navigation.
      window.location.assign(result.redirectUrl);
    } catch (e) {
      const failure = e as ApiFailure;
      setError(failure.message);
      if (failure.code === "insufficient_credits" || failure.code === "allocation_exceeded") {
        await refreshStatus().catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  };

  if (bootError) {
    return <Shell>
      <Notice tone="warning" title="شروع اتصال ناموفق">{bootError}</Notice>
      <p className="muted">از Panacode دوباره «ورود با PanaAI» را بزنید.</p>
    </Shell>;
  }

  if (needsAuth || !data) {
    return <Shell>
      <h1>اتصال Panacode</h1>
      <p>برای ساخت کلید API و بازگشت به برنامه، با موبایل وارد شوید.</p>
      {needsAuth
        ? <LoginForm flow="login" onSuccess={async (payload) => { if (!payload) throw new Error("ورود کامل نشد."); await onAuthed(payload); }} />
        : <p className="muted">در حال آماده‌سازی…</p>}
    </Shell>;
  }

  const credit = status?.credit;
  const noCredit = credit && !credit.ok && credit.reason === "no_credit";
  const overBudget = credit && !credit.ok && credit.reason === "allocation_exceeded";

  return <Shell>
    <h1>اتصال Panacode به PanaAI</h1>
    <p>کلید API برای برنامهٔ دسکتاپ ساخته می‌شود و فقط یک‌بار به Panacode برمی‌گردد.</p>

    <div className="connect-wallet-strip">
      <div><span>اعتبار قابل استفاده</span><strong>{compact(credit?.available ?? data.wallet.available)}</strong></div>
      <div><span>تخصیص‌نیافته</span><strong>{compact(credit?.unallocated ?? data.wallet.unallocated)}</strong></div>
    </div>

    {noCredit && (
      <Notice tone="warning" title="اعتباری ندارید">
        قبل از تکمیل ورود، کیف پول را شارژ کنید. پس از تأیید و شارژ، به همین صفحه برگردید تا اتصال تمام شود.
        <div className="button-row" style={{ marginTop: 12 }}>
          <Link className="btn btn-primary" href={returnPurchase}>رفتن به خرید اعتبار<Icon name="left" size={16} /></Link>
        </div>
      </Notice>
    )}

    {overBudget && (
      <Notice tone="warning" title="سقف بیشتر از اعتبار آزاد است">
        سقف انتخابی از اعتبار تخصیص‌نیافته بیشتر است. سقف را کمتر کنید یا اعتبار بخرید.
        <div className="button-row" style={{ marginTop: 12 }}>
          <Link className="btn btn-secondary" href={returnPurchase}>خرید اعتبار بیشتر</Link>
        </div>
      </Notice>
    )}

    {!noCredit && (
      <section className="panel padded connect-options">
        <h2>نوع دسترسی کلید</h2>
        <p className="muted">بعداً از پنل کلیدها هم می‌توانید سقف را تغییر دهید.</p>
        <div className="connect-mode-grid">
          <button type="button" className={mode === "unlimited" ? "selected" : ""} onClick={() => setMode("unlimited")} aria-pressed={mode === "unlimited"}>
            <strong>بدون سقف (اشتراکی)</strong>
            <span>از اعتبار تخصیص‌نیافته کیف پول مصرف می‌کند.</span>
          </button>
          <button type="button" className={mode === "capped" ? "selected" : ""} onClick={() => setMode("capped")} aria-pressed={mode === "capped"}>
            <strong>سقف‌دار</strong>
            <span>بودجهٔ جدا برای این نصب Panacode رزرو می‌شود.</span>
          </button>
        </div>

        {mode === "capped" && (
          <NumericField
            label="سقف بودجه (اعتبار داخلی)"
            value={budget}
            onChange={setBudget}
            min={1}
            max={credit?.unallocated || data.wallet.unallocated || 1}
            required
            hint={`حداکثر ${fa(credit?.unallocated ?? data.wallet.unallocated)} اعتبار آزاد.`}
          />
        )}

        <label className="field">نام کلید
          <input value={keyName} maxLength={50} onChange={(e) => setKeyName(e.target.value)} />
        </label>
        <NumericField label="سقف نرخ درخواست (در دقیقه)" value={rateLimit} onChange={setRateLimit} min={1} max={300} required />

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="button-row">
          <Button busy={busy} disabled={!!overBudget} onClick={() => void complete()}>
            تأیید و بازگشت به Panacode
            <Icon name="left" size={16} />
          </Button>
          <Link className="btn btn-secondary" href={returnPurchase}>خرید / افزایش اعتبار</Link>
        </div>
        <p className="form-caption">پس از تأیید، مرورگر به برنامهٔ محلی برمی‌گردد. اگر برنگشت، همان پنجرهٔ Panacode را باز نگه دارید و دوباره تلاش کنید.</p>
      </section>
    )}

    {doneUrl && (
      <Notice tone="success" title="در حال بازگشت…">
        اگر خودکار برنگشتید، <a href={doneUrl}>این لینک را باز کنید</a>.
      </Notice>
    )}
  </Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="connect-panacode" id="main-content">
      <div className="connect-panacode-card">
        <div className="connect-panacode-brand"><PanaBrand /></div>
        {children}
      </div>
    </main>
  );
}

export function ConnectPanacodeInvalid({ message }: { message: string }) {
  return (
    <Shell>
      <h1>لینک اتصال نامعتبر است</h1>
      <Notice tone="warning">{message}</Notice>
      <p className="muted">از داخل Panacode دوباره «ورود با PanaAI» را انتخاب کنید.</p>
    </Shell>
  );
}
