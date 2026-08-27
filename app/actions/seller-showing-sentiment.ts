"use server"

/**
 * app/actions/seller-showing-sentiment.ts
 *
 * Weekly heat-map summary the seller receives for any active listing they
 * own. Aggregates the existing showing_feedback rows (no new tables) into:
 *
 *   • aggregate sentiment (rolling 7d)
 *   • per-rating averages (presentation, cleanliness, overall_impression)
 *   • top positive themes + top objections (extracted with the LLM if
 *     configured; falls back to keyword bucketing)
 *   • pricing-pressure signal (interested vs not-interested ratio)
 *   • recommended next action for the agent
 *
 * Triggered by the seller-updates cron (Mondays 8am) and on-demand from
 * the listing detail page. All writes land in seller_updates.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateObjectRouted } from "@/lib/ai/models"
import { feedbackTemperatureToRating, tourInterestToRating } from "@/lib/behavior-learning/signal-mapping"
import { z } from "zod"

export interface ShowingSentimentSummary {
  listingId: string
  windowStart: string
  windowEnd: string
  showingCount: number
  feedbackCount: number
  averageSentiment: number | null
  averagePresentation: number | null
  averageCleanliness: number | null
  averageImpression: number | null
  highInterestCount: number
  lowInterestCount: number
  positiveThemes: string[]
  objections: string[]
  pricingPressure: "raise" | "hold" | "reduce" | "insufficient_data"
  recommendedAction: string
}

const ThemeExtractionSchema = z.object({
  positiveThemes: z.array(z.string()).max(5),
  objections: z.array(z.string()).max(5),
  oneLineRecommendation: z.string().max(160),
})

async function extractThemes(
  feedbackTexts: string[],
  /** Tenant for the AI cost ledger — the LISTING's own brokerage, resolved by
   *  the caller from a listings row, never from a request body (§4). Null =
   *  no tenant reached this lane and nothing books, which is honest. */
  spendActor: { brokerageId: string | null; userId: string | null },
) {
  // Routed via generateObjectRouted: gateway + AI_TASK_ROUTING + fallback model + fair-use + cost
  // accounting. Falls back to keyword bucketing when the gateway key is missing.
  if (!process.env.AI_GATEWAY_API_KEY || feedbackTexts.length === 0) {
    return null
  }
  try {
    const { object } = await generateObjectRouted({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId,
      feature: "sentiment_analysis",
      schema:  ThemeExtractionSchema,
      system:
        "You analyze buyer-side showing feedback for a single home and extract the most-mentioned positives and objections. " +
        "Themes must be short noun phrases (3-5 words). Combine near-duplicate feedback into a single theme. " +
        "The recommendation is for the listing agent — phrase it as one short next-step sentence.",
      prompt: feedbackTexts.slice(0, 30).join("\n---\n"),
    })
    return object
  } catch (err) {
    console.warn("[showing-sentiment] LLM theme extraction failed:", err)
    return null
  }
}

function bucketKeywords(texts: string[]) {
  const positives: Record<string, number> = {}
  const objections: Record<string, number> = {}
  const positivePatterns: Array<[string, RegExp]> = [
    ["Updated kitchen", /\b(updated|new|modern)\s+kitchen\b/i],
    ["Great natural light", /\b(natural light|bright|sunny)\b/i],
    ["Open floor plan", /\bopen\s+(floor\s+)?plan\b/i],
    ["Outdoor space", /\b(yard|patio|deck|outdoor)\b/i],
    ["Quiet street", /\bquiet\b/i],
    ["Nice finishes", /\b(finish|finishes)\b/i],
  ]
  const objectionPatterns: Array<[string, RegExp]> = [
    ["Price too high", /\b(over\s*priced|price\s*too\s*high|too\s*expensive)\b/i],
    ["Needs updates", /\b(dated|needs?\s+(updat|reno|work))\b/i],
    ["Small bedrooms", /\b(small|tiny|cramped).{0,15}(bed|room)\b/i],
    ["Busy street", /\b(busy|loud)\s+street\b/i],
    ["Parking concerns", /\bparking\b/i],
    ["Layout concerns", /\b(layout|flow|chopped|awkward)\b/i],
  ]
  for (const t of texts) {
    for (const [label, p] of positivePatterns) if (p.test(t)) positives[label] = (positives[label] ?? 0) + 1
    for (const [label, p] of objectionPatterns) if (p.test(t)) objections[label] = (objections[label] ?? 0) + 1
  }
  const top = (m: Record<string, number>) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)
  return { positiveThemes: top(positives), objections: top(objections) }
}

