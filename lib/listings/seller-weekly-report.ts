// lib/listings/seller-weekly-report.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE builder for the SELLER WEEKLY REPORT — a factual weekly digest of a live listing's activity
// (showings, views, saves, inquiries, days-on-market, marketing reach) that the seller-mode portal
// surfaces so the seller stays informed and engaged between agent touches. Derived ONLY from evidence
// (showings / listing_metrics / feedback rows the runner gathers) per the Lifecycle contract — never
// fabricated. CLIENT-FACING-CAREFUL: it never shows the seller raw negative feedback quotes or scary
// "0" framing; low weeks are framed constructively (the agent is driving traffic) and honestly. No I/O.

export interface SellerWeeklyReportInput {
  /** Monday of the report week, YYYY-MM-DD. */
  weekStart: string
  showingsThisWeek: number
  totalShowings: number
  views: number
  saves: number
  inquiries: number
  daysOnMarket: number | null
  /** Showing-feedback sentiment counts for the listing (gentle, never quoted raw to the seller). */
  feedback: { positive: number; neutral: number; negative: number }
  /** Count of marketing channels actively promoting the listing (grounded, see marketing-channels.ts). */
  marketingChannelsActive: number
}

export type SellerMomentum = "strong" | "steady" | "building"

export interface SellerWeeklyReport {
  week_start: string
  headline: string
  momentum: SellerMomentum
  activity: {
    showings_this_week: number
    total_showings: number
    views: number
    saves: number
    inquiries: number
    days_on_market: number | null
    marketing_channels: number
  }
  feedback_note: string
  generated: true
}

/** PURE. Momentum from real activity — never alarms on a quiet week. */
export function deriveSellerMomentum(input: Pick<SellerWeeklyReportInput, "showingsThisWeek" | "saves" | "inquiries">): SellerMomentum {
  const heat = input.showingsThisWeek * 2 + (input.inquiries ?? 0) * 2 + Math.min(input.saves ?? 0, 20)
  if (heat >= 8) return "strong"
  if (heat >= 3) return "steady"
  return "building"
}

/** PURE. A gentle, client-safe feedback note — sentiment, never raw negative quotes to the seller. */
export function buildFeedbackNote(feedback: SellerWeeklyReportInput["feedback"]): string {
  const total = feedback.positive + feedback.neutral + feedback.negative
  if (total === 0) return "As buyers tour, your agent will gather their feedback and share what matters."
  if (feedback.positive >= feedback.negative && feedback.positive > 0) {
    return "Buyers are responding well — your agent will walk you through the detailed feedback."
  }
  // Even when feedback skews critical, the seller hears it constructively from their agent, not raw.
  return "Your agent is reviewing this week's buyer feedback and will share takeaways and any adjustments with you."
}

/** PURE. Build the seller-safe weekly digest from gathered evidence. */
export function buildSellerWeeklyReport(input: SellerWeeklyReportInput): SellerWeeklyReport {
  const momentum = deriveSellerMomentum(input)
  const parts: string[] = []
  if (input.showingsThisWeek > 0) parts.push(`${input.showingsThisWeek} showing${input.showingsThisWeek === 1 ? "" : "s"}`)
  if (input.saves > 0) parts.push(`${input.saves} save${input.saves === 1 ? "" : "s"}`)
  if (input.inquiries > 0) parts.push(`${input.inquiries} inquir${input.inquiries === 1 ? "y" : "ies"}`)

  const headline = parts.length > 0
    ? `${momentum === "strong" ? "Strong week" : momentum === "steady" ? "Steady interest" : "Building interest"} — ${parts.join(", ")} on your home this week.`
    : "Your agent is actively driving buyer traffic to your home this week — here's the latest."

  return {
    week_start: input.weekStart,
    headline,
    momentum,
    activity: {
      showings_this_week: input.showingsThisWeek,
      total_showings: input.totalShowings,
      views: input.views,
      saves: input.saves,
      inquiries: input.inquiries,
      days_on_market: input.daysOnMarket,
      marketing_channels: input.marketingChannelsActive,
    },
    feedback_note: buildFeedbackNote(input.feedback),
    generated: true,
  }
}

/** PURE. Monday (UTC) of the week containing `now`, as YYYY-MM-DD — the report's stable week key. */
export function weekStartMonday(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dow = d.getUTCDay() // 0=Sun..6=Sat
  const diff = (dow === 0 ? -6 : 1) - dow // back to Monday
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().slice(0, 10)
}
