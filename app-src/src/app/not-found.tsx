import Link from "next/link";

export default function NotFound() {
  return <main className="system-page" id="main-content">
    <h1>صفحه پیدا نشد</h1>
    <p>نشانی واردشده وجود ندارد یا جابه‌جا شده است.</p>
    <div className="system-page-actions"><Link className="btn btn-primary" href="/">بازگشت به داشبورد</Link></div>
  </main>;
}
