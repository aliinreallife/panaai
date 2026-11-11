"use client";
import { useEffect } from "react";
import Link from "next/link";

/** Route-level error boundary. Shows a calm Persian message and the error digest for support. */
export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = (error as { digest?: string } | null)?.digest;
  useEffect(() => { console.error("ui.render_error", { digest }); }, [digest]);
  return <main className="system-page" id="main-content">
    <h1>مشکلی پیش آمد</h1>
    <p>صفحه بارگذاری نشد. اطلاعات و اعتبار شما محفوظ است؛ دوباره تلاش کنید.</p>
    {digest && <p className="system-page-code">کد پیگیری: <code dir="ltr">{digest}</code></p>}
    <div className="system-page-actions"><button className="btn btn-primary" onClick={() => retry()}>تلاش دوباره</button><Link className="btn btn-secondary" href="/">بازگشت به داشبورد</Link></div>
  </main>;
}
