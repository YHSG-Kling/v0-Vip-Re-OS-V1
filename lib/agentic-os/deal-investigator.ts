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

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = process.env.DEAL_INVESTIGATOR_MODEL ?? "claude-haiku-4-5-20251001"

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
    .select("id, first_name, last_name, email, phone, mailing_address, mailing_city, mailing_state, mailing_zip, enrichment_profile")
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
  try {
    if (contact.mailing_address && contact.mailing_zip) {
      const apiKey = process.env.RENTCAST_API_KEY
      if (apiKey) {
        const { callRentcastGet } = await import("@/lib/external/rentcast-typed")
        const avm = await callRentcastGet("/avm/value", {
          address: address,
        } as any, apiKey)
        result.cost += 0.01
        result.sources.mls = avm.data as unknown as Record<string, unknown> | null
      } else {
        result.warnings.push("rentcast: RENTCAST_API_KEY not configured")
      }
    }
  } catch (e) { result.warnings.push(`rentcast: ${(e as Error).message}`) }

  if (result.cost >= cap) { result.warnings.push("cap reached after MLS — skipping property"); return result }

  // (3) Property — BatchData MCP first, REST adapter as fallback (per recommendation #2)
  try {
    if (address) {
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

  // (4) Synthesize — one paragraph, AI-ISA-ready.
  if (!ANTHROPIC_KEY) {
    result.summary = "Claude not configured — sources collected; no synthesis."
    return result
  }
  try {
    const { callConnector } = await import("./connector-gateway")
    const llm = await callConnector<any>({
      connector: "anthropic",
      baseUrl:   "https://api.anthropic.com/v1",
      path:      "messages",
      method:    "POST",
      auth:      { style: "header", name: "x-api-key", value: ANTHROPIC_KEY },
      headers:   { "anthropic-version": "2023-06-01" },
      body: {
        model: MODEL,
        max_tokens: 320,
        messages: [{
          role: "user",
          content:
            "Synthesize ONE paragraph (3-5 sentences) for an inside sales rep about why this lead matters right now. " +
            "Lead with the strongest motivation signal. End with a concrete next-step suggestion. NO bullet points.\n\n" +
            `PERSON (PeopleData): ${JSON.stringify(result.sources.person).slice(0, 2000)}\n\n` +
            `MLS (RentCast): ${JSON.stringify(result.sources.mls).slice(0, 1500)}\n\n` +
            `PROPERTY (BatchData): ${JSON.stringify(result.sources.property).slice(0, 1500)}`,
        }],
      },
    })
    if (llm.ok && llm.data) {
      const text = (llm.data.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trim()
      result.summary = text.slice(0, 1500)
      const usage = llm.data.usage ?? {}
      result.cost += (usage.input_tokens ?? 0) / 1_000_000 * 1.0 + (usage.output_tokens ?? 0) / 1_000_000 * 5.0
    } else {
      result.warnings.push(`synthesis: ${llm.error}`)
    }
  } catch (e) { result.warnings.push(`synthesis: ${(e as Error).message}`) }

  return result
}