export async function buildShowingSentimentSummary(
  listingId: string,
  /** The listing's tenant + the acting user, for the AI cost ledger. Both
   *  callers already hold a listings row (the cron iterates them; the action
   *  reads one and checks it against the caller's own brokerage), so this is
   *  threaded rather than re-derived — and it is never a body value (§4). */
  spendActor: { brokerageId: string | null; userId: string | null } = { brokerageId: null, userId: null },
): Promise<ShowingSentimentSummary | null> {
  const supabase = createServiceClient()
  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - 7 * 86_400_000)

  const { data: showings } = await supabase
    .from("showings")
    .select(
      `id, scheduled_at,
       feedback:showing_feedback(
         id, sentiment_score, presentation_rating, cleanliness_rating,
         overall_impression, buyer_interest_level, ai_summary, additional_notes
       )`,
    )
    .eq("listing_id", listingId)
    .gte("scheduled_at", windowStart.toISOString())
    .lte("scheduled_at", windowEnd.toISOString())

  if (!showings || showings.length === 0) return null

  const allFeedback = showings.flatMap((s) => (Array.isArray(s.feedback) ? s.feedback : s.feedback ? [s.feedback] : []))
  if (allFeedback.length === 0) {
    return {
      listingId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      showingCount: showings.length,
      feedbackCount: 0,
      averageSentiment: null,
      averagePresentation: null,
      averageCleanliness: null,
      averageImpression: null,
      highInterestCount: 0,
      lowInterestCount: 0,
      positiveThemes: [],
      objections: [],
      pricingPressure: "insufficient_data",
      recommendedAction: "Follow up with showing agents — no written feedback received this week.",
    }
  }

  const avg = (vals: Array<number | null | undefined>) => {
    const nums = vals.filter((v): v is number => typeof v === "number")
    return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null
  }
  const averageSentiment = avg(allFeedback.map((f: any) => f.sentiment_score))
  const averagePresentation = avg(allFeedback.map((f: any) => f.presentation_rating))
  const averageCleanliness = avg(allFeedback.map((f: any) => f.cleanliness_rating))
  // WAS: avg(allFeedback.map((f) => f.overall_impression)) — and
  // `showing_feedback.overall_impression` is TEXT (live CHECK since m568:
  // love_it | like_it | maybe | no), while avg() keeps only `typeof v === "number"`.
  // So the filter kept nothing and this average was structurally null on every
  // listing, forever: the seller-sentiment panel's "Impression" figure has only
  // ever rendered as a dash. Same failure as the two counters below — a text
  // vocabulary read as if it were a number — so it is fixed on the same ladder.
  // m568 put the column on the ONE showing-verdict vocabulary, so the canonical
  // ladder reads it directly (impressionToRating, the old dialect's bridge, is
  // retired into tourInterestToRating — see signal-mapping.ts's tombstone).
  const averageImpression = avg(allFeedback.map((f: any) => tourInterestToRating(f.overall_impression)))

  // ONE VOCABULARY (CLAUDE.md §6). WAS:
  //   (f.buyer_interest_level ?? 0) >= 4   /   (f.buyer_interest_level ?? 0) <= 2
  // `showing_feedback.buyer_interest_level` is TEXT with the live CHECK
  // hot | warm | cool | cold, so both comparisons are `"hot" >= 4` — NaN, false on
  // every row, always. Nothing threw. Both counters were structurally 0, which is
  // not a harmless zero: lib/intelligence/showing-feedback-routing.ts sets
  // urgency = lowInterestCount >= highInterestCount ? "now" : "soon" (0 >= 0, so
  // permanently "now"), and its "raise" arm needs highInterestCount >= 3, so that
  // branch has never once been reachable. `interestRatio` below was 0 for the same
  // reason, making pricingPressure === "raise" unreachable here too.
  // The ladder is owned by lib/behavior-learning/signal-mapping.ts, which also
  // records WHY this column is a per-buyer TEMPERATURE and not a duplicate of
  // showings.buyer_interest_level. The author's own 4/2 thresholds are kept — only
  // the rungs are now values the column can actually hold.
  const highInterestCount = allFeedback.filter((f: any) => {
    const r = feedbackTemperatureToRating(f.buyer_interest_level)
    return r !== null && r >= 4
  }).length
  const lowInterestCount = allFeedback.filter((f: any) => {
    const r = feedbackTemperatureToRating(f.buyer_interest_level)
    return r !== null && r <= 2
  }).length

  const texts = allFeedback
    .map((f: any) => [f.ai_summary, f.additional_notes].filter(Boolean).join(" "))
    .filter((s: string) => s.length > 0)

  let positiveThemes: string[] = []
  let objections: string[] = []
  let recommendedAction = ""
  const themed = await extractThemes(texts, spendActor)
  if (themed) {
    positiveThemes = themed.positiveThemes
    objections = themed.objections
    recommendedAction = themed.oneLineRecommendation
  } else {
    const buckets = bucketKeywords(texts)
    positiveThemes = buckets.positiveThemes
    objections = buckets.objections
  }

  let pricingPressure: ShowingSentimentSummary["pricingPressure"] = "hold"
  const interestRatio = highInterestCount / Math.max(1, allFeedback.length)
  if (allFeedback.length < 3) pricingPressure = "insufficient_data"
  else if (objections.includes("Price too high") || (averageSentiment != null && averageSentiment < 0.35))
    pricingPressure = "reduce"
  else if (interestRatio > 0.6 && (averageSentiment ?? 0) > 0.7) pricingPressure = "raise"

  if (!recommendedAction) {
    recommendedAction =
      pricingPressure === "reduce"
        ? "Discuss a price adjustment — the price-too-high theme is repeating across showings."
        : pricingPressure === "raise"
          ? "Strong interest signals — consider holding firm and inviting offers."
          : "Tight feedback set — keep current strategy and re-evaluate next week."
  }

  return {
    listingId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    showingCount: showings.length,
    feedbackCount: allFeedback.length,
    averageSentiment,
    averagePresentation,
    averageCleanliness,
    averageImpression,
    highInterestCount,
    lowInterestCount,
    positiveThemes,
    objections,
    pricingPressure,
    recommendedAction,
  }
}

/** On-demand fetch from the listing detail page (auth + brokerage scoped). */
export async function getShowingSentimentSummaryAction(listingId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "unauthorized" }
  const { data: callerRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "unauthorized" }

  const { data: listing } = await supabase
    .from("listings")
    .select("brokerage_id")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return { success: false, error: "not_found" }
  if (listing.brokerage_id !== callerRow.brokerage_id) {
    return { success: false, error: "forbidden" }
  }

  const summary = await buildShowingSentimentSummary(listingId, {
    brokerageId: listing.brokerage_id ?? null,
    userId: user.id,
  })
  return { success: true, summary }
}
