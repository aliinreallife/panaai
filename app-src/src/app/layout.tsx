import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./pana-theme.css";
import "./analytics-polish.css";
import "./ux-polish.css";
import "./ops-polish.css";
export const metadata: Metadata = {
  title: { default: "نمای کلی | PanaAI", template: "%s | PanaAI" },
  description: "PanaAI؛ فضای کار فارسی برای مدیریت اعتبار هوش مصنوعی، کلیدهای API و مصرف؛ نسخه آزمایشی با پرداخت کارت‌به‌کارت.",
  robots: { index: false, follow: false },
};
const themeScript = `try{var t=localStorage.getItem('pana-theme')||'dark';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t}catch(e){}`;
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="fa" dir="rtl" data-theme="dark" suppressHydrationWarning><head><link rel="preload" href="/fonts/vazirmatn.woff2" as="font" type="font/woff2" crossOrigin="anonymous" /><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head><body><a href="#main-content" className="skip-link">رفتن به محتوای اصلی</a>{children}</body></html>;
}
