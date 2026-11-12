"use client";
import { useMemo, useState } from "react";
import { Badge, Empty, PageTitle, SearchInput, useApp } from "@/components/ui";
import { fa } from "@/lib/shared";

type Status = "done" | "sandbox" | "partial" | "todo";
type Item = { id: string; title: string; status: Status; note: string };

const STATUS_FA: Record<Status, { label: string; tone: string }> = {
  done: { label: "پیاده‌سازی‌شده", tone: "success" },
  sandbox: { label: "فقط در محیط آزمایشی", tone: "info" },
  partial: { label: "نیمه‌کاره", tone: "warning" },
  todo: { label: "باقی‌مانده", tone: "neutral" },
};

const DECISIONS: Item[] = [
  { id: "D01", title: "رابط فارسی و راست‌به‌چپ", status: "done", note: "کل رابط فارسی، RTL، فونت وزیرمتن، تاریخ شمسی و ارقام فارسی با جداکننده هزارگان." },
  { id: "D02", title: "ورود با OTP موبایل", status: "partial", note: "انقضا، یک‌بارمصرف و محدودیت تلاش پیاده است. با KAVENEGAR_API_KEY + الگوی Lookup پیامک واقعی ارسال و هزینه شمارش می‌شود؛ بدون کلید، حالت آزمایشی می‌ماند." },
  { id: "D03", title: "تأمین‌کننده بالادست", status: "partial", note: "پروکسی زنده + رزرو/تسویه از cost_tokens + کلید بالادست اختصاصی هر کیف پول پیاده شد. مانده: مجوز کتبی فروش مجدد و تأیید ضریب تجاری." },
  { id: "D04", title: "کلیدها در کلاینت‌های ثالث", status: "partial", note: "مشتری با کلید پانا به /v1 وصل می‌شود؛ در live به کلید بالادست همان کیف پول نگاشت می‌شود. مانده: استریم (SSE)." },
  { id: "D05", title: "اعتبار داخلی (نه توکن خام)", status: "done", note: "واحد اعتبار داخلی در کیف پول، گزارش و خروجی جدا از توکن است." },
  { id: "D06", title: "نرخ ۲۰M اعتبار به ازای هر دلار", status: "sandbox", note: "فرمول BigInt با گرد کردن به پایین کار می‌کند؛ نسبت تجاری و تعرفه مدل‌ها نیازمند تأیید است." },
  { id: "D07", title: "نرخ ارز خودکار + دستی", status: "partial", note: "پیش‌فرض ۲۷۵هزار تومان/دلار، دستی و سراسری با نسخه‌گذاری؛ منبع بازار اختیاری است." },
  { id: "D08", title: "نمایش تومان، حسابداری ریال", status: "done", note: "نمایش تومان و ذخیره ریال صحیح با محاسبات BigInt." },
  { id: "D09", title: "بسته‌ها + مبلغ دلخواه + سقف", status: "done", note: "بسته‌ها از پنل مدیریت (با دلیل و حسابرسی) و مبلغ دلخواه با خطای بازه درون فیلد." },
  { id: "D10", title: "اعتبار ۳۶۵ روزه و lot مستقل", status: "done", note: "هر خرید یا اصلاح یک lot با انقضای مستقل دارد." },
  { id: "D11", title: "مصرف FEFO", status: "done", note: "رزرو زنده FEFO با قفل سطری و تسویه به همان ترتیب انقضا؛ با آزمون هم‌زمانی." },
  { id: "D12", title: "بدون overdraft", status: "done", note: "رزرو سقف هزینه پیش از ارسال؛ ۲۰ درخواست هم‌زمان هرگز از موجودی بیشتر مصرف نمی‌کنند." },
  { id: "D13", title: "چند کلید با بودجه و محدودیت", status: "done", note: "بودجه، نرخ و allowlist مدل در درگاه اعمال می‌شود (نه فقط در رابط)." },
  { id: "D14", title: "کاتالوگ مدل‌ها", status: "partial", note: "فهرست پلتفرم‌محور (platform_state) + UI مشتری/ادمین + تازه‌سازی ~ساعتی و هشدار پس از ۲ شکست. مانده: تعرفه/پنجره زمینه رسمی هر مدل." },
  { id: "D15", title: "همگام‌سازی موجودی بالادست", status: "partial", note: "GET /v1/balance برای پوشش پلتفرم + sync فهرست مدل‌ها. مانده: تأیید شکل پاسخ واقعی حساب reseller و مانیتورینگ پایدار." },
  { id: "D16", title: "فروش بیش‌از‌موجودی با هشدار", status: "sandbox", note: "سطوح پوشش ۱۰۰/۷۵/۲۵/۰ و هشدار افت سطح؛ فروش متوقف نمی‌شود." },
  { id: "D17", title: "موجودی صفر: توقف درخواست، ادامه فروش", status: "sandbox", note: "در وضعیت «صفر» درگاه ۵۰۳ با Retry-After می‌دهد و خرید اعتبار باز می‌ماند (آزموده)." },
  { id: "D18", title: "پنجره grace محدود", status: "sandbox", note: "پیش‌فرض ۵ دقیقه، قابل تنظیم ۰ تا ۶۰ در تنظیمات سیستم؛ عدد نهایی باید تصویب شود." },
  { id: "D19", title: "پیش‌فاکتور ۱۵ دقیقه + مهلت واریز", status: "done", note: "شمارش معکوس پیش‌فاکتور و مهلت واریز؛ مهلت از تنظیمات سیستم (پیش‌فرض ۲۴ ساعت)." },
  { id: "D20", title: "بازپرداخت دستی، بدون اعتبار رایگان", status: "sandbox", note: "درخواست → تأیید با برگشت اعتبار مصرف‌نشده → ثبت واریز با مرجع؛ واریز بانکی واقعی انجام نمی‌شود." },
  { id: "D21", title: "تحلیل پیشرفته + حسابرسی", status: "done", note: "گزارش سمت‌سرور، خروجی CSV و لاگ حسابرسی؛ مصرف درگاه هم در گزارش‌ها می‌آید." },
  { id: "D22", title: "یک سوپرادمین + OTP و TOTP", status: "sandbox", note: "TOTP واقعی (RFC 6238) با جلوگیری از تکرار و قفل پس از ۵ خطا، نشست ۱۵ دقیقه‌ای و RBAC سمت سرور؛ مرحله OTP شبیه‌سازی است." },
  { id: "D23", title: "هشدار داشبورد/تلگرام/ایمیل", status: "sandbox", note: "هشدارها ذخیره و به تلگرام (Bot API) و ایمیل (Resend) ارسال می‌شوند، به شرط تنظیم توکن‌ها روی سرور." },
  { id: "D24", title: "روشن/تیره، وزیرمتن، ریسپانسیو", status: "done", note: "تم تیره/روشن/خودکار و بدون اسکرول افقی در موبایل و دسکتاپ (آزموده)." },
  { id: "D25", title: "افشای قطعی/موجودی صفر", status: "done", note: "بنر پویا در نمای کلی، هشدار پیش از خرید و مودال وضعیت سرویس بر اساس ماشین وضعیت." },
  { id: "D26", title: "فقط فراداده، نگهداری ۳۶۵ روز", status: "done", note: "متن ذخیره نمی‌شود؛ cron روزانه /api/cron/maintenance رزروهای کهنه را آزاد و فراداده مصرف قدیمی‌تر از ۳۶۵ روز را حذف می‌کند." },
  { id: "D27", title: "پرداخت کارت‌به‌کارت دستی", status: "sandbox", note: "سفارش، رسید رمزگذاری‌شده، صف بررسی و تأیید دقیقاً‌یک‌باره؛ کارت مقصد پیش‌فرض ۶۲۱۹…۹۷۵۵ قابل ویرایش در ادمین." },
  { id: "D28", title: "زرین‌پال (آینده)", status: "todo", note: "طبق تصمیم در MVP غایب است." },
  { id: "D29", title: "ژورنال تغییرناپذیر و ضدتقلب", status: "done", note: "ژورنال متوازن، idempotency، قفل سطری، dedup مرجع/تصویر و تطبیق خودکار." },
  { id: "D30", title: "نام برند نامشخص", status: "done", note: "PanaAI یک placeholder قابل‌تنظیم است." },
];

