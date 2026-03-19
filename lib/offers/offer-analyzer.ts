import { generateAIResponse } from "@/lib/ai"
import { createClient } from "@/lib/supabase/server"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"

export interface OfferForAnalysis {
  id: string
  offer_number: string | null
  offer_price: number
  earnest_money: number | null
  earnest_money_amount: number | null
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

// ── Net-to-seller calculation (uses only live schema columns) ──────────────────
export function calcNetToSeller(params: {
  offer_price: number
  closing_cost_contribution: number | null
  commission_rate: number               // decimal e.g. 0.06
}): number {
  const { offer_price, closing_cost_contribution, commission_rate } = params
  const commission = offer_price * commission_rate
  const sellerConc = closing_cost_contribution ?? 0
  return offer_price - commission - sellerConc
}

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
