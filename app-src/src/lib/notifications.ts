import type { AppData } from "@/lib/shared";
import { compact } from "@/lib/shared";
export type AppNotification = { id: string; title: string; description: string; href: string; icon: string; tone: string; createdAt: string };
export function notificationsFor(data: AppData): AppNotification[] {
  const items: AppNotification[] = [{ id: "welcome", title: "به فضای آزمایشی PanaAI خوش آمدید", description: "اعتبار و درخواست‌ها نمونه‌اند. پرداخت واقعی و ارسال به CVC فعال نیست.", href: "/docs", icon: "sparkle", tone: "gold", createdAt: data.user.createdAt }];
  if (data.wallet.expiring > 0 && data.user.settings.expiry !== false) items.push({ id: `expiry:${data.wallet.nearestExpiry}`, title: "بخشی از اعتبارتان نزدیک به انقضاست", description: `${compact(data.wallet.expiring)} اعتبار در ۳۰ روز آینده منقضی می‌شود.`, href: "/wallet", icon: "clock", tone: "warm", createdAt: data.user.createdAt });
  if (data.user.settings.payments !== false) for (const event of data.audit) {
    const order = data.orders.find(o => o.id === event.targetId);
    if (!order) continue;
    const descriptions: Record<string, [string, string, string]> = {
      "receipt.submitted": ["رسید برای بررسی ثبت شد", "ارسال رسید به‌تنهایی اعتباری اضافه نمی‌کند.", "orders"],
      "payment.approve": ["سفارش تأیید و اعتبار اضافه شد", `${compact(order.credits)} اعتبار به کیف پول اضافه شد.`, "success"],
      "payment.reject": ["نتیجه بررسی پرداخت ثبت شد", order.reviewNote || "توضیح بررسی را در جزئیات سفارش بخوانید.", "warning"],
      "payment.request-info": ["رسید به اطلاعات تکمیلی نیاز دارد", order.reviewNote || "امکان ارسال رسید جدید فراهم است.", "image"],
    };
    const info = descriptions[event.action];
    if (info) items.push({ id: event.id, title: info[0], description: `${order.reference} · ${info[1]}`, href: "/orders", icon: info[2], tone: event.action === "payment.approve" ? "green" : "warm", createdAt: event.createdAt });
  }
  return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 30);
}
export const isUnread = (item: AppNotification, readAt: unknown) => !readAt || new Date(item.createdAt).getTime() > new Date(String(readAt)).getTime();
