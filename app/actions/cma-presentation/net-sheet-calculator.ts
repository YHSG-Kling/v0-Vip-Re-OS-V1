"use server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { resolveAgreedCommission, resolveClosingCosts } from "@/lib/offers/net-sheet-calc"
import { deriveNetSheetClosingCostSection } from "@/lib/offers/seller-closing-costs"

/**
 * System 5.3: CMA & Listing Presentation Engine
 * Net Sheet Calculator
 * 
 * Calculates seller proceeds for multiple scenarios.
 * DOES NOT advance journey - only emits completion signals.
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { getFinancialDefaults } from "@/lib/brokerage/get-brokerage-settings"
import { computeNetSheetScenario } from "@/lib/cma/net-sheet-math"

export interface NetSheetInput {
  listingId: string
  contactId: string
  agentId: string
  
  // Sale scenarios
  salePrice: number
  alternatePrice?: number // For "what if" scenarios
  
  // Costs
  listingCommissionRate?: number // Default 3%
  buyerCommissionRate?: number // Default 3%
  closingCosts?: number // Default 2% of sale price
  
  // Existing mortgage
  mortgageBalance?: number
  mortgagePayoffAmount?: number
  
  // Other costs
  propertyTaxes?: number
  hoaFees?: number
  repairCredits?: number
  sellerConcessions?: number
}

export interface NetSheetResult {
  success: boolean
  netSheetId?: string
  scenarios?: NetSheetScenario[]
  expiresAt?: string
  error?: string
}

export interface NetSheetScenario {
  scenarioName: string
  salePrice: number
  grossProceeds: number
  totalCosts: number
  netProceeds: number
  breakdown: {
    salePrice: number
    listingCommission: number
    buyerCommission: number
    closingCosts: number
    mortgagePayoff: number
    propertyTaxes: number
    hoaFees: number
    repairCredits: number
    sellerConcessions: number
    otherCosts: number
  }
}

/**
 * NET SHEET VALIDITY: 90 days from generation
 */
const NET_SHEET_VALIDITY_DAYS = 90

/**
 * Generate net sheet with multiple scenarios
 */
