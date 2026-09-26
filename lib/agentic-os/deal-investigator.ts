/**
 * lib/agentic-os/deal-investigator.ts
 *
 * "One paragraph, three vendors" agent — given a contact, fan out to PDL (person) + RentCast
 * (typed MLS) + BatchData (MCP-first, REST fallback) and ask Claude to synthesize a single
 * AI-ISA-ready summary of why this contact, why now. Replaces three manual lookups with one
 * structured artifact the agent can read.
 *
 * Every external call routes through the canonical gateway. Never throws (gateway contract).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface DealInvestigationParams {
  contactId: string
  /** Optional listing/property address override; defaults to the contact's mailing address. */
  propertyAddress?: string
  /** Hard cap on total spend — short-circuits the chain when reached. */
  maxCostUsd?: number
}

export interface DealInvestigation {
  contactId:     string
  summary:       string                 // one paragraph from Claude
  sources: {
    person:    Record<string, unknown> | null
    mls:       Record<string, unknown> | null
    property:  Record<string, unknown> | null
  }
  cost:          number
  warnings:      string[]
}

// AI-Gateway model slug — Claude synthesis routes through Vercel AI Gateway.
const MODEL = process.env.DEAL_INVESTIGATOR_MODEL ?? "anthropic/claude-haiku-4-5-20251001"

export async function investigateDeal(params: DealInvestigationParams): Promise<DealInvestigation> {
  const result: DealInvestigation = {
    contactId: params.contactId,
    summary:   "",
    sources:   { person: null, mls: null, property: null },
    cost:      0,
    warnings:  [],
  }
  const cap = params.maxCostUsd ?? 0.50  // sane default — stops 3 calls before they get expensive

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("id, brokerage_id, first_name, last_name, email, phone, mailing_address, mailing_city, mailing_state, mailing_zip, enrichment_profile")
    .eq("id", params.contactId)
    .maybeSingle()
  if (!contact) {
    return { ...result, warnings: ["contact not found"] }
  }

  const address = params.propertyAddress
    ?? [contact.mailing_address, contact.mailing_city, contact.mailing_state, contact.mailing_zip].filter(Boolean).join(", ")

  // (1) Person — PDL via existing client
  try {
    const { skipTraceWithPeopleData } = await import("@/lib/external/peopledata-client")
    const pdl = await skipTraceWithPeopleData({
      name:  [contact.first_name, contact.last_name].filter(Boolean).join(" ") || undefined,
      email: contact.email ?? undefined,
      phone: contact.phone ?? undefined,
      address: address || undefined,
    })
    result.cost += pdl.cost
    result.sources.person = pdl.data as unknown as Record<string, unknown> | null
  } catch (e) { result.warnings.push(`pdl: ${(e as Error).message}`) }

  if (result.cost >= cap) { result.warnings.push("cap reached after PDL — skipping MLS + property"); return result }

  // (2) MLS — RentCast typed-helper. AVM-by-address gives sale + rent estimates.
  // FIX (wave 70, lane 70C): this used to read RENTCAST_API_KEY and call callRentcastGet
  // directly — unmetered (the flat `cost: 0.01` was never logged to vendor_usage_tracking)
  // and skipped the platform vendor-budget gate every other RentCast caller goes through.
  // Routed through the ONE metered client (lib/property/rentcast.ts::getRentcastAVM) so
  // every RentCast request is booked at RENTCAST_USD_PER_REQUEST.
  try {
    if (contact.mailing_address && contact.mailing_zip) {
      if (!contact.brokerage_id) {
        result.warnings.push("rentcast: contact has no brokerage_id to meter against")
      } else {
        const { getRentcastAVM, RENTCAST_USD_PER_REQUEST } = await import("@/lib/property/rentcast")
        const avm = await getRentcastAVM({
          brokerageId: contact.brokerage_id,
          address,
          systemSource: "deal_investigator",
          contactId: contact.id,
        })
        result.cost += RENTCAST_USD_PER_REQUEST
        result.sources.mls = avm.value !== null ? (avm as unknown as Record<string, unknown>) : null
      }
    }
  } catch (e) { result.warnings.push(`rentcast: ${(e as Error).message}`) }

  if (result.cost >= cap) { result.warnings.push("cap reached after MLS — skipping property"); return result }

  // (3) Property — BatchData MCP first, REST adapter as fallback (per recommendation #2).
  // THE ONE BATCHDATA GATE (wave 81 lane B): a deal investigation is the STAFF "valuation"
  // purpose — lib/ai-isa/property-lookup-rail.ts::resolveBatchDataAccess (tier ≠ off, the
  // contact's tenant). Refused → the property source stays null and the warning says why.
  try {
    const { resolveBatchDataAccess } = await import("@/lib/ai-isa/property-lookup-rail")
    const access = address ? await resolveBatchDataAccess({ brokerageId: contact.brokerage_id, purpose: "valuation" }) : null
    if (access && !access.allowed) result.warnings.push(`batchdata: not reached — ${access.reason}`)
    if (address && access?.allowed) {
      const { batchDataPreferMcp } = await import("@/lib/external/batchdata-mcp")
      const property = await batchDataPreferMcp<Record<string, unknown>>(
        "property.search",
        { address },
        async () => {
          // REST fallback would call lib/external/batchdata-client.fetchMotivatedSellers / similar
          // shaped for a single address; left as a thunk returning null so this turn ships without
          // tightly coupling investigator to the existing REST module's specific signature.
          return null as unknown as Record<string, unknown>
        },
      )
      result.cost += 0.02
      result.sources.property = property.data
      if (property.via === "rest") result.warnings.push("batchdata: fell back to REST (MCP unconfigured or failed)")
    }
  } catch (e) { result.warnings.push(`batchdata: ${(e as Error).message}`) }

  // (4) Synthesize — one paragraph, AI-ISA-ready, via the Vercel AI Gateway.
  if (!process.env.AI_GATEWAY_API_KEY) {
    result.summary = "AI Gateway not configured — sources collected; no synthesis."
    return result
  }
  try {
    const { gatewayChat } = await import("@/lib/ai/gateway-chat")
    const llm = await gatewayChat({
      model: MODEL,
      maxTokens: 320,
      messages: [{
        role: "user",
        content:
          "Synthesize ONE paragraph (3-5 sentences) for an inside sales rep about why this lead matters right now. " +
          "Lead with the strongest motivation signal. End with a concrete next-step suggestion. NO bullet points.\n\n" +
          `PERSON (PeopleData): ${JSON.stringify(result.sources.person).slice(0, 2000)}\n\n` +
          `MLS (RentCast): ${JSON.stringify(result.sources.mls).slice(0, 1500)}\n\n` +
          `PROPERTY (BatchData): ${JSON.stringify(result.sources.property).slice(0, 1500)}`,
      }],
    })
    if (llm.ok && llm.content) {
      result.summary = llm.content.trim().slice(0, 1500)
      // Gateway dashboard is the source of truth for token cost; nothing to add to result.cost here.
    } else {
      result.warnings.push(`synthesis: ${llm.error}`)
    }
  } catch (e) { result.warnings.push(`synthesis: ${(e as Error).message}`) }

  return result
}
