/**
 * lib/workflow/intelligence/listing-presentation-builder.ts
 *
 * Builds a complete listing presentation in the background — typically 24h
 * before the agent's listing appointment — so they walk in with everything
 * ready instead of saying "let me get back to you with the numbers."
 *
 * Composes EXISTING infrastructure (no new providers):
 *   - lib/cma/ai-cma-orchestrator.runAiCma()                 → CMA narrative + value range
 *   - lib/state-forms/registry.getStateForms()                → state-specific forms
 *   - lib/ai/models.generateTextRouted()                     → marketing plan + slide copy
 *
 * Output: a listing_presentations row populated with cma snapshot, 3-price
 * net sheet, marketing plan, slide deck JSON, and a linked listing-agreement
 * packet document. Agent gets a high-priority notification when it's ready.
 *
 * Reusable from:
 *   - daily cron sweep (build for every appointment 24h out)
 *   - on-demand action (agent presses "Prepare for appointment now")
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import { runAiCma } from "@/lib/cma/ai-cma-orchestrator"
import { getStateForms } from "@/lib/state-forms/registry"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NetSheetRow {
  pricePoint:        "conservative" | "target" | "aspirational"
  listPrice:         number
  estimatedCommission: number
  estimatedClosingCosts: number
  estimatedSellerProceeds: number
  breakdown: {
    transferTax?:    number
    titleFees?:      number
    escrowFees?:     number
    miscFees?:       number
  }
}

export interface MarketingPlan {
  comingSoonStrategy: string
  photographyPlan:    string
  openHousePlan:      string
  digitalChannels:    string[]
  printChannels:      string[]
  mlsHighlights:      string[]
  predictedDom:       number | null
  recommendedTier:    "essential" | "premium" | "luxury"
}

export interface SlideDeckSlide {
  title:    string
  layout:   "title" | "value-range" | "comps" | "marketing" | "net-sheet" | "timeline" | "next-steps"
  content:  unknown                       // shape varies per layout — viewer narrows
}

export interface ListingPresentationInput {
  brokerageId:     string
  agentUserId:     string | null
  contactId:       string | null
  appointmentId?:  string | null
  appointmentAt?:  string | null
  propertyAddress: string
  state:           string                                    // 2-letter
  city?:           string | null
  zip?:            string | null
  // Optional pre-known property fields — passed through to CMA
  bedrooms?:       number | null
  bathrooms?:      number | null
  sqft?:           number | null
  yearBuilt?:      number | null
}

export interface ListingPresentationResult {
  presentationId: string
  cmaSnapshot:    {
    low: number
    mid: number
    high: number
    confidence: number
    narrative: string
  }
  netSheet:       NetSheetRow[]
  marketingPlan:  MarketingPlan
  slideDeck:      SlideDeckSlide[]
  packetDocumentId: string | null
}

// ─── Net sheet calculator ──────────────────────────────────────────────────

const STATE_TRANSFER_TAX_RATE: Record<string, number> = {
  CA: 0.0011, FL: 0.007, NY: 0.004, TX: 0,
  // Most states fall in 0-0.5%; default 0.0025
}

function computeNetSheet(midValue: number, state: string): NetSheetRow[] {
  const transferRate = STATE_TRANSFER_TAX_RATE[state] ?? 0.0025
  const commission = 0.06          // 6% total — broker can override per agent
  const titleFees = 1500
  const escrowFees = 800
  const miscFees = 500

  const points: Array<{ pp: NetSheetRow["pricePoint"]; multiplier: number }> = [
    { pp: "conservative", multiplier: 0.92 },
    { pp: "target",       multiplier: 1.0  },
    { pp: "aspirational", multiplier: 1.08 },
  ]

  return points.map(({ pp, multiplier }) => {
    const listPrice = Math.round(midValue * multiplier)
    const estimatedCommission = Math.round(listPrice * commission)
    const transferTax = Math.round(listPrice * transferRate)
    const estimatedClosingCosts = transferTax + titleFees + escrowFees + miscFees
    const estimatedSellerProceeds = listPrice - estimatedCommission - estimatedClosingCosts
    return {
      pricePoint: pp,
      listPrice,
      estimatedCommission,
      estimatedClosingCosts,
      estimatedSellerProceeds,
      breakdown: { transferTax, titleFees, escrowFees, miscFees },
    }
  })
}

// ─── Marketing plan AI generation ──────────────────────────────────────────

async function buildMarketingPlan(input: {
  propertyAddress: string
  state:           string
  midValue:        number
  bedrooms?:       number | null
  bathrooms?:      number | null
  sqft?:           number | null
}): Promise<MarketingPlan> {
  // Recommend tier from value
  const tier: MarketingPlan["recommendedTier"] =
    input.midValue >= 2_000_000 ? "luxury"
    : input.midValue >= 750_000 ? "premium"
    : "essential"

  const prompt = `You are a listing marketing expert. Build a marketing plan for ${input.propertyAddress}, ${input.state} listed around $${input.midValue.toLocaleString()}.
Beds: ${input.bedrooms ?? "n/a"}, baths: ${input.bathrooms ?? "n/a"}, sqft: ${input.sqft ?? "n/a"}.
Tier: ${tier}.

Return ONLY JSON matching this shape (no prose, no markdown):
{
  "comingSoonStrategy": "string (2 sentences)",
  "photographyPlan": "string (1 sentence)",
  "openHousePlan": "string (1 sentence)",
  "digitalChannels": ["3-5 channel names"],
  "printChannels": ["1-3 print pieces"],
  "mlsHighlights": ["3-5 brief feature highlights"],
  "predictedDom": <number or null>
}`

  let parsed: Partial<Omit<MarketingPlan, "recommendedTier">> = {}
  try {
    const { text } = await generateTextRouted({
      feature: "listing_marketing_plan",
      messages: [{ role: "user", content: prompt }],
    })
    parsed = JSON.parse(text.replace(/```json|```/g, "").trim())
  } catch { /* defaults below */ }

  return {
    comingSoonStrategy: parsed.comingSoonStrategy ?? "Launch as Coming Soon for 7 days, capturing buyer interest before MLS active.",
    photographyPlan:    parsed.photographyPlan    ?? "Professional photography + drone aerials + twilight shots.",
    openHousePlan:      parsed.openHousePlan      ?? "First open house weekend after MLS active; broker preview the prior weekday.",
    digitalChannels:    parsed.digitalChannels    ?? ["MLS", "Zillow", "Realtor.com", "Instagram", "Facebook"],
    printChannels:      parsed.printChannels      ?? ["Just-Listed postcards (250)", "Premium feature sheets"],
    mlsHighlights:      parsed.mlsHighlights      ?? ["Updated kitchen", "Walkable neighborhood", "Move-in ready"],
    predictedDom:       parsed.predictedDom       ?? null,
    recommendedTier:    tier,
  }
}

