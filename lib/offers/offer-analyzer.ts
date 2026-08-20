import { generateAIResponse } from "@/lib/ai"
import { createClient } from "@/lib/supabase/server"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
// Net-to-seller commission math lives in the PURE, dependency-light single source of
// truth (lib/offers/offer-math) so the non-server-only kernel net-sheet + client net
// sheet can share the EXACT same formula without pulling this file's server-only deps.
import { calcNetToSeller } from "@/lib/offers/offer-math"

// Re-exported so existing importers of "@/lib/offers/offer-analyzer" are unaffected.
export { calcNetToSeller }

export interface OfferForAnalysis {
  id: string
  offer_number: string | null
  offer_price: number
  earnest_money: number | null
  closing_date: string | null
  financing_type: string | null
  down_payment_percent: number | null
  appraisal_contingency_days: number | null
  financing_contingency_days: number | null
  inspection_period_days: number | null
  escalation_clause: boolean | null
  escalation_cap: number | null
  appraisal_gap: number | null
  closing_cost_contribution: number | null
  possession_terms: string | null
  contingencies: string[] | null
  seller_net_estimate: number | null
}

export interface OfferAnalysisResult {
  recommendation: string               // "Offer [X] is recommended because..."
  ranked_offer_ids: string[]           // best → worst
  per_offer_notes: Record<string, string>
  comparison_summary: string
}

// ── Net-to-seller calculation ─────────────────────────────────────────────────
// calcNetToSeller is imported + re-exported from lib/offers/offer-math (the pure
// single source of truth). See the import at the top of this file.