const CUSTOMER: Item[] = [
  { id: "C1", title: "ورود و ثبت‌نام", status: "partial", note: "OTP موبایل با کاوه‌نگار وقتی کلید تنظیم باشد؛ ثبت‌نام کامل مشتری هنوز sandbox است." },
  { id: "C2", title: "نمای کلی", status: "done", note: "شاخص‌ها، روند، مدل‌ها، اعلان کمبود/انقضای اعتبار و وضعیت سرویس." },
  { id: "C3", title: "خرید اعتبار", status: "done", note: "بسته‌های مدیریتی، مبلغ دلخواه با خطای درون فیلد، پیش‌فاکتور، مهلت واریز و رسید." },
  { id: "C4", title: "سفارش‌ها و تراکنش‌ها", status: "done", note: "فیلتر، جست‌وجوی پاک‌شدنی، حالت خالی وابسته به فیلتر، تایم‌لاین، بازپرداخت و CSV." },
  { id: "C5", title: "کیف پول", status: "done", note: "موجودی/رزرو، اعلان ۷ روزه، lotها، اصلاح و برگشت بازپرداخت در گردش." },
  { id: "C6", title: "کلیدهای API", status: "done", note: "ساخت با فیلدهای عددی فارسی، نمایش یک‌باره، بودجه، لغو و تعویض." },
  { id: "C7", title: "تحلیل مصرف", status: "done", note: "KPI، روند روزانه، تفکیک مدل/کلید، جدول و CSV سمت‌سرور." },
  { id: "C8", title: "تنظیمات، اعلان‌ها و راهنما", status: "done", note: "پروفایل، ترجیحات اعلان، مستندات و پشتیبانی." },
];