// ─── Slide deck assembly ───────────────────────────────────────────────────

function buildSlideDeck(input: {
  propertyAddress: string
  cma: { low: number; mid: number; high: number; narrative: string }
  netSheet: NetSheetRow[]
  marketingPlan: MarketingPlan
  state: string
  forms: { required: string[] }
}): SlideDeckSlide[] {
  return [
    {
      title:   "Pricing Your Home",
      layout:  "title",
      content: { propertyAddress: input.propertyAddress, subtitle: "Strategy + Marketing + Net to You" },
    },
    {
      title:   "Estimated Value Range",
      layout:  "value-range",
      content: {
        low:  input.cma.low,
        mid:  input.cma.mid,
        high: input.cma.high,
        narrative: input.cma.narrative,
      },
    },
    {
      title:   "Net to You at 3 Price Points",
      layout:  "net-sheet",
      content: { rows: input.netSheet },
    },
    {
      title:   "Marketing Plan",
      layout:  "marketing",
      content: input.marketingPlan,
    },
    {
      title:   "Required Forms",
      layout:  "next-steps",
      content: {
        forms: input.forms.required,
        state: input.state,
        note:  "These are the documents we'll execute together to launch your listing.",
      },
    },
    {
      title:   "Timeline",
      layout:  "timeline",
      content: {
        steps: [
          { day: "Today",         label: "Listing agreement signed" },
          { day: "Day 1-3",       label: "Photography + final prep" },
          { day: "Day 4-7",       label: "Coming Soon marketing" },
          { day: "Day 8",         label: "MLS active" },
          { day: `Day ~${input.marketingPlan.predictedDom ?? 30}`, label: "Offers received" },
          { day: "Day +30 close", label: "Move on" },
        ],
      },
    },
  ]
}

// ─── Main builder ──────────────────────────────────────────────────────────

