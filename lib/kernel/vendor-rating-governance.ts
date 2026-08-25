// lib/kernel/vendor-rating-governance.ts
//
// VENDOR RATING GOVERNANCE (deal_coordinator) — the marketplace's QUALITY gate, the VendorInsightManager
// concept. The bench already rolls up ratings (recalculateVendorRatings → vendor_ratings), but NOTHING
// consumed them: a vendor could slide to two stars and still be auto-proposed to agents and clients. This
// turns the rollup into governance:
//   · a vendor averaging below SUPPRESS_BELOW (with enough sample) is SUPPRESSED — never auto-picked by the
//     orchestration bench (silent to the vendor; the admin is told via the brief) — client protection.
//   · a vendor slipping below FLAG_BELOW, or carrying repeated one-stars, is FLAGGED for admin review.
//   · a consistently-excellent vendor EARNS a badge (Top Rated ≥4.5/10+, Highly Recommended ≥4.8/20+).
// HONEST: below MIN_SAMPLE ratings there is no verdict (thin data never suppresses or badges). Pure core +
// a gated weekly admin brief; NO new tables — pure reuse of vendor_ratings.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** Below this many rated bookings, a vendor has no rating verdict (honest — thin data isn't a signal). */
export const MIN_SAMPLE = 3
/** Average below this (with sample) → suppressed from auto-surfacing. */
export const SUPPRESS_BELOW = 3.0
/** Average below this (with FLAG_MIN_SAMPLE) → flagged for admin review. */
export const FLAG_BELOW = 3.5
export const FLAG_MIN_SAMPLE = 5
/** Repeated one-star ratings → flag for admin review regardless of average. */
export const ONE_STAR_ALERT = 3
// TOMBSTONE (orphan doctrine §1.3) — these names are no longer exported: TOP_RATED_MIN, TOP_RATED_SAMPLE.
// Nothing in the product imported them, and no simulator did either; the
// values are live and unchanged, reached through this module's own exported
// functions, which is where callers already get their effect. Same ruling and same
// reasoning as lib/vendors/appraiser-independence.ts (isAppraiserTrade,
// labelNamesAppraisal): an export with no importer is a public surface nobody
// asked for, and the wire to build is not a second copy of the module's door.
/** Badge thresholds. */
const TOP_RATED_MIN = 4.5
const TOP_RATED_SAMPLE = 10
export const HIGHLY_RECOMMENDED_MIN = 4.8
export const HIGHLY_RECOMMENDED_SAMPLE = 20

export type RatingTier = "unrated" | "ok" | "flagged" | "suppressed"
export type VendorBadge = "top_rated" | "highly_recommended"

export interface RatingSignals {
  avgAgentRating: number | null
  avgClientRating: number | null
  sampleSize: number
  oneStarCount: number
}

export interface RatingHealth {
  tier: RatingTier
  /** The blended average used for the verdict (client + agent), or null when unrated. */
  avg: number | null
  sampleSize: number
  badges: VendorBadge[]
  reasons: string[]
  /** Excluded from auto-surfacing / the orchestration auto-pick. */
  suppressed: boolean
}

/** PURE: blend the client + agent averages (both matter; client experience weighs equally with reliability). */
export function blendedAvg(avgAgent: number | null, avgClient: number | null): number | null {
  const vals = [avgClient, avgAgent].filter((v): v is number => typeof v === "number" && v > 0)
  if (vals.length === 0) return null
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100
}

/**
 * PURE: classify a vendor's rating health. Honest sample-gating: below MIN_SAMPLE there is no verdict
 * (unrated → never suppressed, never badged). Suppression (avg < 3.0) is the marketplace refusing to
 * auto-push a poorly-rated vendor onto a client; a flag (avg < 3.5 with sample, or repeated one-stars)
 * asks a human to look; a badge rewards sustained excellence.
 */
