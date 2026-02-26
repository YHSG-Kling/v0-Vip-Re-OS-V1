"use server"

import { createClient } from "@/lib/supabase/server"
import { generateText } from "ai"
import { incrementUsage } from "@/lib/usage"
import { revalidatePath } from "next/cache"
import { getDefaultCommissionStructure, getOfferExpirationHours } from "@/lib/brokerage"

// Submit offer
export async function submitOffer(offerData: {
  transaction_id: string
  listing_id: string
  buyer_id: string
  offer_amount: number
  earnest_money: number
  down_payment_percent: number
  financing_type: string
  contingencies: string[]
  close_date: string
  additional_terms?: any
}) {
  const supabase = await createClient()

  // Get user's brokerage ID for configuration
  const { data: userData } = await supabase.auth.getUser()
  const { data: profile } = await supabase
    .from("profiles")
    .select("brokerage_id")
    .eq("id", userData.user?.id)
    .single()
  
  const brokerageId = profile?.brokerage_id
  if (!brokerageId) {
    return { success: false, error: "User brokerage not found" }
  }

  // Get configuration-driven expiration hours
  const expirationHours = await getOfferExpirationHours(brokerageId)

  const { data: offer, error } = await supabase
    .from("offers")
    .insert({
      ...offerData,
      status: "pending",
      submitted_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + expirationHours * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single()

  if (error) return { success: false, error: error.message }

  // Notify seller's agent
  const { data: listing } = await supabase
    .from("listings")
    .select("agent_id, seller_id, address, price")
    .eq("id", offerData.listing_id)
    .single()

  if (listing) {
    await supabase.from("activities").insert({
      user_id: listing.agent_id,
      activity_type: "offer_received",
      entity_type: "offer",
      entity_id: offer.id,
      description: `New offer of $${offerData.offer_amount.toLocaleString()} received`,
      metadata: { priority: "high" },
    })
  }

  revalidatePath(`/listings/${offerData.listing_id}`)

  return { success: true, offer }
}

// AI analyze single offer
export async function analyzeOffer(offerId: string, userId: string) {
  const supabase = await createClient()

  const { data: offer } = await supabase
    .from("offers")
    .select(`
      *,
      listing:listings(*),
      buyer:contacts(*)
    `)
    .eq("id", offerId)
    .single()

  if (!offer) return { success: false, error: "Offer not found" }

  // Get brokerage commission structure
  const { data: profile } = await supabase
    .from("profiles")
    .select("brokerage_id")
    .eq("id", userId)
    .single()
  
  const brokerageId = profile?.brokerage_id
  if (!brokerageId) {
    return { success: false, error: "User brokerage not found" }
  }

  const commissionStructure = await getDefaultCommissionStructure(
    brokerageId,
    userId,
    offer?.commission_percentage ?? undefined
  )

  // Calculate net to seller
  const netToSeller = calculateNetSheet({
    purchase_price: offer.offer_amount,
    listing_price: offer.listing.price,
    earnest_money: offer.earnest_money,
    agent_commission: commissionStructure.totalBuyerSideRate + commissionStructure.totalListingSideRate,
    closing_costs: 0.02, // estimated 2%
  })

  // Track LLM usage
  await incrementUsage(userId, "llm_calls", 1)

  // AI analysis
  const { text: analysis } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `You are a real estate offer analysis expert. Analyze this offer and provide structured feedback.

Property: ${offer.listing.address}
List Price: $${offer.listing.price.toLocaleString()}
Offer Amount: $${offer.offer_amount.toLocaleString()}
Earnest Money: $${offer.earnest_money.toLocaleString()}
Down Payment: ${offer.down_payment_percent}%
Financing: ${offer.financing_type}
Contingencies: ${offer.contingencies.join(", ")}
Close Date: ${offer.close_date}
Net to Seller: $${netToSeller.net_to_seller.toLocaleString()}

Provide your analysis in the following format:

STRENGTH SCORE: [0-100]

KEY ADVANTAGES:
- [Advantage 1]
- [Advantage 2]
- [Advantage 3]

RISK FACTORS:
- [Risk 1 if any]
- [Risk 2 if any]

RECOMMENDATION: [Accept/Counter/Reject]

REASONING: [2-3 sentences explaining your recommendation]`,
  })

  // Save analysis
  const { data: savedAnalysis } = await supabase
    .from("offer_analysis")
    .insert({
      offer_id: offerId,
      analysis_type: "single",
      ai_recommendation: analysis,
      net_to_seller: netToSeller.net_to_seller,
      strength_score: extractScore(analysis),
      advantages: extractAdvantages(analysis),
      risk_factors: extractRisks(analysis),
    })
    .select()
    .single()

  return { success: true, analysis, net_sheet: netToSeller, saved: savedAnalysis }
}

