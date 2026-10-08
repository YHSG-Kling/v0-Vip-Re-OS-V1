"use server"

/**
 * System 7.1A - Buyer Offer Execution Engine
 * Domain 3: AI Prefill
 * 
 * AI-prefills offer data from buyer profile, property, and market data
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { generateTextRouted as generateText } from "@/lib/ai/models"
// THE SPEND ACTOR. Every export in this "use server" file is a public HTTP
// endpoint, so the AI cost ledger's tenant can only come from the SESSION
// (CLAUDE.md §4) — never from an id the caller supplied.
import { getAgentContext } from "@/lib/identity/get-agent-context"

// ─── Property Data AI Fill ────────────────────────────────────────────────────

export interface PropertyFillData {
  property_address: string
  property_city: string
  property_state: string
  property_zip: string
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  year_built: number | null
  property_type: string
  property_address_ai_filled: true
  ai_confidence: "high" | "medium" | "low"
}

/**
 * When an offer form lacks property data, attempt to fill it from:
 *  1. The linked listing record (if listingId is provided)
 *  2. The buyer's property_interests / saved searches
 *  3. AI reasoning from any address fragment provided
 * Sets property_address_ai_filled = true so the UI can show a disclosure badge.
 */
export async function fillPropertyDataWithAI(params: {
  listingId?: string | null
  buyerId?: string | null
  addressFragment?: string | null
}): Promise<PropertyFillData | null> {
  // Tenant for the AI cost ledger — SESSION (§4). This runs on the SERVICE
  // client, so no row read here is tenant-scoped and none of them can supply a
  // payer; the caller's session is the only honest one.
  const spendActor = await getAgentContext()
  const supabase = createServiceClient()

  // ── 1. Try the listing record first ────────────────────────────────────────
  if (params.listingId && isValidUUID(params.listingId)) {
    const { data: listing } = await supabase
      .from("listings")
      .select("address, city, state, zip, bedrooms, bathrooms, sqft")
      .eq("id", params.listingId)
      .single()

    if (listing?.address) {
      return {
        property_address:        listing.address,
        property_city:           listing.city ?? "",
        property_state:          listing.state ?? "",
        property_zip:            listing.zip ?? "",
        bedrooms:                listing.bedrooms ?? null,
        bathrooms:               listing.bathrooms ?? null,
        sqft:                    listing.sqft ?? null,
        year_built:              null,
        property_type:           "Single Family",
        property_address_ai_filled: true,
        ai_confidence:           "high",
      }
    }
  }

  // ── 2. Pull buyer's property interests for context ─────────────────────────
  let buyerContext = ""
  if (params.buyerId && isValidUUID(params.buyerId)) {
    const { data: interests } = await supabase
      .from("property_interests")
      .select("preferred_locations, zip_codes, property_type, bedrooms, bathrooms, min_price, max_price")
      .eq("contact_id", params.buyerId)
      .limit(1)
      .maybeSingle()

    if (interests) {
      buyerContext = `
Buyer preferences:
- Preferred locations: ${(interests.preferred_locations ?? []).join(", ") || "not specified"}
- Zip codes: ${(interests.zip_codes ?? []).join(", ") || "not specified"}
- Property type: ${interests.property_type ?? "not specified"}
- Bedrooms: ${interests.bedrooms ?? "not specified"}
- Bathrooms: ${interests.bathrooms ?? "not specified"}
- Price range: $${interests.min_price?.toLocaleString() ?? "?"} – $${interests.max_price?.toLocaleString() ?? "?"}`
    }
  }

  // ── 3. Ask AI to fill in property details ──────────────────────────────────
  const addressHint = params.addressFragment?.trim()
  if (!addressHint && !buyerContext) return null

  try {
    const { text } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o-mini",
      prompt: `You are a real estate data assistant helping fill in missing property information for an offer form.

${addressHint ? `Address fragment provided: "${addressHint}"` : "No specific address provided."}
${buyerContext || ""}

Based on the above context, provide your best estimate of the property details. Return ONLY valid JSON — no markdown, no explanation.

{
  "property_address": string (full street address, or best guess),
  "property_city": string,
  "property_state": string (2-letter code),
  "property_zip": string,
  "bedrooms": number | null,
  "bathrooms": number | null,
  "sqft": number | null,
  "year_built": number | null,
  "property_type": "Single Family" | "Condo" | "Townhome" | "Multi-Family" | "Land" | "Commercial",
  "ai_confidence": "high" | "medium" | "low"
}`,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])

    return {
      property_address:            parsed.property_address ?? addressHint ?? "",
      property_city:               parsed.property_city ?? "",
      property_state:              parsed.property_state ?? "",
      property_zip:                parsed.property_zip ?? "",
      bedrooms:                    parsed.bedrooms ?? null,
      bathrooms:                   parsed.bathrooms ?? null,
      sqft:                        parsed.sqft ?? null,
      year_built:                  parsed.year_built ?? null,
      property_type:               parsed.property_type ?? "Single Family",
      property_address_ai_filled:  true,
      ai_confidence:               parsed.ai_confidence ?? "low",
    }
  } catch (err) {
    console.error("[buyer-offer] fillPropertyDataWithAI error:", err)
    return null
  }
}