export function computeRatingHealth(s: RatingSignals): RatingHealth {
  const avg = blendedAvg(s.avgAgentRating, s.avgClientRating)
  const reasons: string[] = []

  if (avg == null || s.sampleSize < MIN_SAMPLE) {
    return { tier: "unrated", avg, sampleSize: s.sampleSize, badges: [], reasons: [], suppressed: false }
  }

  if (avg < SUPPRESS_BELOW) {
    reasons.push(`Average ${avg.toFixed(1)}★ over ${s.sampleSize} bookings — below the ${SUPPRESS_BELOW.toFixed(1)}★ floor.`)
    return { tier: "suppressed", avg, sampleSize: s.sampleSize, badges: [], reasons, suppressed: true }
  }

  const flaggedLowAvg = avg < FLAG_BELOW && s.sampleSize >= FLAG_MIN_SAMPLE
  const flaggedOneStars = s.oneStarCount >= ONE_STAR_ALERT
  if (flaggedLowAvg || flaggedOneStars) {
    if (flaggedLowAvg) reasons.push(`Average ${avg.toFixed(1)}★ over ${s.sampleSize} bookings — slipping toward the floor.`)
    if (flaggedOneStars) reasons.push(`${s.oneStarCount} one-star ratings on record — worth a closer look.`)
    return { tier: "flagged", avg, sampleSize: s.sampleSize, badges: [], reasons, suppressed: false }
  }

  const badges: VendorBadge[] = []
  if (avg >= HIGHLY_RECOMMENDED_MIN && s.sampleSize >= HIGHLY_RECOMMENDED_SAMPLE) badges.push("highly_recommended")
  if (avg >= TOP_RATED_MIN && s.sampleSize >= TOP_RATED_SAMPLE) badges.push("top_rated")
  return { tier: "ok", avg, sampleSize: s.sampleSize, badges, reasons, suppressed: false }
}

/** A vendor_ratings row (only the columns we govern on). */
export interface VendorRatingRow {
  vendor_id: string
  avg_agent_rating: number | null
  avg_client_rating: number | null
  total_bookings: number | null
  one_star_count: number | null
}

/** PURE: map raw rating rows → health by vendor id. */
export function healthByVendor(rows: VendorRatingRow[]): Map<string, RatingHealth> {
  const out = new Map<string, RatingHealth>()
  for (const r of rows) {
    out.set(r.vendor_id, computeRatingHealth({
      avgAgentRating: r.avg_agent_rating,
      avgClientRating: r.avg_client_rating,
      sampleSize: r.total_bookings ?? 0,
      oneStarCount: r.one_star_count ?? 0,
    }))
  }
  return out
}

/**
 * Load the set of vendor ids SUPPRESSED for a brokerage (avg below the floor, with sample). The
 * orchestration bench excludes these from its auto-pick so a poorly-rated vendor is never auto-proposed.
 * Best-effort: on any read failure, returns an empty set (fail-open — a rating read must never block a
 * legitimate vendor recommendation).
 */
export async function loadSuppressedVendorIds(svc: Svc, brokerageId: string): Promise<Set<string>> {
  try {
    const { data } = await svc.from("vendor_ratings")
      .select("vendor_id, avg_agent_rating, avg_client_rating, total_bookings, one_star_count")
      .eq("brokerage_id", brokerageId).limit(5000)
    const health = healthByVendor((data ?? []) as VendorRatingRow[])
    const out = new Set<string>()
    for (const [id, h] of health) if (h.suppressed) out.add(id)
    return out
  } catch {
    return new Set<string>()
  }
}

export interface RatingGovernanceResult {
  scored: number
  suppressed: number
  flagged: number
  badged: number
  briefProposed: boolean
}

/**
 * Govern a brokerage's vendor ratings and propose ONE gated weekly admin brief naming the suppressed +
 * flagged vendors (and any that earned a badge). Deduped per (brokerage, ISO week). Owner deal_coordinator.
 */
