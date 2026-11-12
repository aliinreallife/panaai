import { NextRequest, NextResponse } from "next/server";
import { runMaintenance } from "@/lib/maintenance";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") || "";
  return header === `Bearer ${secret}`;
}

/** Vercel Cron / manual ops: release stale reservations and purge 365-day usage metadata. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Missing or invalid CRON_SECRET." } }, { status: 401 });
  }
  try {
    const report = await runMaintenance({ reason: "cron" });
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error("maintenance.failed", { error });
    return NextResponse.json({ error: { code: "maintenance_failed", message: "Maintenance job failed." } }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