// ─── REMOVED: prefillOfferWithAI (AI-generated offer TERMS) ────────────────────
//
// An earlier `prefillOfferWithAI` used the LLM to GENERATE offer terms (price, earnest money,
// contingencies, financing, closing days) for the agent. That contradicts the business process —
// the OFFER FORM IS FILLED BY THE AGENT; the system only pre-fills KNOWN property identification
// (see lib/intelligence/offer-property-prefill.ts). Auto-asserting a term the agent never entered is
// a fabrication the compliance gate flags. The function had ZERO callers, so it was removed rather
// than left as a foot-gun. Property-only prefill lives in resolveOfferPropertyPrefillAction, below.

// ─── PROPERTY-ONLY PREFILL, GROUNDED (no AI) ───────────────────────────────────
//
// This comment used to promise "resolveOfferPropertyPrefillAction" and no such export existed
// anywhere in the tree (a stale claim — CLAUDE.md §2: prose that describes a fix it never shipped).
// It is built here now, wired onto the real combinator (orphan doctrine §1.2 — the capability was
// wanted, and no duplicate existed; lib/intelligence/offer-property-prefill-runner.ts::
// prefillOfferFormProperty's own header already explains why NONE of its three other live callers —
// lib/kernel/forms.ts's offer context, prefill-storage-form.ts, prefill-property-into-pdf.ts — could
// simply call it as-is: each needs a step BETWEEN resolve and map that this file's other export,
// fillPropertyDataWithAI, does not have covered either. fillPropertyDataWithAI's own step 1 (an
// explicit listingId) is grounded, but it stops there and falls through to an AI GUESS the moment no
// listingId is passed — even when the transaction or the offer's own stored property_address already
// answers it, with zero risk of fabrication. This is that grounded answer, callable on its own with
// no PDF, no storage write, and no field vocabulary beyond the same canonical property-identification
// names buildPropertyPrefill (lib/intelligence/offer-property-prefill.ts) already recognizes — the
// exact preview shape app/actions/buyer-offer/esign-anchor-plan.ts::buildEsignAnchorPlanAction uses
// for its own preview-only step. Read-only; never asserts an offer TERM.
import { prefillOfferFormProperty } from "@/lib/intelligence/offer-property-prefill-runner"
import { KNOWN_PROPERTY_FIELD_LABELS, type PropertyPrefillResult } from "@/lib/intelligence/offer-property-prefill"

export interface ResolveOfferPropertyPrefillInput {
  listingId?: string | null
  transactionId?: string | null
  offerId?: string | null
  /** a raw property address the agent already typed (used only if no record carries it). */
  propertyAddress?: string | null
  /** the target form's own field names, when known (e.g. a parsed PDF). Defaults to the canonical
   *  labels above so a caller with no field list still gets a useful known/unknown preview. */
  formFields?: string[]
}

/**
 * Resolve KNOWN property facts (grounded — listing → transaction → offer's own address, never an AI
 * guess) and report which of the target form's property-identification fields they would fill. Pure
 * preview: writes nothing, fills no PDF, asserts no offer term.
 */
export async function resolveOfferPropertyPrefillAction(
  input: ResolveOfferPropertyPrefillInput,
): Promise<{ success: boolean } & PropertyPrefillResult & { facts?: Record<string, string | null> }> {
  try {
    const fields = input.formFields?.length ? input.formFields : [...KNOWN_PROPERTY_FIELD_LABELS]
    const result = await prefillOfferFormProperty(fields, {
      listingId: input.listingId ?? null,
      transactionId: input.transactionId ?? null,
      offerId: input.offerId ?? null,
      propertyAddress: input.propertyAddress ?? null,
    })
    return {
      success: true,
      filled: result.filled,
      unresolved: result.unresolved,
      facts: {
        address: result.facts.address ?? null,
        propertyCity: result.facts.propertyCity ?? null,
        propertyState: result.facts.propertyState ?? null,
        propertyZip: result.facts.propertyZip ?? null,
      },
    }
  } catch (err) {
    console.error("[buyer-offer] resolveOfferPropertyPrefillAction error:", err)
    return { success: false, filled: [], unresolved: [] }
  }
}