export async function generateNetSheet(input: NetSheetInput): Promise<NetSheetResult> {
  try {
    // Validation
    if (!isValidUUID(input.listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    if (!isValidUUID(input.contactId)) {
      return { success: false, error: "Invalid contact ID" }
    }
    if (!isValidUUID(input.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }
    if (!input.salePrice || input.salePrice <= 0) {
      return { success: false, error: "Invalid sale price" }
    }

    const supabase = await createClient()

    // pass 13: callers pass MIXED id classes (the presentation tab sends
    // listing.agent_id = agents.id; direct actions send users.id). Resolve both
    // once — the users lookup below and the activities.agent_user_id stamps
    // (users FK) need the auth users.id or they fail outright.
    const { data: nsIdRow } = await supabase
      .from("agents").select("user_id, brokerage_id")
      .or(`id.eq.${input.agentId},user_id.eq.${input.agentId}`)
      .maybeSingle()
    const nsAgentUserId = nsIdRow?.user_id ?? input.agentId

    // Get agent's brokerage for commission structure
    const { data: profile } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", nsAgentUserId)
      .maybeSingle()

    const brokerageId = profile?.brokerage_id ?? nsIdRow?.brokerage_id
    if (!brokerageId) {
      return { success: false, error: "Agent brokerage not found" }
    }

    // Fetch brokerage commission structure and financial defaults in parallel
    const [commissionStructure, financialDefaults] = await Promise.all([
      getDefaultCommissionStructure(brokerageId),
      getFinancialDefaults(brokerageId),
    ])

    const closingCostPercent = financialDefaults.closing_cost_percent

    // ── Money correctness: this sheet used to price NOTHING the seller agreed to.
    // It charged the brokerage's DEFAULT commission rates, defaulted closing costs
    // to a flat brokerage percent, and had no transaction-fee line at all — so a
    // flat-fee listing or a $395 brokerage fee simply did not appear. The three
    // other net sheets already resolve these; this one now shares their resolvers.
    const [{ data: nsListing }, { data: nsAgreement }] = await Promise.all([
      supabase.from("listings").select("state, commission_rate").eq("id", input.listingId).maybeSingle(),
      supabase
        .from("listing_agreements")
        .select("listing_commission_rate, buyer_commission_rate, total_commission_rate, commission_is_flat_fee, commission_flat_amount, seller_transaction_fee")
        .eq("listing_id", input.listingId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    const nsAgreed = resolveAgreedCommission({
      agreement: nsAgreement ?? null,
      listingCommissionRatePercent: (nsListing?.commission_rate as number | null) ?? null,
      referencePrice: input.salePrice,
    })
    // The AGREED seller transaction fee — a flat dollar charge that does not scale.
    const nsTransactionFee = Number(nsAgreement?.seller_transaction_fee ?? 0) || 0
    const nsListingState = (nsListing?.state as string | null) ?? null

    // Emit start event
    await supabase.from("activities").insert({
      activity_type: "seller.net_sheet.started",
      listing_id: input.listingId,
      contact_id: input.contactId,
      agent_user_id: nsAgentUserId,
      metadata: {
        sale_price: input.salePrice,
        alternate_price: input.alternatePrice
      }
    })

    // Calculate scenarios
    const scenarios: NetSheetScenario[] = []
    
    // Primary scenario
    const nsCtx = { agreed: nsAgreed, transactionFee: nsTransactionFee, state: nsListingState, brokeragePercent: closingCostPercent }
    scenarios.push(calculateScenario("Primary Scenario", input.salePrice, input, commissionStructure, closingCostPercent, nsCtx))
    
    // Alternate scenario if provided
    if (input.alternatePrice && input.alternatePrice > 0) {
      scenarios.push(calculateScenario("Alternate Scenario", input.alternatePrice, input, commissionStructure, closingCostPercent, nsCtx))
    }
    
    // Conservative scenario (-5%)
    scenarios.push(calculateScenario("Conservative (-5%)", input.salePrice * 0.95, input, commissionStructure, closingCostPercent, nsCtx))
    
    // Optimistic scenario (+5%)
    scenarios.push(calculateScenario("Optimistic (+5%)", input.salePrice * 1.05, input, commissionStructure, closingCostPercent, nsCtx))

    // Calculate expiration (90 days)
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + NET_SHEET_VALIDITY_DAYS)

    const netSheetId = crypto.randomUUID()

    // Emit completion event
    await supabase.from("activities").insert({
      activity_type: "seller.net_sheet.completed",
      listing_id: input.listingId,
      contact_id: input.contactId,
      agent_user_id: nsAgentUserId,
      metadata: {
        net_sheet_id: netSheetId,
        scenario_count: scenarios.length,
        primary_net_proceeds: scenarios[0].netProceeds,
        expires_at: expiresAt.toISOString(),
        validity_days: NET_SHEET_VALIDITY_DAYS
      }
    })

    return {
      success: true,
      netSheetId,
      scenarios,
      expiresAt: expiresAt.toISOString()
    }
  } catch (error: any) {
    console.error("[System 5.3] Net sheet generation error:", error)
    return {
      success: false,
      error: error.message || "Failed to generate net sheet"
    }
  }
}

/**
 * Calculate a single net sheet scenario.
 * Pure synchronous function — all async brokerage data is resolved upstream in generateNetSheet.
 */
function calculateScenario(
  scenarioName: string,
  salePrice: number,
  input: NetSheetInput,
  commissionStructure: Awaited<ReturnType<typeof getDefaultCommissionStructure>>,
  closingCostPercent: number,
  ctx?: {
    agreed: ReturnType<typeof resolveAgreedCommission>
    transactionFee: number
    state: string | null
    brokeragePercent: number
  },
): NetSheetScenario {
  // Commission Engine 8.0 will compute final values.
  // Pure arithmetic lives in @/lib/cma/net-sheet-math (computeNetSheetScenario).
  //
  // Closing costs are tiered by the canonical resolver, recomputed PER SCENARIO so
  // the regional band tracks the scenario price instead of being scaled after the
  // fact: entered figure → brokerage percent (only when actually configured) →
  // county-customary band → 2% house default.
  const resolvedClosing = ctx
    ? resolveClosingCosts({
        explicitAmount: input.closingCosts,
        brokerageClosingCostPercent: ctx.brokeragePercent,
        regionalMidpoint: deriveNetSheetClosingCostSection(salePrice, ctx.state)?.midpoint ?? null,
        salePrice,
      })
    : null

  return computeNetSheetScenario(
    scenarioName,
    salePrice,
    {
      closingCosts: resolvedClosing ? resolvedClosing.amount : input.closingCosts,
      transactionFee: ctx?.transactionFee ?? 0,
      mortgagePayoffAmount: input.mortgagePayoffAmount,
      mortgageBalance: input.mortgageBalance,
      propertyTaxes: input.propertyTaxes,
      hoaFees: input.hoaFees,
      repairCredits: input.repairCredits,
      sellerConcessions: input.sellerConcessions,
    },
    // An executed agreement outranks the brokerage's default rates.
    ctx && !ctx.agreed.isEstimate && !ctx.agreed.isFlatFee
      ? ctx.agreed.rate
      : commissionStructure?.agentListingSideRate ?? 0,
    ctx && !ctx.agreed.isEstimate && !ctx.agreed.isFlatFee
      ? 0
      : commissionStructure?.agentBuyerSideRate ?? 0,
    closingCostPercent,
    ctx?.agreed.isFlatFee ? ctx.agreed.flatAmount : null,
  )
}

/**
 * Check if net sheet is still valid (within 90 days)
 */
export async function isNetSheetValid(listingId: string): Promise<boolean> {
  try {
    if (!isValidUUID(listingId)) {
      return false
    }

    const supabase = await createClient()

    // Find most recent net sheet completion
    const { data: events } = await supabase
      .from("activities")
      .select("created_at, metadata")
      .eq("listing_id", listingId)
      .eq("activity_type", "seller.net_sheet.completed")
      .order("created_at", { ascending: false })
      .limit(1)

    if (!events || events.length === 0) {
      return false
    }

    const latestEvent = events[0]
    const createdAt = new Date(latestEvent.created_at)
    const now = new Date()
    const daysSinceCreation = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24))

    return daysSinceCreation <= NET_SHEET_VALIDITY_DAYS
  } catch (error) {
    console.error("[System 5.3] Net sheet validation error:", error)
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Seller Portal: Share net sheet as a transparency update
// ─────────────────────────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
}

export interface NetSheetPortalData {
  estimatedSalePrice: number
  mortgagePayoff: number
  agentCommission: number
  closingCosts: number
  estimatedNet: number
  notes?: string
}

export async function shareNetSheetToPortal(params: {
  listingId: string
  contactId: string
  netSheetData: NetSheetPortalData
}): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(params.listingId)) return { success: false, error: "Invalid listing ID" }
    if (!isValidUUID(params.contactId)) return { success: false, error: "Invalid contact ID" }

    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Not authenticated" }

    const { data: agent } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .maybeSingle()

    const message =
      `Based on a sale price of ${formatCurrency(params.netSheetData.estimatedSalePrice)}, ` +
      `your estimated net proceeds are ${formatCurrency(params.netSheetData.estimatedNet)}. ` +
      `This includes ${formatCurrency(params.netSheetData.agentCommission)} in commission, ` +
      `${formatCurrency(params.netSheetData.closingCosts)} in closing costs, and a ` +
      `${formatCurrency(params.netSheetData.mortgagePayoff)} mortgage payoff. ` +
      `Review the full breakdown in your portal.`

    const { error } = await supabase.from("transparency_updates").insert({
      listing_id: params.listingId,
      contact_id: params.contactId,
      // transparency_updates.agent_id FKs USERS(id) — NOT agents(id), despite the
      // name. A resolved agents.id is FK-rejected here. Verified against pg_constraint.
      agent_id: user.id,
      update_type: "net_sheet",
      title: "Your Estimated Net Proceeds",
      message,
      is_visible_to_client: true,
      metadata: {
        net_sheet: params.netSheetData,
        generated_at: new Date().toISOString(),
      },
    })

    if (error) return { success: false, error: error.message }

    // Log an activity so the timeline reflects this action
    await supabase.from("activities").insert({
      activity_type: "net_sheet_shared_to_portal",
      contact_id: params.contactId,
      // FKs agents(id), not users(id) — a raw user id is FK-rejected (agent-identity rule).
      agent_id: await resolveAgentId(supabase, user.id),
      brokerage_id: agent?.brokerage_id ?? null,
      title: "Net sheet shared to seller portal",
      description: `Estimated net: ${formatCurrency(params.netSheetData.estimatedNet)}`,
    })

    return { success: true }
  } catch (err: any) {
    console.error("[System 5.3] shareNetSheetToPortal error:", err)
    return { success: false, error: err.message || "Failed to share net sheet" }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI: Generate plain-language net sheet explanation for the seller
// Uses Vercel AI Gateway (no provider package needed)
// ─────────────────────────────────────────────────────────────────────────────

export async function generateNetSheetExplanation(params: {
  netSheetData: NetSheetPortalData
  agentName: string
}): Promise<string> {
  const { generateText } = await import("ai")

  const { text } = await generateText({
    model: "anthropic/claude-opus-4-6" as any,
    prompt: `Write a warm, plain-language explanation of a seller net sheet for a real estate client.
Keep it conversational, reassuring, and under 150 words.

Net sheet details:
- Sale price: ${formatCurrency(params.netSheetData.estimatedSalePrice)}
- Mortgage payoff: ${formatCurrency(params.netSheetData.mortgagePayoff)}
- Commission: ${formatCurrency(params.netSheetData.agentCommission)}
- Closing costs: ${formatCurrency(params.netSheetData.closingCosts)}
- Estimated net: ${formatCurrency(params.netSheetData.estimatedNet)}

Agent's name: ${params.agentName}

Write as if ${params.agentName} is explaining this to their seller client.
No jargon. No fine print. Just clarity and confidence.`,
  })

  return text
}

// ─────────────────────────────────────────────────────────────────────────────
// Save draft explanation to ai_message_drafts for email follow-up
// ─────────────────────────────────────────────────────────────────────────────

export async function saveNetSheetEmailDraft(params: {
  contactId: string
  listingId: string
  draftBody: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Not authenticated" }

    const { data: agent } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .maybeSingle()

    const { error } = await supabase.from("ai_message_drafts").insert({
      agent_user_id: user.id,
      contact_id: params.contactId,
      listing_id: params.listingId,
      brokerage_id: agent?.brokerage_id ?? null,
      channel: "email",
      draft_subject: "Your Estimated Net Proceeds",
      draft_body: params.draftBody,
      trigger_event: "net_sheet_generated",
      status: "pending",
      context_summary: "AI-generated plain-language explanation of seller net sheet",
    })

    if (error) return { success: false, error: error.message }
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to save draft" }
  }
}

/**
 * Get net sheet expiration status
 */
export async function getNetSheetExpiration(listingId: string): Promise<{
  isValid: boolean
  daysRemaining?: number
  expiresAt?: string
  needsRenewal?: boolean
}> {
  try {
    if (!isValidUUID(listingId)) {
      return { isValid: false }
    }

    const supabase = await createClient()

    const { data: events } = await supabase
      .from("activities")
      .select("created_at, metadata")
      .eq("listing_id", listingId)
      .eq("activity_type", "seller.net_sheet.completed")
      .order("created_at", { ascending: false })
      .limit(1)

    if (!events || events.length === 0) {
      return { isValid: false, needsRenewal: true }
    }

    const latestEvent = events[0]
    const createdAt = new Date(latestEvent.created_at)
    const expiresAt = new Date(createdAt)
    expiresAt.setDate(expiresAt.getDate() + NET_SHEET_VALIDITY_DAYS)
    
    const now = new Date()
    const daysRemaining = Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    
    const isValid = daysRemaining > 0
    const needsRenewal = daysRemaining <= 7 // Warn when < 7 days remaining

    return {
      isValid,
      daysRemaining: Math.max(0, daysRemaining),
      expiresAt: expiresAt.toISOString(),
      needsRenewal
    }
  } catch (error) {
    console.error("[System 5.3] Net sheet expiration check error:", error)
    return { isValid: false, needsRenewal: true }
  }
}
