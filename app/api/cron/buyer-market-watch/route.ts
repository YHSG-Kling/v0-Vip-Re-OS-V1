/**
 * app/api/cron/buyer-market-watch/route.ts
 *
 * Wave 62 — SCHEDULED buyer market watch. For each active buyer (one property_preferences
 * row = a buyer with criteria), match their criteria against OUR active listings and write
 * property_matches (deterministic, idempotent). When a buyer gets NEW matches, enqueue the
 * deliverable-gated property-match reel (cooldown-idempotent). External RentCast/IDX
 * matching is layered on later (connector-gated, compliant display-only references).
 *
 * System-context: CRON_SECRET auth, service client, batched + sequential per item (one
 * failing buyer never aborts the run).
 */
import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
import { runMarketWatchForBuyer } from "@/lib/buyer-search/market-watch"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const BATCH = 150

export async function GET(request: Request) {
  const unauthorized = verifyCronAuth(request)
  if (unauthorized) return unauthorized

  const svc = createServiceClient()
  const ranAt = new Date().toISOString()
  let buyersProcessed = 0, buyersMatched = 0, buyersWithNew = 0, reelsQueued = 0, errors = 0

  try {
    // One property_preferences row per buyer = the "has criteria to match" signal (avoids
    // buyer_stage vocabulary drift). Oldest-calculated first so load spreads across runs.
    const { data: prefs } = await svc.from("property_preferences")
      .select("contact_id, brokerage_id")
      .not("contact_id", "is", null).not("brokerage_id", "is", null)
      .order("last_calculated_at", { ascending: true, nullsFirst: true })
      .limit(BATCH)
    const rows = (prefs ?? []) as Array<{ contact_id: string; brokerage_id: string }>

    for (const p of rows) {
      buyersProcessed++
      try {
        const r = await runMarketWatchForBuyer(svc, p.brokerage_id, p.contact_id)
        if (r.matched > 0) buyersMatched++
        if (r.newMatches > 0) {
          buyersWithNew++
          // Deliverable-gated touch: enqueue the personalized property-match reel
          // (cooldown-idempotent — at most one reel per buyer per week).
          try {
            const { produceBuyerMatchReel } = await import("@/lib/agents/buyer-match-reel-producer")
            const reel = await produceBuyerMatchReel(p.brokerage_id, p.contact_id, svc)
            if (reel.queued) reelsQueued++
          } catch { /* reel is best-effort */ }
        }
      } catch (e) {
        errors++
        console.error("[buyer-market-watch] buyer failed:", p.contact_id, (e as Error).message)
      }
    }
  } catch (e) {
    return NextResponse.json({ ran_at: ranAt, error: (e as Error).message, buyersProcessed }, { status: 500 })
  }

  return NextResponse.json({ ran_at: ranAt, buyersProcessed, buyersMatched, buyersWithNew, reelsQueued, errors })
}