const ADMIN: Item[] = [
  { id: "A1", title: "نمای کلی مدیریت", status: "partial", note: "شاخص‌ها و وضعیت تأمین‌کننده برای یک حساب آزمایشی؛ چندکاربره نیست." },
  { id: "A2", title: "بررسی پرداخت‌ها", status: "sandbox", note: "صف، رسید امن، تطبیق مبلغ با ارقام فارسی و تصمیم حسابرسی‌شده؛ تأیید بانک شبیه‌سازی است." },
  { id: "A3", title: "کاربران", status: "partial", note: "تعلیق/فعال‌سازی و اصلاح اعتبار حسابرسی‌شده؛ فهرست چند کاربر واقعی وجود ندارد." },
  { id: "A4", title: "مالی و درآمد", status: "partial", note: "تفکیک نقد/ادعا/تعهد و تطبیق کیف پول؛ سود و مالیات حسابداری نیست." },
  { id: "A5", title: "تأمین‌کننده بالادست", status: "partial", note: "ماشین وضعیت + همگام واقعی موجودی/مدل‌ها وقتی کلید تنظیم باشد؛ شبیه‌ساز هنوز برای sandbox است." },
  { id: "A6", title: "گزارش مصرف API", status: "done", note: "همان موتور گزارش مشتری با p95 و خروجی." },
  { id: "A7", title: "قیمت‌گذاری و بسته‌ها", status: "partial", note: "نرخ/سقف نسخه‌دار و مدیریت بسته‌ها؛ منبع بازار ارز مانده." },
  { id: "A8", title: "مدل‌های هوش مصنوعی", status: "partial", note: "فهرست زنده پانا + ضریب از بالادست + فعال/غیرفعال روی درگاه. مانده: ویرایش دستی تعرفه/برچسب تجاری." },
  { id: "A9", title: "هشدارها و رخدادها", status: "sandbox", note: "هشدار ذخیره‌شده با وضعیت ارسال هر کانال و تأیید مشاهده؛ escalation زمان‌دار نیست." },
  { id: "A10", title: "بازپرداخت‌ها و اصلاحات", status: "sandbox", note: "تأیید/رد/ثبت واریز بازپرداخت و اصلاح اعتبار با رویداد جبرانی." },
  { id: "A11", title: "تنظیمات و امنیت", status: "sandbox", note: "TOTP، نقش‌ها (مالک/مالی/پشتیبانی/مشاهده) و تنظیمات سیستم؛ اختصاص نقش به چند مدیر واقعی نیست." },
];

