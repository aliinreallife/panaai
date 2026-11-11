import type { Metadata } from "next";
import Platform from "@/components/platform";
import { notFound } from "next/navigation";
const views = ["wallet", "purchase", "orders", "keys", "usage", "models", "docs", "settings", "support", "admin", "roadmap"];
const TITLES: Record<string, string> = {
  wallet: "کیف پول",
  purchase: "خرید اعتبار",
  orders: "سفارش‌ها و تراکنش‌ها",
  keys: "کلیدهای API",
  usage: "تحلیل مصرف",
  models: "مدل‌های هوش مصنوعی",
  docs: "مستندات و راهنما",
  settings: "تنظیمات حساب",
  support: "پشتیبانی",
  admin: "مدیریت آزمایشی",
  roadmap: "وضعیت پیاده‌سازی PRD",
};
export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
  const { slug } = await params;
  const title = slug?.length === 1 ? TITLES[slug[0]] : undefined;
  return title ? { title } : {};
}
export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  if (slug.length !== 1 || !views.includes(slug[0])) notFound();
  return <Platform view={slug[0]} />;
}
