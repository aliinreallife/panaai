"use client";
import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Button, Empty, Icon, useApp } from "@/components/ui";
import { compact, fa, persianDate, persianTime } from "@/lib/shared";
import { digitsOnly, groupFa, rangeError } from "@/lib/rules";

/**
 * Numeric input that shows Persian digits with thousands separators while editing, accepts
 * Persian/Arabic/Latin digits (typed or pasted), and reports range errors inline.
 * `value` / `onChange` carry plain ASCII digits ("" when empty).
 */
export function NumericField({ label, value, onChange, min, max, required = false, optional = false, unit, hint, placeholder, presets, name, allowNegative = false, disabled = false, describe }: {
  label: string; value: string; onChange: (value: string) => void; min?: number; max?: number; required?: boolean; optional?: boolean;
  unit?: string; hint?: React.ReactNode; placeholder?: string; presets?: number[]; name?: string; allowNegative?: boolean; disabled?: boolean;
  /** Extra line under the field (e.g. "≈ ۲۰ میلیون اعتبار"). */
  describe?: (value: number) => React.ReactNode;
}) {
  const id = useId(); const [touched, setTouched] = useState(false);
  const negative = allowNegative && value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const error = rangeError(value, { min, max, required, label });
  const show = !!error && (touched || (value !== "" && !!error));
  const display = (negative ? "−" : "") + groupFa(digits);
  const numeric = Number(value);
  return <div className={`field numeric-field ${show ? "field-invalid" : ""}`}>
    <label htmlFor={id}>{label}{optional && <small> (اختیاری)</small>}</label>
    <div className="numeric-input">
      <input id={id} name={name} inputMode="numeric" dir="ltr" autoComplete="off" value={display} placeholder={placeholder} disabled={disabled}
        aria-invalid={show || undefined} aria-describedby={`${id}-hint ${id}-error`} aria-required={required || undefined}
        onBlur={() => setTouched(true)}
        onChange={e => { const raw = e.target.value; const neg = allowNegative && /^[\s]*[-−]/.test(raw); const d = digitsOnly(raw); onChange(d ? (neg ? "-" : "") + d : neg ? "-" : ""); }}
        onKeyDown={e => {
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !disabled) {
            e.preventDefault(); const step = e.shiftKey ? 10 : 1; const next = (Number(value) || 0) + (e.key === "ArrowUp" ? step : -step);
            const bounded = Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(allowNegative ? (min ?? -Number.MAX_SAFE_INTEGER) : Math.max(0, min ?? 0), next));
            onChange(String(bounded));
          }
        }} />
      {unit && <span className="numeric-unit">{unit}</span>}
      {value && !disabled ? <button type="button" className="search-clear" aria-label={`پاک‌کردن ${label}`} onClick={() => { onChange(""); setTouched(true); }}><Icon name="close" size={13} /></button> : null}
    </div>
    {presets?.length ? <div className="quick-amounts" role="group" aria-label={`مقادیر پیشنهادی ${label}`}>{presets.map(v => <button key={v} type="button" className={numeric === v ? "active" : ""} aria-pressed={numeric === v} onClick={() => { onChange(String(v)); setTouched(true); }}>{fa(v)}</button>)}</div> : null}
    <small id={`${id}-hint`} className="field-hint">{hint}{!show && value && describe && Number.isSafeInteger(numeric) ? <> {describe(numeric)}</> : null}</small>
    <small id={`${id}-error`} className="field-error" role={show ? "alert" : undefined}>{show ? error : ""}</small>
  </div>;
}
export const numericError = (value: string, opts: { min?: number; max?: number; required?: boolean }) => rangeError(value, opts);