const ACCEPTANCE: Item[] = [
  { id: "AC01", title: "OTP یک‌بارمصرف با انقضا و محدودیت", status: "partial", note: "آزموده در حالت آزمایشی؛ ارسال واقعی Lookup وقتی کلید/الگو تنظیم باشد + شمارش هزینه." },
  { id: "AC02", title: "TOTP برای مدیر؛ غیرمدیر به مسیر مدیر دسترسی ندارد", status: "done", note: "عملیات مدیریتی بدون نشست TOTP ۴۰۱ و نقش نامجاز ۴۰۳ می‌گیرد." },
  { id: "AC03", title: "جداسازی داده مشتریان", status: "done", note: "آزمون دو نشست مستقل." },
  { id: "AC04", title: "پیش‌فاکتور تغییرناپذیر با تغییر نرخ", status: "done", note: "آزموده." },
  { id: "AC05", title: "رسید به‌تنهایی اعتبار نمی‌دهد", status: "done", note: "آزموده." },
  { id: "AC06", title: "رد تصویر مخرب/جعلی", status: "done", note: "آزموده." },
  { id: "AC07", title: "تأیید مستقل بانک و جلوگیری از مرجع تکراری", status: "sandbox", note: "تأیید بانک شبیه‌سازی است؛ تکرار مرجع رد می‌شود." },
  { id: "AC08", title: "تأیید هم‌زمان = یک اعتبار", status: "done", note: "آزموده." },
  { id: "AC09", title: "رد با دلیل و بازبینی مجدد", status: "done", note: "آزموده." },
  { id: "AC10", title: "مسیر غیرخاموش برای مغایرت‌ها", status: "partial", note: "مبلغ نادرست، دیرکرد و تکرار پوشش دارد؛ واریز بی‌صاحب و پرداخت جزئی مسیر جدا ندارند." },
  { id: "AC11", title: "زرین‌پال غایب", status: "done", note: "روش پرداخت همه‌جا کارت‌به‌کارت است." },
  { id: "AC12", title: "انقضای مستقل و FEFO بدون منفی شدن", status: "done", note: "آزموده." },
  { id: "AC13", title: "درخواست‌های هم‌زمان بیش از موجودی مصرف نمی‌کنند", status: "done", note: "آزمون ۳۰ و ۲۰ درخواست هم‌زمان روی بودجه کلید و کیف پول." },
  { id: "AC14", title: "timeout بدون صورتحساب دوباره", status: "partial", note: "خطا/timeout رزرو را آزاد می‌کند؛ cron رزرو کهنه را آزاد می‌کند. مانده: تطبیق meter با لاگ بالادست پس از ترافیک واقعی." },
  { id: "AC15", title: "چند کلید، لغو فوری، نمایش یک‌باره", status: "done", note: "آزموده." },
  { id: "AC16", title: "allowlist، نرخ و بودجه در درگاه", status: "done", note: "آزموده." },
  { id: "AC17", title: "فروش زیر پوشش ۱۰۰٪ با هشدار", status: "sandbox", note: "بر اساس موجودی شبیه‌ساز." },
  { id: "AC18", title: "موجودی صفر درخواست را می‌بندد، سفارش باز است", status: "sandbox", note: "آزموده با شبیه‌ساز." },
  { id: "AC19", title: "موجودی کهنه: grace محدود سپس توقف", status: "sandbox", note: "قطع بررسی موجودی → دوره ارفاق → تأییدنشده؛ آزموده با شبیه‌ساز." },
  { id: "AC20", title: "ازسرگیری خودکار با موجودی تازه", status: "sandbox", note: "ازسرگیری ← سالم؛ آزموده با شبیه‌ساز." },
  { id: "AC21", title: "عدم ذخیره متن درخواست/پاسخ", status: "done", note: "متن ذخیره نمی‌شود (آزموده)؛ حذف ۳۶۵روزه فراداده در cron نگهداری پیاده شد." },
  { id: "AC22", title: "حسابرسی عامل، زمان، قبل/بعد و دلیل", status: "done", note: "برای تأیید/رد، نرخ، اصلاح اعتبار، بازپرداخت، تنظیمات و نقش." },
  { id: "AC23", title: "موبایل/تبلت/دسکتاپ و LTR برای کد", status: "done", note: "آزمون مرورگر بدون اسکرول افقی." },
  { id: "AC24", title: "تم‌ها و تمایز داده تأییدشده/برآوردی", status: "partial", note: "تم‌ها و WCAG آزموده؛ نمودارهای مالی هنوز «تأییدشده/کهنه/برآوردی» را جدا نمایش نمی‌دهند." },
  { id: "AC25", title: "حالت خالی، خطاهای قابل اصلاح، قطعی و تکرار", status: "done", note: "خطای بازه درون فیلد، حالت خالی وابسته به فیلتر، شمارش Retry-After و پیام‌های فارسی." },
];

