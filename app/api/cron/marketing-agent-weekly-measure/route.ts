/**
 * app/api/cron/marketing-agent-weekly-measure/route.ts
 *
 * Wave 25 — fills realized_* columns on marketing_agent_weekly_outcomes
 * for last week's plan windows so Monday's spawn shows the agent its own
 * track record.
 *
 * Schedule: Sun 22:30 UTC — BEFORE Monday 09:00 UTC marketing-agent-weekly
 * spawn. The 10.5-hour buffer ensures newsletter_sends from late-Sunday
 * sends have landed (publish-newsletters runs hourly until 23:59 Sun) and
 * leaves a safety margin for cron retries.
 *
 * Pipeline per unrealized row (realized_at IS NULL):
 *   1. Compute the week's [Mon 00:00, Sun 23:59:59.999] UTC bounds from
 *      week_start.
 *   2. Count newsletter_campaigns sent in the window for this brokerage.
 *   3. Aggregate newsletter_sends in the window:
 *        · total recipient sends
 *        · weighted open rate  = SUM(opened_at not null)  / SUM(sent) * 100
 *        · weighted click rate = SUM(clicked_at not null) / SUM(sent) * 100
 *   4. Compute per-persona breakdown via newsletter_sends ⨝ contacts.
 *   5. Score the plan 0..100 using a transparent rubric:
 *        + 30 for shipping at least one campaign
 *        + open_rate × 0.4   (40 pts at 100% open)
 *        + click_rate × 0.4  (40 pts at 100% click)
 *      Capped at 100. Score is heuristic; the explanation lives in the
 *      realized columns so consumers can re-derive.
 *   6. Stamp realized_at + write the row.
 *
 * Auth: CRON_SECRET (same pattern as the rest of the cron fleet).
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface PendingRow {
  id:                          string
  brokerage_id:                string
  week_start:                  string
}

export async function GET(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs       = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return unauthorized()

  const svc = createServiceClient()

  // Pull all unrealized rows whose week has ENDED (week_start ≤ today-7).
  // Cap at 100 per tick — a brokerage backfill never blocks a fresh week.
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const cutoff = new Date(today)
  cutoff.setUTCDate(cutoff.getUTCDate() - 7)
  const cutoffDate = cutoff.toISOString().slice(0, 10)

  const { data: pending, error } = await svc
    .from("marketing_agent_weekly_outcomes")
    .select("id, brokerage_id, week_start")
    .is("realized_at", null)
    .lte("week_start", cutoffDate)
    .order("week_start", { ascending: true })
    .limit(100)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ id: string; outcome: string; reason?: string }> = []
  for (const row of (pending ?? []) as PendingRow[]) {
    try {
      const measured = await measureWeek(svc, row.brokerage_id, row.week_start)
      const score = scorePlan(measured)
      await svc.from("marketing_agent_weekly_outcomes")
        .update({
          realized_at:                new Date().toISOString(),
          realized_campaigns_sent:    measured.campaigns_sent,
          realized_recipient_sends:   measured.recipient_sends,
          realized_open_rate:         measured.open_rate,
          realized_click_rate:        measured.click_rate,
          realized_persona_breakdown: measured.persona_breakdown,
          plan_quality_score:         score,
        }).eq("id", row.id)
      // MANAGERS TALKING — a strong organic week (real engagement, not vanity): the
      // Marketing Manager tells the Ads Manager to propose paid promotion while it's hot.
      if (measured.campaigns_sent >= 1 && (measured.open_rate >= 40 || measured.click_rate >= 10)) {
        try {
          const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
          await publishManagerSignal({
            brokerageId: row.brokerage_id,
            fromManager: "marketing_agent",
            toManager: "ads_manager",
            signalType: "content_winner",
            message: `Week of ${row.week_start}: ${measured.open_rate.toFixed(0)}% open / ${measured.click_rate.toFixed(0)}% click across ${measured.campaigns_sent} campaign(s) — organic winner.`,
            entityType: "marketing_week",
            entityId: row.id,
            payload: { week_start: row.week_start, open_rate: measured.open_rate, click_rate: measured.click_rate, campaigns_sent: measured.campaigns_sent },
          }, svc)
        } catch (e) {
          console.error("[weekly-measure] content_winner signal failed:", e)
        }
      }
      results.push({ id: row.id, outcome: `measured:${score}` })
    } catch (e) {
      results.push({ id: row.id, outcome: "failed", reason: (e as Error).message })
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    rows_processed: results.length,
    results,
  })
}

interface MeasuredWeek {
  campaigns_sent:     number
  recipient_sends:    number
  open_rate:          number
  click_rate:         number
  persona_breakdown:  Array<{ persona: string; sends: number; open_rate: number; click_rate: number }>
}

async function measureWeek(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  weekStart: string,
): Promise<MeasuredWeek> {
  // Week bounds — Monday 00:00 UTC through Sunday 23:59:59.999 UTC.
  const startIso = `${weekStart}T00:00:00.000Z`
  const endDate  = new Date(`${weekStart}T00:00:00.000Z`)
  endDate.setUTCDate(endDate.getUTCDate() + 7)
  const endIso = endDate.toISOString()

  // 1. Campaigns sent in window
  const { count: campaignsSent } = await svc
    .from("newsletter_campaigns")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId)
    .eq("status", "sent")
    .gte("send_date", startIso)
    .lt("send_date", endIso)

  // 2. Aggregate sends + per-persona breakdown in one batch read.
  const { data: sends } = await svc
    .from("newsletter_sends")
    .select("opened_at, clicked_at, contact:contacts!newsletter_sends_contact_id_fkey(contact_persona)")
    .eq("brokerage_id", brokerageId)
    .gte("sent_at", startIso)
    .lt("sent_at", endIso)
    .limit(50000)

  let total = 0, opened = 0, clicked = 0
  const personaBuckets = new Map<string, { sent: number; opened: number; clicked: number }>()
  for (const row of (sends ?? []) as Array<{
    opened_at: string | null
    clicked_at: string | null
    contact?: { contact_persona?: string | null } | Array<{ contact_persona?: string | null }> | null
  }>) {
    const cobj = Array.isArray(row.contact) ? row.contact[0] : row.contact
    const persona = (cobj?.contact_persona ?? "").trim()
    // Code-review pass 2 — the persona breakdown and the global rate must
    // share a denominator. Previously `total++` ran BEFORE the null-persona
    // check, so null-persona rows counted in the global rate but not in any
    // persona bucket. The agent's snapshot then surfaced rates that didn't
    // add up: "global open=58%, FTB=60%, investor=20%, sum=?"  Now both
    // counters skip null-persona rows, so the global rate represents the
    // attributed audience exactly.
    if (!persona) continue
    total++
    if (row.opened_at)  opened++
    if (row.clicked_at) clicked++
    const cur = personaBuckets.get(persona) ?? { sent: 0, opened: 0, clicked: 0 }
    cur.sent++
    if (row.opened_at)  cur.opened++
    if (row.clicked_at) cur.clicked++
    personaBuckets.set(persona, cur)
  }

  const openRate  = total > 0 ? Math.round((opened  / total) * 10000) / 100 : 0
  const clickRate = total > 0 ? Math.round((clicked / total) * 10000) / 100 : 0
  const personaBreakdown = [...personaBuckets.entries()]
    .filter(([, s]) => s.sent >= 5)
    .map(([persona, s]) => ({
      persona,
      sends:      s.sent,
      open_rate:  Math.round((s.opened  / s.sent) * 10000) / 100,
      click_rate: Math.round((s.clicked / s.sent) * 10000) / 100,
    }))
    .sort((a, b) => b.click_rate - a.click_rate)

  return {
    campaigns_sent:    campaignsSent ?? 0,
    recipient_sends:   total,
    open_rate:         openRate,
    click_rate:        clickRate,
    persona_breakdown: personaBreakdown,
  }
}

/** Transparent rubric — 30 for ship + open_rate × 0.4 + click_rate × 0.4, cap 100. */
function scorePlan(m: MeasuredWeek): number {
  let score = 0
  if (m.campaigns_sent > 0) score += 30
  score += m.open_rate  * 0.4
  score += m.click_rate * 0.4
  return Math.max(0, Math.min(100, Math.round(score)))
}