// ── AI comparison — only called when 2+ offers ────────────────────────────────
export async function analyzeAndCompareOffers(params: {
  listingId: string
  brokerageId: string
  agentUserId: string
  listPrice: number
  offers: OfferForAnalysis[]
  commissionRate: number
}): Promise<{ success: boolean; error?: string; result?: OfferAnalysisResult }> {
  const { listingId, brokerageId, agentUserId, listPrice, offers, commissionRate } = params

  if (offers.length < 2) {
    return { success: false, error: "AI comparison requires at least 2 offers" }
  }

  const supabase = await createClient()

  // Build net estimates for each offer
  const enriched = offers.map((o, idx) => ({
    ...o,
    label: o.offer_number ?? `Offer ${idx + 1}`,
    net_to_seller: calcNetToSeller({
      offer_price: o.offer_price,
      closing_cost_contribution: o.closing_cost_contribution,
      commission_rate: commissionRate,
    }),
  }))

  const offerBlocks = enriched
    .map(
      (o) =>
        `${o.label} (id: ${o.id}):
  Price: $${o.offer_price.toLocaleString()}
  Net to Seller: $${o.net_to_seller.toLocaleString()}
  Financing: ${o.financing_type ?? "unknown"}
  Down Payment: ${o.down_payment_percent != null ? o.down_payment_percent + "%" : "unknown"}
  Closing Date: ${o.closing_date ?? "unspecified"}
  Inspection Period: ${o.inspection_period_days ?? "unspecified"} days
  Financing Contingency: ${o.financing_contingency_days ?? "none"} days
  Appraisal Contingency: ${o.appraisal_contingency_days ?? "none"} days
  Escalation Clause: ${o.escalation_clause ? "Yes (cap $" + (o.escalation_cap?.toLocaleString() ?? "unknown") + ")" : "No"}
  Appraisal Gap: ${o.appraisal_gap != null ? "$" + o.appraisal_gap.toLocaleString() : "none"}
  Possession: ${o.possession_terms ?? "standard"}
  Contingencies: ${(o.contingencies ?? []).join(", ") || "none"}`
    )
    .join("\n\n")

  const response = await generateAIResponse({
    prompt: `You are an expert real estate advisor helping a listing agent evaluate offers on a property listed at $${listPrice.toLocaleString()}.

Here are the offers:

${offerBlocks}

Return ONLY a valid JSON object with this exact schema (no markdown, no commentary):
{
  "recommendation": "Based on net proceeds and risk profile, [label] is recommended because [2-3 sentence reason]",
  "ranked_offer_ids": ["<uuid best>", "<uuid second>", ...],
  "per_offer_notes": {
    "<offer_uuid>": "1-2 sentence note for agent",
    ...
  },
  "comparison_summary": "3-4 sentence high-level summary of the competitive landscape"
}`,
    metadata: {
      userId: agentUserId,
      brokerageId: brokerageId,
      feature: "offer_analysis",
    },
  })

  const cleaned = response.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
  let result: OfferAnalysisResult

  try {
    result = JSON.parse(cleaned)
  } catch {
    return { success: false, error: "AI response parse failed" }
  }

  // Update seller_net_estimate on each offer row
  for (const o of enriched) {
    await supabase
      .from("offers")
      .update({
        seller_net_estimate: o.net_to_seller,
        ai_recommendation: result.per_offer_notes[o.id] ?? null,
        ai_analysis: result as unknown as Record<string, unknown>,
        updated_at: new Date().toISOString(),
      })
      .eq("id", o.id)
  }

  // ── PERSIST THE COMPARISON ───────────────────────────────────────────────
  // THE AI VERDICT HAD NOWHERE TO LAND. `offer_comparison.ai_recommendation`
  // and `.ai_analysis_notes` are read by BOTH doors onto this comparison —
  // app/actions/seller-offers.ts:620 (loadLatestOfferComparison, which the agent's
  // offers manager hydrates from on every page load) and
  // app/actions/portal-seller.ts:663 (getSellerOfferComparison, the seller's own
  // view) — and NOTHING in the tree wrote either column. Both surfaces rendered
  // a permanent null: the agent clicked "compare", read the recommendation once
  // in memory, and it was gone on refresh; the seller's portal showed a matrix
  // with no recommendation at all, forever.
  //
  // The row is written HERE, in the ONE analyzer both comparison paths already
  // delegate to, rather than in either caller — a second persister in the action
  // would be the third copy of a shape this file's own history records being
  // deduplicated once already (seller-offers.ts:842).
  //
  // IDENTITY: agent_id FKs agents(id) and created_by FKs users(id). Those spaces
  // are disjoint, so the users id in hand is RESOLVED to an agents id rather than
  // substituted; an unresolved agent leaves the nullable column NULL instead of
  // planting a dangling reference.
  const { resolveAgentIdInBrokerage } = await import("@/lib/kernel/agent-identity")
  const comparisonAgentId = await resolveAgentIdInBrokerage(supabase, agentUserId, brokerageId)

  const netByOffer: Record<string, number> = {}
  for (const o of enriched) netByOffer[o.id] = o.net_to_seller
  const comparisonMatrix = enriched.map((o) => ({
    offer_id: o.id,
    offer_price: o.offer_price,
    net_to_seller: o.net_to_seller,
    financing_type: o.financing_type ?? null,
    down_payment_percent: o.down_payment_percent ?? null,
    closing_date: o.closing_date ?? null,
    contingencies_count: (o.contingencies ?? []).length,
  }))
  // The ranking the model returned decides the recommended offer, and it is
  // VALIDATED against the offers actually compared — a hallucinated id would
  // otherwise be written into a column that FKs offers(id) and refuse the whole
  // row (PGRST/23503), taking the recommendation text down with it.
  const comparedIds = new Set(enriched.map((o) => o.id))
  const recommendedOfferId = (result.ranked_offer_ids ?? []).find((id) => comparedIds.has(id))
    ?? [...enriched].sort((a, b) => b.net_to_seller - a.net_to_seller)[0]?.id
    ?? null
  // The per-offer notes are kept as the analysis NOTES, labelled by the same
  // offer label the model was shown, so the text a reader sees names the offer
  // it is about rather than a bare uuid.
  const perOfferNotes = enriched
    .map((o) => {
      const note = result.per_offer_notes?.[o.id]
      return note ? `${o.label}: ${note}` : null
    })
    .filter(Boolean)
    .join("\n")
  const analysisNotes = [result.comparison_summary, perOfferNotes].filter(Boolean).join("\n\n") || null

  const { error: comparisonError } = await supabase.from("offer_comparison").insert({
    listing_id: listingId,
    brokerage_id: brokerageId,
    agent_id: comparisonAgentId,
    created_by: agentUserId,
    offer_ids: enriched.map((o) => o.id),
    net_to_seller_by_offer: netByOffer,
    comparison_matrix: comparisonMatrix,
    ai_recommendation: result.recommendation ?? null,
    ai_analysis_notes: analysisNotes,
    recommended_offer_id: recommendedOfferId,
  })
  // Reported, not thrown: the analysis itself succeeded and the caller's own
  // return still carries it. A silent failure here is what produced the
  // permanently-null columns in the first place, so it is never swallowed.
  if (comparisonError) {
    console.error("[offer-analyzer] offer_comparison insert refused — this comparison will not survive a refresh:", comparisonError.message)
  }

  // lifecycle_events + kernel event
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type: "listing_stage_machine",
    entity_id: listingId,
    event_type: KernelEvent.OFFER_COMPARISON_GENERATED,
    actor_user_id: agentUserId,
    metadata: {
      offer_count: offers.length,
      ranked_offer_ids: result.ranked_offer_ids,
    },
  })

  await processKernelEvent({
    event: KernelEvent.OFFER_COMPARISON_GENERATED,
    brokerageId,
    entityType: "listing_stage_machine",
    entityId: listingId,
  }).catch(() => {})

  return { success: true, result }
}