const GATES: Item[] = [
  { id: "V01", title: "مجوز مکتوب فروش مجدد بالادست", status: "done", note: "قرارداد فروش مجدد با تأمین‌کننده اعلام شده؛ کلید reseller روی سرور." },
  { id: "V02–V05", title: "نرخ، واحد billable، موجودی و endpointها", status: "partial", note: "نرخ مشتری (پیش‌فرض ۲۰م/$) و نرخ بالادست (۲۵م/$) قابل تنظیم در ادمین است؛ بالادست به مشتری نشان داده نمی‌شود. مانده: صحت balance روی حساب reseller زیر بار." },
  { id: "V06–V09", title: "grace، کارت بانکی، مهلت و بازپرداخت", status: "partial", note: "کارت مقصد قابل ویرایش با پیش‌فرض؛ مانده: احراز مالکیت حساب، سیاست بازپرداخت و عدد نهایی grace." },
  { id: "V10–V12", title: "FX، پیامک و حریم خصوصی", status: "partial", note: "کاوه‌نگار Lookup برای OTP پیاده شد؛ مانده: منبع ارز و سیاست نگهداری رسید." },
  { id: "V13–V14", title: "حسابداری و SLA", status: "todo", note: "شناسایی درآمد، مالیات و ساعات بررسی." },
  { id: "V15–V18", title: "برند، میزبانی، شروع اعتبار و disputes", status: "todo", note: "دامنه نهایی، storage شیء رسید، مانیتورینگ و آزمون meter زیر بار." },
];

function Section({ title, desc, items, filter, query }: { title: string; desc: string; items: Item[]; filter: Status | "all"; query: string }) {
  const rows = items.filter(
    (i) =>
      (filter === "all" || i.status === filter) &&
      (!query || `${i.id} ${i.title} ${i.note}`.includes(query))
  );
  if (!rows.length) return null;
  const counts = Object.fromEntries((Object.keys(STATUS_FA) as Status[]).map(k => [k, items.filter(i => i.status === k).length])) as Record<Status, number>;
  return (
    <section className="panel padded prd-section">
      <div className="section-title">
        <div>
          <h2>{title}</h2>
          <p>{desc}</p>
        </div>
        <div className="prd-counts">
          {(Object.keys(STATUS_FA) as Status[]).filter(k => counts[k]).map(k => <span key={k} className={`prd-count ${k === "sandbox" ? "partial" : k}`}>{fa(counts[k])} {STATUS_FA[k].label}</span>)}
        </div>
      </div>
      <div className="prd-list">
        {rows.map((i) => (
          <div key={i.id} className={`prd-row prd-${i.status === "sandbox" ? "partial" : i.status}`}>
            <span className="prd-id" dir="ltr">{i.id}</span>
            <div>
              <strong>{i.title}</strong>
              <p>{i.note}</p>
            </div>
            <Badge tone={STATUS_FA[i.status].tone}>{STATUS_FA[i.status].label}</Badge>
          </div>
        ))}
      </div>
    </section>
  );
}

