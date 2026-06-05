/**
 * app/api/cron/open-house-reminder/route.ts
 *
 * Wave 27 — fires open_house_reminder promos 24-25 hours before a
 * scheduled open house. Runs hourly; the 1-hour window prevents
 * double-firing across ticks AND ensures every open house gets exactly
 * one reminder regardless of when it was created.
 *
 * Idempotency: listing_promo_videos has a partial unique index on
 * (listing_id, event_type), so a duplicate reminder insert hits 23505
 * and returns status='already_queued' from the reactor. The 1-hour
 * window minimizes wasted dispatcher calls but the unique index is the
 * real guarantee.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function GET(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs       = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return unauthorized()

  const svc = createServiceClient()

  // Window: events starting between (now + 24h) and (now + 25h). Hourly
  // tick → each event falls in exactly one window across its lifetime.
  // event_date is the canonical date column on open_house_events; start_time
  // narrows to the hour-of-day for the comparison.
  const now           = new Date()
  const windowStart   = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const windowEnd     = new Date(now.getTime() + 25 * 60 * 60 * 1000)

  // event_date stores a DATE; we need to combine with start_time TEXT to
  // form a timestamp. Postgres-side `(event_date::timestamp + start_time::time)`
  // does this in one expression but the Supabase JS client can't express it
  // cleanly without a stored function. Pull a wide window in JS then narrow:
  // events whose event_date is today, tomorrow, or day-after.
  const dateCutoffStart = windowStart.toISOString().slice(0, 10)
  const dateCutoffEnd   = new Date(windowEnd.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const { data: events, error } = await svc
    .from("open_house_events")
    .select("id, listing_id, brokerage_id, agent_id, event_date, start_time, status")
    .gte("event_date", dateCutoffStart)
    .lte("event_date", dateCutoffEnd)
    .in("status", ["scheduled", "confirmed"])
    .limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ open_house_id: string; outcome: string; reason?: string }> = []
  for (const row of (events ?? []) as Array<{
    id: string; listing_id: string | null; brokerage_id: string | null;
    agent_id: string | null; event_date: string | null; start_time: string | null;
    status: string | null
  }>) {
    if (!row.listing_id || !row.brokerage_id || !row.agent_id || !row.event_date) {
      results.push({ open_house_id: row.id, outcome: "skipped", reason: "missing required fields" })
      continue
    }
    // Compose event timestamp (UTC interpretation of stored date+time).
    const eventTs = new Date(`${row.event_date}T${row.start_time ?? "00:00:00"}Z`)
    const msUntil = eventTs.getTime() - now.getTime()
    if (msUntil < 24 * 60 * 60 * 1000 || msUntil >= 25 * 60 * 60 * 1000) {
      // Outside the T-24h window for this tick — skip silently.
      continue
    }
    try {
      const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
      const agentUserId = await resolveAgentRecordToUserId(row.agent_id)
      if (!agentUserId) {
        results.push({ open_house_id: row.id, outcome: "skipped", reason: "agent user id unresolved" })
        continue
      }
      const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
      const r = await dispatchListingPromoVideo({
        brokerageId:  row.brokerage_id,
        listingId:    row.listing_id,
        agentUserId,
        eventType:    "open_house_reminder",
        eventContext: {
          event_date: `${row.event_date} ${row.start_time ?? ""}`.trim(),
        },
      })
      // Wave 36 — DELIBERATELY no mail dispatch here. T-24h is too late
      // for Lob (first-class transit 4-7 days). The mail for an open
      // house ships from OPEN_HOUSE_SCHEDULED via the lifecycle reactor
      // wired in kernel/event-reactor.ts; that fires as soon as the
      // event is scheduled, giving the postcard real lead time. This
      // cron stays video + SMS + email only.
      results.push({ open_house_id: row.id, outcome: r.status, reason: r.reason })
    } catch (e) {
      results.push({ open_house_id: row.id, outcome: "failed", reason: (e as Error).message })
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    candidates: events?.length ?? 0,
    dispatched: results.length,
    results,
  })
}
