"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { fa, persianDate, persianTime } from "@/lib/shared";
import { Icon } from "@/components/ui";

/** Relative Persian time, e.g. «۳ ساعت پیش» with absolute tooltip. */
export function RelativeTime({ value, className = "" }: { value: string | Date; className?: string }) {
  const date = new Date(value);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);
  const diff = Math.max(0, now - date.getTime());
  const min = Math.floor(diff / 60000);
  let label: string;
  if (min < 1) label = "لحظاتی پیش";
  else if (min < 60) label = `${fa(min)} دقیقه پیش`;
  else if (min < 1440) label = `${fa(Math.floor(min / 60))} ساعت پیش`;
  else if (min < 10080) label = `${fa(Math.floor(min / 1440))} روز پیش`;
  else label = persianDate(date, { year: "numeric" });
  const title = `${persianDate(date, { year: "numeric" })}، ${persianTime(date)}`;
  return (
    <span className={`relative-time ${className}`} title={title}>
      {label}
    </span>
  );
}

/** SLA / age badge with tone by hours elapsed. */
export function AgeBadge({ since }: { since: string | Date }) {
  const hours = Math.max(0, (Date.now() - new Date(since).getTime()) / 3600000);
  const tone = hours < 1 ? "fresh" : hours < 24 ? "warm" : "old";
  const label =
    hours < 1
      ? `${fa(Math.max(1, Math.floor(hours * 60)))} دقیقه`
      : hours < 24
        ? `${fa(Math.floor(hours))} ساعت`
        : `${fa(Math.floor(hours / 24))} روز`;
  return (
    <span className={`age-badge age-${tone}`} title={`ثبت‌شده در ${persianDate(since, { year: "numeric" })}، ${persianTime(since)}`}>
      <Icon name="clock" size={12} />
      {label}
    </span>
  );
}

/** Thin progress bar with tone + accessible value. */
export function MiniProgress({
  value,
  max = 100,
  tone = "gold",
  label,
}: {
  value: number;
  max?: number;
  tone?: "gold" | "green" | "warm" | "danger" | "blue";
  label?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span
      className={`mini-progress mini-${tone}`}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label || `${fa(Math.round(pct))} درصد`}
    >
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Removable filter chip. */
export function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="filter-chip">
      {label}
      <button type="button" onClick={onClear} aria-label={`حذف فیلتر ${label}`}>
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

/** Character counter for inputs. */
export function CharCount({ value, max }: { value: string; max: number }) {
  const len = value.length;
  const near = len > max * 0.85;
  return (
    <span className={`char-count ${near ? "near-limit" : ""}`} aria-live="polite">
      {fa(len)} / {fa(max)}
    </span>
  );
}

/** Quote countdown with progress + urgency state. */
export function QuoteCountdown({ expiresAt }: { expiresAt: string }) {
  const total = 900;
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
  );
  useEffect(() => {
    const t = setInterval(
      () => setRemaining(Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))),
      1000
    );
    return () => clearInterval(t);
  }, [expiresAt]);
  const mm = fa(Math.floor(remaining / 60));
  const ss = String(remaining % 60)
    .padStart(2, "0")
    .replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[+d]);
  const urgent = remaining > 0 && remaining <= 120;
  return (
    <div className={`quote-countdown ${remaining === 0 ? "expired" : urgent ? "urgent" : ""}`} role="timer" aria-live="off">
      <div className="quote-countdown-top">
        <span>
          <Icon name="clock" size={15} />
          {remaining === 0 ? "پیش‌فاکتور منقضی شد" : "اعتبار پیش‌فاکتور"}
        </span>
        <strong dir="ltr">
          {mm}:{ss}
        </strong>
      </div>
      <MiniProgress value={remaining} max={total} tone={remaining === 0 ? "danger" : urgent ? "warm" : "gold"} label={`زمان باقی‌مانده پیش‌فاکتور: ${mm} دقیقه و ${ss} ثانیه`} />
      {urgent && remaining > 0 && <small>کمتر از ۲ دقیقه مانده؛ در صورت انقضا، پیش‌فاکتور تازه بگیرید.</small>}
    </div>
  );
}

/** Offline banner (shows only when offline). */
export function OfflineBanner() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  if (online) return null;
  return (
    <div className="offline-banner" role="alert">
      <Icon name="warning" size={16} />
      اتصال اینترنت قطع است. تغییرات ذخیره نمی‌شوند؛ پس از اتصال دوباره تلاش کنید.
    </div>
  );
}

/** Breadcrumb for inner pages. */
export function Breadcrumbs({ trail }: { trail: { label: string; href?: string }[] }) {
  return (
    <nav className="breadcrumbs-bar" aria-label="مسیر صفحه">
      <Link href="/">
        <Icon name="home" size={14} />
        خانه
      </Link>
      {trail.map((t, i) => (
        <span key={i} className="crumb">
          <Icon name="chevron" size={12} />
          {t.href ? <Link href={t.href}>{t.label}</Link> : <strong aria-current="page">{t.label}</strong>}
        </span>
      ))}
    </nav>
  );
}

/** Skeleton blocks for loading states. */
export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="skeleton-table" aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="skeleton-row">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className="skeleton-cell" style={{ width: c === 0 ? "22%" : `${Math.floor(78 / (cols - 1))}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="skeleton-cards" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="skeleton-card" />
      ))}
    </div>
  );
}

export function FormSkeleton() {
  return (
    <div className="skeleton-form" aria-hidden="true">
      <Skeleton className="skeleton-line w40" />
      <Skeleton className="skeleton-input" />
      <Skeleton className="skeleton-input" />
      <div className="skeleton-form-row">
        <Skeleton className="skeleton-input" />
        <Skeleton className="skeleton-input" />
      </div>
      <Skeleton className="skeleton-btn" />
    </div>
  );
}

/** Order timeline (purchase stepper detail). */
export function OrderTimeline({
  steps,
}: {
  steps: { label: string; at: string | null; done: boolean; current?: boolean }[];
}) {
  // A later finished step means every earlier step is finished too (e.g. sample orders credited without a receipt time).
  const lastDone = steps.reduce((last, s, i) => (s.done ? i : last), -1);
  const items = steps.map((s, i) => ({ ...s, done: s.done || i < lastDone }));
  return (
    <ol className="order-timeline">
      {items.map((s, i) => (
        <li key={i} className={s.done ? "done" : s.current ? "current" : "todo"}>
          <span className="timeline-dot">{s.done ? <Icon name="check" size={12} /> : fa(i + 1)}</span>
          <div>
            <strong>{s.label}</strong>
            {s.at ? (
              <small>
                {persianDate(s.at, { year: "numeric" })}، {persianTime(s.at)}
              </small>
            ) : (
              <small className="muted">{s.done ? "انجام شد" : s.current ? "مرحله فعلی" : "در انتظار"}</small>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Amount match indicator for review flows. */
export function MatchPill({ match, expected, actual }: { match: boolean; expected: string; actual: string }) {
  return (
    <span className={`match-pill ${match ? "match" : "mismatch"}`} title={`مورد انتظار: ${expected} — اعلام‌شده: ${actual}`}>
      <Icon name={match ? "check" : "warning"} size={13} />
      {match ? "مبلغ منطبق است" : "مغایرت مبلغ"}
    </span>
  );
}
