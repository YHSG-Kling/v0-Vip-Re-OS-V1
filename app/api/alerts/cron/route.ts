/**
 * app/api/alerts/cron/route.ts
 * Vercel Cron: GET every 15 minutes.
 * Secured with CRON_SECRET header.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient }       from "@/lib/supabase/service"
import { runAlertEngine }            from "@/lib/alerts/alert-engine"

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // 1. Verify CRON_SECRET
  const secret = req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("cron_secret")
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()

  // 2. Fetch all distinct brokerage_ids with active alerts
  const { data: rows, error } = await supabase
    .from("property_alerts")
    .select("brokerage_id")
    .eq("is_active", true)
    .neq("frequency", "paused")

  if (error) {
    console.error("[alerts/cron] failed to fetch brokerages:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const brokerageIds = [...new Set((rows ?? []).map((r: any) => r.brokerage_id).filter(Boolean))]

  if (!brokerageIds.length) {
    return NextResponse.json({ message: "No active alerts", brokeragesProcessed: 0 })
  }

  // 3. Run alert engine per brokerage
  const summary: Record<string, any> = {}

  for (const brokerageId of brokerageIds) {
    try {
      const result = await runAlertEngine(brokerageId)
      summary[brokerageId] = result
    } catch (err: any) {
      console.error(`[alerts/cron] engine error for ${brokerageId}:`, err?.message)
      summary[brokerageId] = { error: err?.message }
    }
  }

  // 4. Return summary
  return NextResponse.json({
    brokeragesProcessed: brokerageIds.length,
    ranAt:               new Date().toISOString(),
    summary,
  })
}
