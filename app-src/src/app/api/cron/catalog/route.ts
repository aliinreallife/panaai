import { NextRequest, NextResponse } from "next/server";
import { syncPlatformCatalog } from "@/lib/models";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") || "";
  return header === `Bearer ${secret}`;
}

/** Refresh the platform-owned model catalog from upstream (~hourly when Pro cron is available). */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Missing or invalid CRON_SECRET." } }, { status: 401 });
  }
  try {
    const result = await syncPlatformCatalog({ reason: "cron_catalog", force: true });
    return NextResponse.json({
      ok: result.ok,
      reason: result.reason,
      count: result.models.length,
      failures: result.meta.failures,
      syncedAt: result.meta.syncedAt,
      source: result.meta.source,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error("catalog.cron_failed", { error });
    return NextResponse.json({ error: { code: "catalog_sync_failed", message: "Catalog sync failed." } }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
