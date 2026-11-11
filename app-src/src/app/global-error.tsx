"use client";

/** Last-resort boundary (errors in the root layout). Must render its own <html>. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = (error as { digest?: string } | null)?.digest;
  return <html lang="fa" dir="rtl"><body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#121316", color: "#f3efe6", fontFamily: "system-ui, Tahoma, sans-serif", textAlign: "center", padding: 16 }}>
    <main>
      <h1 style={{ fontSize: 22 }}>سرویس موقتاً در دسترس نیست</h1>
      <p style={{ color: "#a9a49a" }}>اطلاعات و اعتبار شما محفوظ است. چند لحظه بعد دوباره تلاش کنید.</p>
      {digest && <p style={{ color: "#a9a49a", fontSize: 13 }}>کد پیگیری: <code dir="ltr">{digest}</code></p>}
      <button onClick={() => retry()} style={{ marginTop: 12, padding: "10px 18px", borderRadius: 10, border: 0, background: "#e2b04a", color: "#2a1f08", fontWeight: 600, cursor: "pointer" }}>تلاش دوباره</button>
    </main>
  </body></html>;
}
