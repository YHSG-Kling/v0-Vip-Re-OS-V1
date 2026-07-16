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
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runContentIntelScan } from "@/lib/competitive-intel/content-intel-scan"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs       = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (!process.env.EXA_API_KEY) {
    return NextResponse.json({ ran_at: new Date().toISOString(), skipped: "EXA_API_KEY not configured" })
  }

  const svc = createServiceClient()
  const result = await runContentIntelScan(svc)
  return NextResponse.json({ ran_at: new Date().toISOString(), ...result })
}
