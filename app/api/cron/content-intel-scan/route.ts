/**
 * app/api/cron/content-intel-scan/route.ts
 *
 * Daily content-intelligence scan (burn-down round 5, owner spec):
 * competitor ORGANIC social + Facebook Ad Library content (what's getting the
 * most interaction, Exa citation-ranked) into competitor_content (+ ensures
 * the competitor_profiles twin the reader inner-joins), and popular-niche
 * content keyphrases into keyword_intelligence (7-day TTL, 'rising').
 *
 * Schedule: 0 10 * * * — daily 10:00 UTC, an hour BEFORE competitor-ads-exa
 * so the Marketing Studio's briefs have both organic + paid pictures.
 * Auth: CRON_SECRET dual scheme. No-op when EXA_API_KEY is missing.
 *
 * WAVE 154 (lane 154B, owner ruling R5(b)): the SEARCH-DEMAND pass runs first and does not need Exa — consented
 * first-party search statements, the tenant's own Search Console and regional trends become topic ideas for THE ONE
 * intake (lib/content-intel/search-demand.ts runSearchDemandCron). Producers without a grant report not_connected /
 * owner_held; until the intake is wired the pass reads, reports `intake_unwired` and stores nothing.
 */
import { NextResponse, type NextRequest } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { decideCronRun } from "@/lib/kernel/cron-logging"
import { createServiceClient } from "@/lib/supabase/service"
import { runContentIntelScan } from "@/lib/competitive-intel/content-intel-scan"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const denied = verifyCronAuth(req)
  if (denied) return denied
  const cronDoor = await decideCronRun({ cron_name: "content-intel-scan", cron_path: "/app/api/cron/content-intel-scan/route.ts" }) // cron decision door (155R1)
  if (cronDoor.held) return NextResponse.json({ success: true, held: true, decision: cronDoor.decision })

  const svc = createServiceClient()
  const sd = await import("@/lib/content-intel/search-demand")
  const searchDemand = await sd.runSearchDemandCron(svc, {
    intake: sd.productionTopicIntake,
    trends: sd.productionTrendsTransport(),
    searchConsole: sd.productionSearchConsoleTransport(),
  })

  if (!process.env.EXA_API_KEY) {
    return NextResponse.json({ ran_at: new Date().toISOString(), skipped: "EXA_API_KEY not configured", searchDemand })
  }

  const result = await runContentIntelScan(svc)
  return NextResponse.json({ ran_at: new Date().toISOString(), ...result, searchDemand })
}