export async function buildListingPresentation(
  input: ListingPresentationInput
): Promise<{ success: boolean; result?: ListingPresentationResult; error?: string }> {
  try {
    const svc = createServiceClient()

    // 1. Run CMA (existing infrastructure)
    const cma = await runAiCma({
      mode: "standard",
      brokerageId: input.brokerageId,
      agentUserId: input.agentUserId ?? null,
      contactId:   input.contactId ?? null,
      subject: {
        address: input.propertyAddress,
        city:    input.city  ?? null,
        state:   input.state,
        zip:     input.zip   ?? null,
        bedrooms:  input.bedrooms  ?? null,
        bathrooms: input.bathrooms ?? null,
        sqftLiving: input.sqft     ?? null,
        yearBuilt:  input.yearBuilt ?? null,
        propertyType: "single_family",
      } as any,
    })

    // 2. Net sheet
    const netSheet = computeNetSheet(cma.estimatedValueMid, input.state)

    // 3. Marketing plan
    const marketingPlan = await buildMarketingPlan({
      propertyAddress: input.propertyAddress,
      state:           input.state,
      midValue:        cma.estimatedValueMid,
      bedrooms:        input.bedrooms,
      bathrooms:       input.bathrooms,
      sqft:            input.sqft,
    })

    // 4. State forms (used in the deck + linked packet)
    const stateForms = getStateForms(input.state, "listing")

    // 5. Slide deck
    const slideDeck = buildSlideDeck({
      propertyAddress: input.propertyAddress,
      cma: {
        low:  cma.estimatedValueLow,
        mid:  cma.estimatedValueMid,
        high: cma.estimatedValueHigh,
        narrative: cma.aiNarrative,
      },
      netSheet,
      marketingPlan,
      state: input.state,
      forms: { required: stateForms.required },
    })

    // 6. Stage the listing-agreement packet (so the agent can sign at the table)
    let packetDocumentId: string | null = null
    try {
      const { data: packetDoc } = await svc.from("documents").insert({
        brokerage_id:  input.brokerageId,
        contact_id:    input.contactId,
        document_type: "listing_agreement",
        status:        "needs_agent_input",
        state_code:    input.state,
        metadata: {
          packet_type: "listing",
          state: input.state,
          required_forms: stateForms.required,
          available_addenda: stateForms.addenda,
          brokerage_representation_form: stateForms.brokerageRepresentation,
          source: "auto_listing_presentation",
        },
        content: JSON.stringify({
          forms: stateForms,
          prefilled: {
            property_address: input.propertyAddress,
            state: input.state,
            suggested_list_price: cma.estimatedValueMid,
          },
        }, null, 2),
        created_at: new Date().toISOString(),
      }).select("id").single()
      packetDocumentId = packetDoc?.id ?? null
    } catch { /* packet creation is best-effort */ }

    // 7. Persist the presentation
    const { data: pres, error: presErr } = await svc.from("listing_presentations").insert({
      brokerage_id:    input.brokerageId,
      agent_user_id:   input.agentUserId,
      contact_id:      input.contactId,
      appointment_id:  input.appointmentId ?? null,
      property_address: input.propertyAddress,
      state:           input.state,
      appointment_at:  input.appointmentAt ?? null,
      cma_low_value:   cma.estimatedValueLow,
      cma_mid_value:   cma.estimatedValueMid,
      cma_high_value:  cma.estimatedValueHigh,
      cma_confidence:  cma.confidenceScore,
      cma_narrative:   cma.aiNarrative,
      net_sheet:       netSheet,
      marketing_plan:  marketingPlan,
      slide_deck:      slideDeck,
      packet_document_id: packetDocumentId,
      status:          "ready",
      notification_sent_at: new Date().toISOString(),
    }).select("id").single()

    if (presErr || !pres) {
      return { success: false, error: presErr?.message ?? "Could not save presentation" }
    }

    // 8. Notify agent
    if (input.agentUserId) {
      void Promise.resolve(svc.from("notifications").insert({
        user_id:      input.agentUserId,
        brokerage_id: input.brokerageId,
        type:         "listing_presentation_ready",
        title:        `Listing presentation ready for ${input.propertyAddress}`,
        body:         `Value range $${Math.round(cma.estimatedValueLow / 1000)}K-$${Math.round(cma.estimatedValueHigh / 1000)}K · 3-price net sheet · marketing plan · listing packet ready to sign at the table.`,
        priority:     "high",
        entity_type:  "listing_presentation",
        entity_id:    pres.id,
        channel:      "in_app",
      })).catch(() => {})
    }

    return {
      success: true,
      result: {
        presentationId: pres.id,
        cmaSnapshot: {
          low: cma.estimatedValueLow,
          mid: cma.estimatedValueMid,
          high: cma.estimatedValueHigh,
          confidence: cma.confidenceScore,
          narrative: cma.aiNarrative,
        },
        netSheet,
        marketingPlan,
        slideDeck,
        packetDocumentId,
      },
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
