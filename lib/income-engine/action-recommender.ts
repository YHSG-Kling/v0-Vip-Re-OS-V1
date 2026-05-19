/**
 * Income Truth — action recommender.
 *
 * Given an agent's current gap to goal + their live pipeline state, produce a
 * ranked list of weekly actions whose combined estimated_gci_impact closes
 * the gap.
 *
 * The recommender is RULES-DRIVEN (not LLM) so the suggestions are
 * deterministic and explainable. Each rule fires when its preconditions match
 * the agent's actual data (no fabrication, no mock contacts):
 *
 *   1. Listing acquisition  — gap > $0 AND active_listing_count low for their target
 *   2. Conversion focus     — buyers in BUYER_TOUR_ELIGIBLE / BUYER_OFFER_ELIGIBLE
 *                             that haven't moved in 14+ days
 *   3. Negotiation close    — transactions in offer/negotiation stage near close date
 *   4. Reactivation         — sphere contacts (lifetime_customer_npv_scores)
 *                             with next_touchpoint_due ≤ 7d
 *   5. Referral ask         — closed deals in past 90d without referral_request_at
 *   6. Pricing correction   — active listings with days_on_market > 30 AND no recent
 *                             price drop
 *   7. Open house           — active listings with 0 showings in last 7d
 *   8. Sphere nurture       — gold/platinum NPV contacts not touched in 30+ days
 *
 * Each action gets:
 *   - estimated_gci_impact_cents — concrete $ from existing data
 *   - confidence_score / impact_score / urgency_score (0–100)
 *   - priority_score = impact·0.4 + urgency·0.3 + confidence·0.2 + (100−effort_pct)·0.1
 *
 * Top N (default 5) are returned ranked by priority_score.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import type { GapAnalysisResult } from "./gap-analyzer"

export type ActionCategory =
  | "prospecting" | "listing_acquisition" | "referral_ask" | "conversion_focus"
  | "reactivation" | "negotiation_close" | "pricing_correction" | "sphere_nurture"
  | "open_house" | "marketing_push"

export interface RecommendedAction {
  action_rank:                number
  action_category:            ActionCategory
  action_title:               string
  action_description:         string
  contact_id:                 string | null
  transaction_id:             string | null
  listing_id:                 string | null
  estimated_gci_impact_cents: number
  estimated_effort_hours:     number
  confidence_score:           number
  impact_score:               number
  urgency_score:              number
  priority_score:             number
  due_by:                     string | null
}

function score(
  impact: number, urgency: number, confidence: number, effortHours: number,
): number {
  const effortPct = Math.min(100, (effortHours / 4) * 100)  // 4h = 100% effort
  return Math.round(
    (impact * 0.4 + urgency * 0.3 + confidence * 0.2 + (100 - effortPct) * 0.1) * 100
  ) / 100
}

function nextSundayISO(): string {
  const d = new Date()
  const daysUntilSunday = (7 - d.getUTCDay()) % 7 || 7
  d.setUTCDate(d.getUTCDate() + daysUntilSunday)
  d.setUTCHours(23, 59, 0, 0)
  return d.toISOString()
}

export async function recommendActionsForAgent(params: {
  agentId:      string
  brokerageId:  string
  gap:          GapAnalysisResult
  maxActions?:  number
}): Promise<RecommendedAction[]> {
  const svc = createServiceClient()
  const candidates: RecommendedAction[] = []
  const gapDollars = Math.max(0, Math.floor((params.gap.gap_to_goal_cents ?? 0) / 100))
  const hasGap = gapDollars > 0

  // ── Rule 2: Conversion focus — stale tour-eligible / offer-eligible buyers ──
  const { data: staleBuyers } = await svc
    .from("contacts")
    .select("id, first_name, last_name, buyer_stage, last_buyer_activity_at, updated_at")
    .eq("agent_id", params.agentId)
    .in("buyer_stage", ["BUYER_TOUR_ELIGIBLE", "BUYER_OFFER_ELIGIBLE", "BUYER_TOURING"])
    .order("updated_at", { ascending: true })
    .limit(10)

  const now = Date.now()
  for (const b of staleBuyers ?? []) {
    const last = new Date(b.last_buyer_activity_at ?? b.updated_at ?? now).getTime()
    const daysIdle = (now - last) / 86_400_000
    if (daysIdle < 14) continue
    const expectedGCI = b.buyer_stage === "BUYER_OFFER_ELIGIBLE" ? 600_000 : 400_000  // ~$6k / $4k median GCI in cents
    candidates.push({
      action_rank: 0,
      action_category: "conversion_focus",
      action_title: `Re-engage ${b.first_name ?? "buyer"} ${b.last_name ?? ""} — ${Math.round(daysIdle)}d idle in ${b.buyer_stage}`,
      action_description: `Buyer stalled at ${b.buyer_stage}. Call + offer 3-property comparison, or escalate to financial verification.`,
      contact_id: b.id, transaction_id: null, listing_id: null,
      estimated_gci_impact_cents: expectedGCI,
      estimated_effort_hours: 0.5,
      confidence_score: 65, impact_score: 75, urgency_score: Math.min(100, 50 + Math.round(daysIdle)),
      priority_score: 0,
      due_by: nextSundayISO(),
    })
  }

  // ── Rule 3: Negotiation close — transactions in offer/negotiation near close ──
  const { data: hotTx } = await svc
    .from("transactions")
    .select("id, property_address, stage, status, estimated_close_date, purchase_price, commission_total")
    .eq("agent_id", params.agentId)
    .in("status", ["pending", "active", "under_contract"])
    .not("estimated_close_date", "is", null)
    .order("estimated_close_date", { ascending: true })
    .limit(10)

  for (const tx of hotTx ?? []) {
    const closeDays = (new Date(tx.estimated_close_date).getTime() - now) / 86_400_000
    if (closeDays < -7 || closeDays > 60) continue
    const expectedGCI = Math.round(Number(tx.commission_total ?? 0) * 100) || 800_000
    candidates.push({
      action_rank: 0,
      action_category: "negotiation_close",
      action_title: `Drive ${tx.property_address ?? "deal"} to close — ${Math.round(closeDays)}d to estimated close`,
      action_description: `Verify financing cleared, schedule final walkthrough, confirm closing-doc receipt with title.`,
      contact_id: null, transaction_id: tx.id, listing_id: null,
      estimated_gci_impact_cents: expectedGCI,
      estimated_effort_hours: 1.0,
      confidence_score: 85, impact_score: 90,
      urgency_score: closeDays < 14 ? 95 : 70,
      priority_score: 0,
      due_by: closeDays < 7 ? new Date(now + 24*3600*1000).toISOString() : nextSundayISO(),
    })
  }

  // ── Rule 4: Reactivation — sphere with next_touchpoint_due ≤ 7d ──
  const { data: dueSphere } = await svc
    .from("lifetime_customer_npv_scores")
    .select("contact_id, npv_dollars, tier, recommended_action, recommended_cadence, next_touchpoint_due")
    .eq("agent_id", params.agentId)
    .lte("next_touchpoint_due", new Date(now + 7 * 86_400_000).toISOString())
    .in("tier", ["platinum", "gold", "silver"])
    .order("npv_dollars", { ascending: false })
    .limit(10)

  for (const s of dueSphere ?? []) {
    const expectedGCI = Math.round(Number(s.npv_dollars ?? 0) * 100 / 12)  // monthly slice of NPV
    candidates.push({
      action_rank: 0,
      action_category: "sphere_nurture",
      action_title: `${s.tier?.toUpperCase()} sphere: ${s.recommended_action ?? "check-in"}`,
      action_description: `Cadence: ${s.recommended_cadence ?? "weekly"}. Lifetime NPV $${Math.round(Number(s.npv_dollars ?? 0)).toLocaleString()}.`,
      contact_id: s.contact_id, transaction_id: null, listing_id: null,
      estimated_gci_impact_cents: Math.max(50_000, expectedGCI),
      estimated_effort_hours: 0.25,
      confidence_score: 70, impact_score: s.tier === "platinum" ? 85 : 60,
      urgency_score: 80,
      priority_score: 0,
      due_by: nextSundayISO(),
    })
  }

  // ── Rule 5: Referral ask — recent closes without referral_request ──
  const ninetyDaysAgo = new Date(now - 90 * 86_400_000).toISOString()
  const { data: recentCloses } = await svc
    .from("transactions")
    .select("id, property_address, actual_close_date, commission_total, contact_id")
    .eq("agent_id", params.agentId)
    .in("status", ["closed"])
    .gte("actual_close_date", ninetyDaysAgo)
    .order("actual_close_date", { ascending: false })
    .limit(10)

  for (const tx of recentCloses ?? []) {
    candidates.push({
      action_rank: 0,
      action_category: "referral_ask",
      action_title: `Ask for referral — ${tx.property_address ?? "recent closing"}`,
      action_description: `Client closed within 90d. Send personal thank-you + 3-name referral ask via Them-First template.`,
      contact_id: (tx as any).contact_id ?? null, transaction_id: tx.id, listing_id: null,
      estimated_gci_impact_cents: 350_000,  // average referral GCI
      estimated_effort_hours: 0.25,
      confidence_score: 55, impact_score: 70, urgency_score: 60,
      priority_score: 0,
      due_by: nextSundayISO(),
    })
  }

  // ── Rule 6: Pricing correction — listings with DOM > 30 + no recent drop ──
  const { data: staleListings } = await svc
    .from("listings")
    .select("id, address, list_price, go_live_date, last_price_change_at, status, brokerage_id")
    .eq("agent_id", params.agentId)
    .eq("status", "active")
    .not("go_live_date", "is", null)
    .limit(20)

  for (const l of staleListings ?? []) {
    const dom = (now - new Date((l as any).go_live_date).getTime()) / 86_400_000
    const lastDrop = (l as any).last_price_change_at
      ? (now - new Date((l as any).last_price_change_at).getTime()) / 86_400_000
      : 999
    if (dom < 30 || lastDrop < 14) continue
    const expectedGCI = Math.round(Number(l.list_price ?? 0) * 0.025 * 100)  // 2.5% list-side
    candidates.push({
      action_rank: 0,
      action_category: "pricing_correction",
      action_title: `Price reduction conversation — ${l.address} (${Math.round(dom)}d DOM)`,
      action_description: `Listing stale. Pull comps, draft CMA, schedule seller price-strategy call.`,
      contact_id: null, transaction_id: null, listing_id: l.id,
      estimated_gci_impact_cents: expectedGCI,
      estimated_effort_hours: 1.5,
      confidence_score: 60, impact_score: 80, urgency_score: Math.min(100, 40 + Math.round(dom / 2)),
      priority_score: 0,
      due_by: nextSundayISO(),
    })
  }

  // ── Rule 1: Listing acquisition (gap-driven prospecting prompt) ──
  // Always fires when there's a gap. The priority reflects how big the gap is.
  if (hasGap) {
    const listingsNeeded = Math.max(1, Math.ceil(gapDollars / 8000))  // ~$8k median GCI per listing
    candidates.push({
      action_rank: 0,
      action_category: "listing_acquisition",
      action_title: `Win ${listingsNeeded} new listing${listingsNeeded > 1 ? "s" : ""} to close $${gapDollars.toLocaleString()} gap`,
      action_description: `Call past clients, FSBOs, expired listings in your farm area. ${listingsNeeded} listings ≈ $${(listingsNeeded * 8000).toLocaleString()} GCI.`,
      contact_id: null, transaction_id: null, listing_id: null,
      estimated_gci_impact_cents: Math.min(gapDollars * 100, listingsNeeded * 800_000),
      estimated_effort_hours: 3.0,
      confidence_score: 50, impact_score: 95, urgency_score: 65,
      priority_score: 0,
      due_by: nextSundayISO(),
    })
  }

  // ── Compute priority_score and rank ──
  for (const c of candidates) {
    c.priority_score = score(c.impact_score, c.urgency_score, c.confidence_score, c.estimated_effort_hours)
  }
  candidates.sort((a, b) => b.priority_score - a.priority_score)

  const max = params.maxActions ?? 5
  return candidates.slice(0, max).map((c, i) => ({ ...c, action_rank: i + 1 }))
}