function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(t); }, [interval]);
  return now;
}
const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  const two = (n: number) => groupFa(String(n).padStart(2, "0")).replace("٬", "");
  return h ? `${groupFa(String(h))}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
};

/** Live countdown to the card-to-card transfer deadline. */
export function DeadlineCountdown({ deadline, createdAt }: { deadline: string; createdAt?: string }) {
  const now = useNow();
  const end = new Date(deadline).getTime(); const left = Math.max(0, Math.floor((end - now) / 1000));
  const total = createdAt ? Math.max(1, (end - new Date(createdAt).getTime()) / 1000) : 86400;
  const urgent = left > 0 && left <= 3600;
  return <div className={`quote-countdown deadline-countdown ${left === 0 ? "expired" : urgent ? "urgent" : ""}`} role="timer" aria-live="off">
    <div className="quote-countdown-top"><span><Icon name="clock" size={15} />{left === 0 ? "مهلت واریز تمام شده" : "مهلت واریز"}</span><strong dir="ltr">{clock(left)}</strong></div>
    <span className="mini-progress mini-gold" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left / total * 100)} aria-label="زمان باقی‌مانده تا پایان مهلت واریز"><i style={{ width: `${Math.min(100, left / total * 100)}%` }} /></span>
    <small>{left === 0 ? "واریز پس از مهلت به تطبیق دستی ارجاع می‌شود و ممکن است تأیید نشود." : `تا ${persianDate(deadline)}، ساعت ${persianTime(deadline)} (به وقت تهران)`}</small>
  </div>;
}

/** Retry button that stays disabled while a Retry-After window is running. */
export function RetryCountdown({ seconds, onRetry, label = "تلاش دوباره" }: { seconds: number; onRetry: () => void; label?: string }) {
  const [until] = useState(() => Date.now() + seconds * 1000);
  const now = useNow();
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return <div className="retry-countdown" aria-live="polite">
    {left > 0 && <p className="muted small"><Icon name="clock" size={14} /> برای جلوگیری از سوءاستفاده، {label} محدود شده است. امکان تلاش دوباره تا <strong>{clock(left)}</strong> دیگر.</p>}
    <Button disabled={left > 0} onClick={onRetry}><Icon name="refresh" size={16} />{left > 0 ? `تلاش دوباره (${fa(left)} ثانیه)` : "تلاش دوباره"}</Button>
  </div>;
}

/** Empty state that distinguishes "nothing yet" from "nothing matches your filters". */
export function FilteredEmpty({ active, onClear, title, text, icon = "orders", children }: { active: boolean; onClear: () => void; title: string; text?: string; icon?: string; children?: React.ReactNode }) {
  return active
    ? <Empty title="نتیجه‌ای با این فیلترها پیدا نشد" text="عبارت جست‌وجو یا فیلتر را تغییر دهید یا همه فیلترها را پاک کنید." icon="search"><Button tone="secondary" onClick={onClear}><Icon name="close" size={15} />پاک‌کردن فیلترها</Button></Empty>
    : <Empty title={title} text={text} icon={icon}>{children}</Empty>;
}

/** Low-balance and 7-day expiry notices, respecting the user's notification preferences. Dismissal lasts for this browser session. */
export function WalletNotices() {
  const { data } = useApp();
  // Rendered only after client-side data load, so reading sessionStorage during init is safe.
  const [hidden, setHidden] = useState<string[]>(() => { try { return JSON.parse(sessionStorage.getItem("pana-hidden-notices") || "[]"); } catch { return []; } });
  const hide = (id: string) => { const next = [...hidden, id]; setHidden(next); try { sessionStorage.setItem("pana-hidden-notices", JSON.stringify(next)); } catch { /* ignore */ } };
  const items: { id: string; tone: string; title: string; text: string; href: string; action: string }[] = [];
  const threshold = data.system.lowBalanceCredits;
  if (data.user.settings.lowBalance !== false && data.wallet.available < threshold) items.push({ id: `low:${threshold}`, tone: data.wallet.available <= 0 ? "danger" : "warning", title: data.wallet.available <= 0 ? "اعتبار قابل استفاده شما تمام شده است" : "اعتبار شما رو به اتمام است", text: `${compact(Math.max(0, data.wallet.available))} اعتبار قابل استفاده دارید؛ کمتر از آستانه ${compact(threshold)}. درخواست‌هایی که سقف هزینه‌شان از موجودی بیشتر باشد پذیرفته نمی‌شوند.`, href: "/purchase", action: "خرید اعتبار" });
  if (data.user.settings.expiry !== false && data.wallet.expiring7 > 0) items.push({ id: `exp7:${data.wallet.nearestExpiry}`, tone: "warning", title: "بخشی از اعتبارتان تا ۷ روز دیگر منقضی می‌شود", text: `${compact(data.wallet.expiring7)} اعتبار${data.wallet.nearestExpiry ? ` (نزدیک‌ترین انقضا ${persianDate(data.wallet.nearestExpiry)})` : ""} زودتر از بقیه مصرف می‌شود؛ پس از انقضا قابل استفاده یا بازپرداخت نیست.`, href: "/wallet", action: "مشاهده کیف پول" });
  const visible = items.filter(i => !hidden.includes(i.id));
  if (!visible.length) return null;
  return <div className="wallet-notices">{visible.map(item => <div key={item.id} className={`notice notice-${item.tone} wallet-notice`} role={item.tone === "danger" ? "alert" : "status"}><Icon name={item.id.startsWith("low") ? "wallet" : "clock"} size={20} /><div><strong>{item.title}</strong><div>{item.text}</div></div><div className="wallet-notice-actions"><Link className="text-link" href={item.href}>{item.action}<Icon name="left" size={14} /></Link><button type="button" className="icon-btn" aria-label={`بستن اعلان «${item.title}»`} onClick={() => hide(item.id)}><Icon name="close" size={15} /></button></div></div>)}</div>;
}