export function RoadmapView() {
  const { data } = useApp();
  const [filter, setFilter] = useState<Status | "all">("all");
  const [query, setQuery] = useState("");
  const all = useMemo(() => [...DECISIONS, ...CUSTOMER, ...ADMIN, ...ACCEPTANCE], []);
  const counts = Object.fromEntries((Object.keys(STATUS_FA) as Status[]).map(k => [k, all.filter(i => i.status === k).length])) as Record<Status, number>;
  void data;
  return (
    <div className="roadmap-page">
      <PageTitle title="وضعیت پیاده‌سازی PRD" description="کدام بخش‌های سند محصول در این پیش‌نمایش هست، کدام آزمایشی است و چه چیزی برای انتشار واقعی مانده." />
      <section className="panel padded prd-summary">
        <div className="section-title"><div><h2>جمع‌بندی مسیر</h2><p>وضعیت فعلی نسبت به هدف «پانا به‌عنوان ارائه‌دهنده»</p></div></div>
        <div className="prd-summary-grid">
          <div><strong>الان کجاییم</strong><p>کیف پول/FEFO/کلید پانا، کاتالوگ پلتفرم، پروکسی زنده و کلید بالادست اختصاصی هر کیف پول پیاده‌اند. مشتری نام تأمین‌کننده را نمی‌بیند.</p></div>
          <div><strong>هدف</strong><p>مشتری فقط با پانا کار کند: خرید اعتبار، مصرف مدل‌ها، گزارش، و API پایدار — بدون افشای بالادست.</p></div>
          <div><strong>ماندهٔ فنی/عملیاتی</strong><p>Kavenegar روی Vercel، PLATFORM_MODE=live، استریم، مانیتورینگ meter زیر بار.</p></div>
          <div><strong>ماندهٔ کسب‌وکار</strong><p>احراز کارت مقصد، سیاست بازپرداخت، FX خودکار (اختیاری؛ دستی کافی است)، SLA و دامنه/برند نهایی.</p></div>
        </div>
      </section>
      <div className="mini-stats">
        <div><span>پیاده‌سازی‌شده</span><strong>{fa(counts.done)}<small>از {fa(all.length)}</small></strong></div>
        <div><span>فقط در محیط آزمایشی</span><strong>{fa(counts.sandbox)}<small>مورد</small></strong></div>
        <div><span>نیمه‌کاره</span><strong>{fa(counts.partial)}<small>مورد</small></strong></div>
        <div><span>باقی‌مانده</span><strong>{fa(counts.todo)}<small>مورد</small></strong></div>
      </div>
      <section className="panel">
        <div className="table-toolbar">
          <SearchInput value={query} onChange={setQuery} placeholder="جست‌وجو در شناسه، عنوان یا توضیح..." />
          <div className="toolbar-actions" role="group" aria-label="فیلتر وضعیت">
            {(["all", "done", "sandbox", "partial", "todo"] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={`pill-btn ${filter === s ? "active" : ""}`}
                aria-pressed={filter === s}
                onClick={() => setFilter(s)}
              >
                {s === "all" ? "همه" : STATUS_FA[s].label}
              </button>
            ))}
          </div>
        </div>
      </section>
      <Section title="تصمیم‌های محصول (D01–D30)" desc="ثبت تصمیم‌های نه دور کشف محصول و اصلاحیه پرداخت." items={DECISIONS} filter={filter} query={query} />
      <Section title="صفحه‌های مشتری (C1–C8)" desc="معماری اطلاعات سمت مشتری طبق PRD." items={CUSTOMER} filter={filter} query={query} />
      <Section title="کنسول مدیریت (A1–A11)" desc="در این پیش‌نمایش: مدیر آزمایشی تک‌حسابه، نه سوپرادمین واقعی." items={ADMIN} filter={filter} query={query} />
      <Section title="معیارهای پذیرش (AC01–AC25)" desc="آزمون‌های انتشار بخش ۱۶ PRD؛ «آزموده» یعنی در اسکریپت‌های آزمون خودکار پوشش داده شده است." items={ACCEPTANCE} filter={filter} query={query} />
      <Section title="دروازه‌های تأیید (V01–V18)" desc="مواردی که بدون تأیید قرارداد، بانک، حقوقی و زیرساخت نباید واقعی شوند." items={GATES} filter={filter} query={query} />
      {filter !== "all" && query && <Empty title="موردی با این فیلتر پیدا نشد" text="فیلتر وضعیت یا عبارت جست‌وجو را تغییر دهید." icon="search" />}
    </div>
  );
}