export async function runVendorRatingGovernance(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<RatingGovernanceResult> {
  const out: RatingGovernanceResult = { scored: 0, suppressed: 0, flagged: 0, badged: 0, briefProposed: false }
  const now = params.now ?? new Date()

  const { data: ratings } = await svc.from("vendor_ratings")
    .select("vendor_id, avg_agent_rating, avg_client_rating, total_bookings, one_star_count")
    .eq("brokerage_id", params.brokerageId).limit(5000)
  const rows = (ratings ?? []) as VendorRatingRow[]
  if (rows.length === 0) return out
  const health = healthByVendor(rows)
  out.scored = health.size

  const suppressed: Array<{ id: string; h: RatingHealth }> = []
  const flagged: Array<{ id: string; h: RatingHealth }> = []
  const badged: Array<{ id: string; h: RatingHealth }> = []
  for (const [id, h] of health) {
    if (h.tier === "suppressed") suppressed.push({ id, h })
    else if (h.tier === "flagged") flagged.push({ id, h })
    else if (h.badges.length > 0) badged.push({ id, h })
  }
  out.suppressed = suppressed.length; out.flagged = flagged.length; out.badged = badged.length
  if (suppressed.length === 0 && flagged.length === 0) return out  // badges alone don't warrant an alert

  // Names for the brief.
  const ids = Array.from(new Set([...suppressed, ...flagged, ...badged].map((x) => x.id)))
  const { data: vendors } = await svc.from("vendors").select("id, name").in("id", ids).limit(2000)
  const nameById = new Map<string, string | null>(((vendors ?? []) as any[]).map((v) => [v.id, v.name]))
  const nm = (id: string) => nameById.get(id) ?? "A vendor"

  const { isoWeekKey } = await import("@/lib/recruiting/switch-propensity-scout")
  const dedupeTag = `VENDOR QUALITY — ${isoWeekKey(now)}`
  const { data: prior } = await svc.from("agent_client_messages").select("id")
    .eq("brokerage_id", params.brokerageId).eq("entity_type", "brokerage").eq("entity_id", params.brokerageId)
    .eq("agent_kind", "deal_coordinator").ilike("rationale", `${dedupeTag}%`).limit(1).maybeSingle()
  if (prior) return out

  const lines: string[] = []
  if (suppressed.length > 0) {
    lines.push(`These vendors have dropped below the quality floor and are no longer auto-recommended to your clients (they haven't been told — that's your call):`)
    lines.push(...suppressed.slice(0, 6).map((s) => `• ${nm(s.id)} — ${s.h.reasons[0]}`))
  }
  if (flagged.length > 0) {
    lines.push(`Worth a review before they slip further:`)
    lines.push(...flagged.slice(0, 6).map((f) => `• ${nm(f.id)} — ${f.h.reasons.join(" ")}`))
  }
  if (badged.length > 0) {
    lines.push(`Standouts you can feature with confidence:`)
    lines.push(...badged.slice(0, 6).map((b) => `• ${nm(b.id)} — ${b.h.badges.map((x) => x === "highly_recommended" ? "Highly Recommended" : "Top Rated").join(", ")} (${b.h.avg?.toFixed(1)}★ over ${b.h.sampleSize}).`))
  }

  try {
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: params.brokerageId, agentKind: "deal_coordinator", entityType: "brokerage", entityId: params.brokerageId,
      recipientContactId: null, audience: "agent",
      subject: `Vendor quality: ${suppressed.length} suppressed, ${flagged.length} to review`,
      body: lines.join("\n\n"),
      rationale: `${dedupeTag} — ${suppressed.length} suppressed / ${flagged.length} flagged / ${badged.length} badged; review before it reaches the broker.`,
      channel: "portal",
    }, svc)
    out.briefProposed = res.ok
  } catch { /* best-effort */ }
  return out
}

/** Autonomous: govern every brokerage's vendor ratings (rides the daily vendor-orchestration cron). */
export async function runVendorRatingGovernanceAll(svc: Svc, now?: Date): Promise<{ brokerages: number; suppressed: number; flagged: number; briefs: number }> {
  const out = { brokerages: 0, suppressed: 0, flagged: 0, briefs: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try {
      const r = await runVendorRatingGovernance(svc, { brokerageId: b.id, now })
      out.suppressed += r.suppressed; out.flagged += r.flagged; if (r.briefProposed) out.briefs++
    } catch { /* keep going */ }
  }
  return out
}
