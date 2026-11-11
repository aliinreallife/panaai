import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";
import "./pana-theme.css";
import "./analytics-polish.css";
import "./ux-polish.css";
import "./ops-polish.css";
import "./typography.css";

// Vazirmatn variable font (SIL OFL 1.1), served from this app. next/font preloads it,
// hashes the file name for long caching and adds a size-matched fallback to avoid layout shift.
const vazirmatn = localFont({
  src: "./fonts/Vazirmatn-Variable.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-vazirmatn",
  fallback: ["Tahoma", "Segoe UI", "sans-serif"],
});
export const metadata: Metadata = {
  title: { default: "نمای کلی | PanaAI", template: "%s | PanaAI" },
  description: "PanaAI؛ فضای کار فارسی برای مدیریت اعتبار هوش مصنوعی، کلیدهای API و مصرف؛ نسخه آزمایشی با پرداخت کارت‌به‌کارت.",
  robots: { index: false, follow: false },
};
const themeScript = `try{var t=localStorage.getItem('pana-theme')||'dark';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t}catch(e){}`;
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="fa" dir="rtl" data-theme="dark" className={vazirmatn.variable} suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head><body><a href="#main-content" className="skip-link">رفتن به محتوای اصلی</a>{children}</body></html>;
}
