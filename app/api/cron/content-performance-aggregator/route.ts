/**
 * app/api/cron/content-performance-aggregator/route.ts
 *
 * Wave 19 — daily 08:00 UTC. Walks recent content_topic_uses, reads
 * downstream engagement signals (newsletter open/click rates,
 * social_posts engagement, podcast plays), computes a rolling 0..30
 * performance_score, and writes back to content_topic_bank.
 *
 * The picker (pickTopics) adds performance_score to its adjusted score
 * so winning topics compound (next pick scores them higher) and flops
 * decay back toward 0 over the 30-day window.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { aggregatePerformance } from "@/lib/content-intel/performance-aggregator"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs   = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const result = await aggregatePerformance()
  return NextResponse.json({
    ran_at: new Date().toISOString(),
    ...result,
  })
}