// AI analyze multiple offers (comparison)
export async function analyzeMultipleOffers(listingId: string, userId: string) {
  const supabase = await createClient()

  const { data: offers } = await supabase
    .from("offers")
    .select("*, buyer:contacts(*)")
    .eq("listing_id", listingId)
    .in("status", ["pending", "countered"])

  if (!offers || offers.length === 0) {
    return { success: false, error: "No offers to compare" }
  }

  // Get brokerage commission structure
  const { data: userData } = await supabase.auth.getUser()
  const { data: profile } = await supabase
    .from("profiles")
    .select("brokerage_id")
    .eq("id", userId)
    .single()
  
  const brokerageId = profile?.brokerage_id
  if (!brokerageId) {
    return { success: false, error: "User brokerage not found" }
  }

  const commissionStructure = await getDefaultCommissionStructure(
    brokerageId,
    userId,
    offers[0]?.commission_percentage ?? undefined
  )
  const totalCommissionRate = commissionStructure.totalBuyerSideRate + commissionStructure.totalListingSideRate

  // Calculate net sheets for all
  const offerComparisons = offers.map((offer) => ({
    offer_id: offer.id,
    buyer_name: `${offer.buyer.first_name} ${offer.buyer.last_name}`,
    offer_amount: offer.offer_amount,
    net_to_seller: calculateNetSheet({
      purchase_price: offer.offer_amount,
      earnest_money: offer.earnest_money,
      agent_commission: totalCommissionRate,
      closing_costs: 0.02,
    }).net_to_seller,
    down_payment_percent: offer.down_payment_percent,
    financing_type: offer.financing_type,
    contingencies_count: offer.contingencies.length,
    close_date: offer.close_date,
    days_to_close: Math.floor((new Date(offer.close_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
  }))

  // Track LLM usage
  await incrementUsage(userId, "llm_calls", 1)

  // AI comparison
  const { text: comparison } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `You are a real estate offer comparison expert. Compare these ${offers.length} offers and rank them from best to worst.

${offerComparisons
  .map(
    (o, i) => `
Offer ${i + 1}:
- Buyer: ${o.buyer_name}
- Amount: $${o.offer_amount.toLocaleString()}
- Net to Seller: $${o.net_to_seller.toLocaleString()}
- Down Payment: ${o.down_payment_percent}%
- Financing: ${o.financing_type}
- Contingencies: ${o.contingencies_count}
- Days to Close: ${o.days_to_close}
`,
  )
  .join("\n")}

Provide:
1. RANKED LIST (best to worst) with reasoning for each ranking
2. COMPARISON MATRIX highlighting key differences
3. OVERALL RECOMMENDATION for which offer to accept
4. NEGOTIATION STRATEGY for the top offer`,
  })

  // Save comparison analysis for each offer
  for (const offer of offers) {
    await supabase.from("offer_analysis").insert({
      offer_id: offer.id,
      analysis_type: "multiple_comparison",
      ai_recommendation: comparison,
      net_to_seller: offerComparisons.find((o) => o.offer_id === offer.id)?.net_to_seller,
    })
  }

  return {
    success: true,
    comparison,
    offers: offerComparisons,
  }
}

// Calculate net sheet
export async function calculateNetSheet(params: {
  purchase_price: number
  listing_price?: number
  earnest_money: number
  agent_commission: number // decimal (0.06 = 6%)
  closing_costs: number // decimal (0.02 = 2%)
  seller_concessions?: number
  loan_payoff?: number
  property_taxes?: number
  hoa_dues?: number
}) {
  const {
    purchase_price,
    earnest_money,
    agent_commission,
    closing_costs,
    seller_concessions = 0,
    loan_payoff = 0,
    property_taxes = 0,
    hoa_dues = 0,
  } = params

  const commission_amount = purchase_price * agent_commission
  const closing_costs_amount = purchase_price * closing_costs

  const total_deductions =
    commission_amount + closing_costs_amount + seller_concessions + loan_payoff + property_taxes + hoa_dues

  const net_to_seller = purchase_price - total_deductions

  return {
    purchase_price,
    gross_amount: purchase_price,
    deductions: {
      agent_commission: commission_amount,
      closing_costs: closing_costs_amount,
      seller_concessions,
      loan_payoff,
      property_taxes,
      hoa_dues,
      total: total_deductions,
    },
    net_to_seller,
    earnest_money,
  }
}

// Counter offer
export async function counterOffer(
  offerId: string,
  counterData: {
    counter_amount?: number
    counter_terms?: any
    message?: string
  },
) {
  const supabase = await createClient()

  const { data: offer } = await supabase
    .from("offers")
    .select("*, buyer:contacts(*), listing:listings(*)")
    .eq("id", offerId)
    .single()

  if (!offer) return { success: false, error: "Offer not found" }

  // Get counter number
  const { data: existingCounters } = await supabase
    .from("offer_counters")
    .select("counter_number")
    .eq("offer_id", offerId)
    .order("counter_number", { ascending: false })
    .limit(1)

  const counterNumber = (existingCounters?.[0]?.counter_number || 0) + 1

  // Create counter
  const { data: counter } = await supabase
    .from("offer_counters")
    .insert({
      offer_id: offerId,
      counter_number: counterNumber,
      countered_by: "seller",
      counter_amount: counterData.counter_amount || offer.offer_amount,
      counter_terms: counterData.counter_terms,
      status: "pending",
      submitted_at: new Date().toISOString(),
    })
    .select()
    .single()

  // Update offer status
  await supabase.from("offers").update({ status: "countered" }).eq("id", offerId)

  // Notify buyer's agent
  if (offer.buyer.agent_id) {
    await supabase.from("activities").insert({
      user_id: offer.buyer.agent_id,
      activity_type: "offer_countered",
      entity_type: "offer",
      entity_id: offerId,
      description: counterData.message || `Counter offer: $${counterData.counter_amount?.toLocaleString()}`,
      metadata: { priority: "high" },
    })
  }

  revalidatePath(`/listings/${offer.listing_id}`)

  return { success: true, counter }
}

// Accept offer
export async function acceptOffer(offerId: string, agentId: string) {
  const supabase = await createClient()

  const { data: offer } = await supabase
    .from("offers")
    .select("*, listing:listings(*), buyer:contacts(*)")
    .eq("id", offerId)
    .single()

  if (!offer) return { success: false, error: "Offer not found" }

  // Update offer status
  await supabase
    .from("offers")
    .update({
      status: "accepted",
      accepted_at: new Date().toISOString(),
    })
    .eq("id", offerId)

  // Update transaction
  if (offer.transaction_id) {
    await supabase
      .from("transactions")
      .update({
        status: "under_contract",
        purchase_price: offer.offer_amount,
        contract_date: new Date().toISOString(),
        estimated_close_date: offer.close_date,
      })
      .eq("id", offer.transaction_id)

    // Trigger listing lifecycle stage change
    const { advanceListingStage } = await import("./listing-lifecycle")
    await advanceListingStage(offer.listing_id, "under_contract", agentId)
  }

  // Reject all other offers
  await supabase.from("offers").update({ status: "rejected" }).eq("listing_id", offer.listing_id).neq("id", offerId)

  // Notify buyer
  if (offer.buyer.agent_id) {
    await supabase.from("activities").insert({
      user_id: offer.buyer.agent_id,
      activity_type: "offer_accepted",
      entity_type: "offer",
      entity_id: offerId,
      description: `🎉 Offer accepted on ${offer.listing.address}!`,
      metadata: { priority: "high" },
    })
  }

  revalidatePath(`/listings/${offer.listing_id}`)

  return { success: true }
}

// Reject offer
export async function rejectOffer(offerId: string, reason?: string) {
  const supabase = await createClient()

  const { data: offer } = await supabase
    .from("offers")
    .select("buyer_id, listing:listings(address, id)")
    .eq("id", offerId)
    .single()

  await supabase
    .from("offers")
    .update({
      status: "rejected",
      rejection_reason: reason,
    })
    .eq("id", offerId)

  // Notify buyer
  if (offer?.buyer_id) {
    await supabase.from("activities").insert({
      user_id: offer.buyer_id,
      activity_type: "offer_rejected",
      entity_type: "offer",
      entity_id: offerId,
      description: reason || `Offer on ${offer.listing.address} was not accepted`,
    })
  }

  if (offer?.listing) {
    revalidatePath(`/listings/${offer.listing.id}`)
  }

  return { success: true }
}

// Helper functions
function extractScore(aiResponse: string): number {
  const match = aiResponse.match(/strength score:?\s*(\d+)/i)
  return match ? Number.parseInt(match[1]) : 75
}

function extractAdvantages(aiResponse: string): string[] {
  const advantages: string[] = []
  const lines = aiResponse.split("\n")
  let inAdvantages = false

  for (const line of lines) {
    if (line.toLowerCase().includes("advantage")) {
      inAdvantages = true
      continue
    }
    if (inAdvantages && line.trim().startsWith("-")) {
      advantages.push(line.trim().substring(1).trim())
    }
    if (advantages.length >= 3) break
  }

  return advantages
}

function extractRisks(aiResponse: string): string[] {
  const risks: string[] = []
  const lines = aiResponse.split("\n")
  let inRisks = false

  for (const line of lines) {
    if (line.toLowerCase().includes("risk")) {
      inRisks = true
      continue
    }
    if (inRisks && line.trim().startsWith("-")) {
      risks.push(line.trim().substring(1).trim())
    }
  }

  return risks
}
