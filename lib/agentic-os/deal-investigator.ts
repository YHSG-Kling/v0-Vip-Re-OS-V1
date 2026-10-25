/**
 * lib/agentic-os/deal-investigator.ts
 *
 * "One paragraph, three sources" agent — given a contact, fan out to PDL (person) + RentCast
 * (AVM) + RentCast (the full property record) and ask Claude to synthesize a single
 * AI-ISA-ready summary of why this contact, why now. Replaces three manual lookups with one
 * structured artifact the agent can read.
 *
 * WAVE 92 (lane 92B): the PROPERTY leg was BatchData (batchDataPreferMcp("property.search"),
 * purpose "valuation"). Owner (2026-10-01): "use rentcast as much as possible regarding … a
 * simple property lookup" · "batchdata is to be used more for scrapping leads". TOMBSTONE
 * (§1.3): that leg is deleted — survivor: lib/property/rentcast.ts::getRentcastPropertyDetail
 * (every attribute of the record: features, owner, sale history, tax years; staff-only, which
 * this investigator is), gated + metered + cached 30 days by the ONE RentCast client.
 * WAVE 93 (lane 93B, owner: "use batchdata as a backup"): the leg now asks the provider chain's
 * lookup (lib/avm/provider-chain.ts::getPropertyRecordWithFallback) — RentCast first, BatchData
 * only as the backup after a named RentCast miss. This is a staff button (runDealInvestigatorAction),
 * not an AI agent tool, so the server-side backup is permitted here.
 *
 * Every external call routes through the canonical gateway. Never throws (gateway contract).
 *
 * WAVE 144 (lane 144E — owner ruling 10's dedup rule: "field completeness → verified prior data → provenance/freshness →
 * required gap → cheaper appropriate provider → cost gate → append"): the investigator used to BUY both paid person legs on
 * every click — a $0.25 PeopleData match even when the contact's own profile carried a PeopleData capture from last week, and
 * three Versium credits for the online-presence indicators even when online-presence-store.ts already held them — and then
 * DROPPED the Versium answer (the gap 143D's store header names). Now: a FRESH stored answer is REUSED at $0 (freshness =
 * provider-dedup.ts PROVIDER_FRESHNESS_DAYS), a bought online-presence answer is PERSISTED through the store's one writer, and
 * the synthesis reads the observed intent / life-change facts (intent-signal-sources.ts) instead of a raw blob.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { VERSIUM_CREDIT_WEIGHTS, versiumCreditsUsd } from "@/lib/external/versium-client"

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
    /** Wave 142 (lane 142D): the online_presence capability — Versium's real-estate / online-presence
     *  indicators (OUR shape; protected characteristics dropped inside the adapter). */
    onlinePresence: Record<string, unknown> | null
  }
  /** Wave 144 (144E): the observed intent / life-change facts the record carries (intent-signal-sources.ts) — facts, not a score. */
  signals?:      import("@/lib/enrichment/intent-signal-sources").ObservedIntentSignal[]
  cost:          number
  warnings:      string[]
}

// AI-Gateway model slug — Claude synthesis routes through Vercel AI Gateway.
const MODEL = process.env.DEAL_INVESTIGATOR_MODEL ?? "anthropic/claude-haiku-4-5-20251001"

export async function investigateDeal(params: DealInvestigationParams): Promise<DealInvestigation> {
  const result: DealInvestigation = {
    contactId: params.contactId,
    summary:   "",
    sources:   { person: null, mls: null, property: null, onlinePresence: null },
    cost:      0,
    warnings:  [],
  }
  const cap = params.maxCostUsd ?? 0.50  // sane default — stops 3 calls before they get expensive

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("id, brokerage_id, first_name, last_name, email, phone, mailing_address, mailing_city, mailing_state, mailing_zip, enrichment_profile, life_events, last_life_event_detected, home_anniversary")
    .eq("id", params.contactId)
    .maybeSingle()
  if (!contact) {
    return { ...result, warnings: ["contact not found"] }
  }

  const address = params.propertyAddress
    ?? [contact.mailing_address, contact.mailing_city, contact.mailing_state, contact.mailing_zip].filter(Boolean).join(", ")

  const { PROVIDER_FRESHNESS_DAYS, isFresh } = await import("@/lib/enrichment/provider-dedup")
  const storedProfile = (contact.enrichment_profile && typeof contact.enrichment_profile === "object" ? contact.enrichment_profile : null) as Record<string, unknown> | null

  // (1) Person — PDL via existing client. Wave 144 (144E): a FRESH PeopleData capture already on the contact is reused at $0.
  const reusePdl = !!storedProfile && storedProfile.provider === "peopledata" && isFresh(storedProfile.captured_at, PROVIDER_FRESHNESS_DAYS.peopledata_profile)
  if (reusePdl) {
    // An ALLOW-LIST of the person-profile fields, never the whole jsonb: the profile also carries the household financials
    // (incl. the MODELED credit band — never a synthesis input, enrichment-one-rail-guard Layer 8d), the online-audience
    // hashes, provenance and the conflict record — none of which belongs in a prompt.
    const PERSON_FIELDS = ["full_name", "job_title", "employer", "industry", "job_start_date", "years_of_experience", "metro", "location_history", "interests", "education", "age_range", "home_owner_status", "life_events", "linkedin_url", "captured_at"] as const
    const person: Record<string, unknown> = { reused_from_profile: true }
    for (const k of PERSON_FIELDS) if (storedProfile && storedProfile[k] !== undefined && storedProfile[k] !== null) person[k] = storedProfile[k]
    result.sources.person = person
    result.warnings.push(`person: reused the stored PeopleData profile captured ${String(storedProfile?.captured_at)} (fresh within ${PROVIDER_FRESHNESS_DAYS.peopledata_profile} days — no new purchase)`)
  } else try {
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
        // Wave 99 (lane 99C, LAW 3): the property_valuation CAPABILITY (lib/avm/provider-chain.ts::
        // requestPropertyValuation) — a NORMALIZED valuation (value, range, confidence, source), never
        // the vendor body; cost is what the legs actually metered.
        const { requestPropertyValuation } = await import("@/lib/avm/provider-chain")
        const v = await requestPropertyValuation({
          brokerageId: contact.brokerage_id,
          address,
          systemSource: "deal_investigator",
          contactId: contact.id,
        })
        result.cost += v.costUsd
        result.sources.mls = v.valuation ? ({ ...v.valuation } as unknown as Record<string, unknown>) : null
      }
    }
  } catch (e) { result.warnings.push(`rentcast: ${(e as Error).message}`) }

  if (result.cost >= cap) { result.warnings.push("cap reached after MLS — skipping property"); return result }

  // (3) Property — the full RentCast property RECORD (wave 92; the BatchData leg is retired —
  // header). Same tenant attribution as the AVM leg above; a refusal leaves the source null and
  // says why. A cached record costs nothing (the client's 30-day fact cache).
  try {
    if (address && contact.brokerage_id) {
      // Wave 93 (lane 93B, owner: "use batchdata as a backup"): THE PROVIDER CHAIN's lookup —
      // RentCast's full record first, BatchData only as the backup after a named RentCast miss.
      const [{ getPropertyRecordWithFallback }, { RENTCAST_USD_PER_REQUEST }] = await Promise.all([
        import("@/lib/avm/provider-chain"),
        import("@/lib/property/rentcast"),
      ])
      // Wave 139 (lane 139D): the deal brief NEEDS year built / property type / last sale date — when
      // the answering record (RentCast, or the BatchData backup) left one empty, ONLY that gap walks the
      // property_facts capability route (Versium, gap-only, within what is left of this run's cap).
      const { record, note, backupCostUsd, gapFill } = await getPropertyRecordWithFallback({
        brokerageId: contact.brokerage_id,
        address,
        systemSource: "deal_investigator",
        contactId: contact.id,
        gapFields: ["yearBuilt", "propertyType", "lastSaleDate"],
        gapFillMaxUsd: Math.max(0, cap - result.cost - RENTCAST_USD_PER_REQUEST),
      })
      result.cost += RENTCAST_USD_PER_REQUEST + backupCostUsd + (gapFill?.costUsd ?? 0)
      const filled = gapFill ? (Object.keys(gapFill.filled) as Array<"yearBuilt" | "propertyType" | "lastSaleDate">) : []
      result.sources.property = record
        ? ({
            ...((record.rentcastDetail ?? record) as unknown as Record<string, unknown>),
            ...(filled.length ? { ...Object.fromEntries(filled.map((f) => [f, record[f]])), gap_filled_by: gapFill?.filled, gap_fill_provenance: gapFill?.provenance ?? null } : {}),
          } as Record<string, unknown>)
        : null
      if (!record) result.warnings.push(`property record: none (${note})`)
      else if (record.provider === "batchdata") result.warnings.push(`property record: ${note}`)
      if (gapFill && gapFill.asked.length > filled.length) result.warnings.push(`property facts still empty after the gap fill (${gapFill.asked.filter((f) => !gapFill.filled[f]).join(", ")}): ${gapFill.skipped.map((s) => `${s.provider} — ${s.reason}`).join("; ") || "no provider answered"}`)
    } else if (address) {
      result.warnings.push("rentcast: contact has no brokerage_id to meter the property record against")
    }
  } catch (e) { result.warnings.push(`rentcast property record: ${(e as Error).message}`) }

  // (3b) ONLINE PRESENCE — wave 142 (lane 142D; owner: "'Online Presence Indicator - Real Estate' and
  // other real-estate indicators … exposed through existing kernel-governed capabilities"). The
  // online_presence CAPABILITY (lib/ai-isa/property-lookup-rail.ts runVersiumOnlinePresenceLeg): one
  // Versium full-demographic match, within what is left of this run's cap, budget-gated and booked by the
  // leg; protected characteristics never leave the adapter. A refusal leaves the source null and says why.
  const { realEstateIndicatorsFromProfile, persistRealEstateIndicators } = await import("@/lib/enrichment/online-presence-store")
  const storedIndicators = realEstateIndicatorsFromProfile(storedProfile)
  let boughtIndicators: Record<string, unknown> | null = null
  try {
    if (storedIndicators && isFresh(storedIndicators.capturedAt, PROVIDER_FRESHNESS_DAYS.versium_online_presence)) {
      // Wave 144 (144E): the stored indicators answer the gap — no second purchase of the same three credits.
      result.sources.onlinePresence = { ...storedIndicators, reused_from_profile: true } as unknown as Record<string, unknown>
    } else if (contact.brokerage_id && result.cost + versiumCreditsUsd(VERSIUM_CREDIT_WEIGHTS.full_demographic) <= cap) {
      const { runVersiumOnlinePresenceLeg } = await import("@/lib/ai-isa/property-lookup-rail")
      const op = await runVersiumOnlinePresenceLeg({
        brokerageId: contact.brokerage_id,
        identity: {
          firstName: contact.first_name ?? null, lastName: contact.last_name ?? null,
          email: contact.email ?? null, phone: contact.phone ?? null,
          address: contact.mailing_address ?? null, city: contact.mailing_city ?? null, state: contact.mailing_state ?? null, zip: contact.mailing_zip ?? null,
        },
        systemSource: "deal_investigator",
        metadata: { contactId: contact.id },
        attribution: { contactId: contact.id },
      })
      result.cost += op.cost
      result.sources.onlinePresence = op.indicators ? ({ ...op.indicators, provenance: op.provenance } as unknown as Record<string, unknown>) : null
      if (!op.answered && op.skipped) result.warnings.push(`online presence: ${op.skipped}`)
      // Wave 144 (144E): the bought answer is KEPT on the contact (the one writer, tenant-anchored, refresh — it was stale or absent).
      if (op.indicators) {
        boughtIndicators = { ...op.indicators }
        const kept = await persistRealEstateIndicators(svc, { contactId: contact.id, brokerageId: contact.brokerage_id }, op.indicators, op.provenance, { refresh: true })
        if (!kept.ok) result.warnings.push(`online presence: bought but not stored — ${kept.error}`)
      }
    } else if (contact.brokerage_id) {
      result.warnings.push("cap reached before online presence — skipped")
    }
  } catch (e) { result.warnings.push(`online presence: ${(e as Error).message}`) }

  // (3c) OBSERVED INTENT / LIFE-CHANGE FACTS (wave 144, 144E) — stored facts only, no call, no spend (intent-signal-sources.ts).
  // Re-read with the indicators just stored so a fresh purchase is reflected.
  const { intentSignalsFromContact } = await import("@/lib/enrichment/intent-signal-sources")
  const signals = intentSignalsFromContact({
    enrichment_profile: boughtIndicators
      ? { ...(storedProfile ?? {}), real_estate_indicators: { ...boughtIndicators, captured_at: new Date().toISOString() } }
      : storedProfile,
    life_events: contact.life_events, last_life_event_detected: contact.last_life_event_detected, home_anniversary: contact.home_anniversary,
  }).filter((s) => s.sensitivity !== "age") // the birthday month is a card / education-format input, never a "why now" for a rep
  result.signals = signals

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
          `PROPERTY RECORD (RentCast): ${JSON.stringify(result.sources.property).slice(0, 1500)}\n\n` +
          `REAL-ESTATE INDICATORS (Versium online presence — a research signal, never a reason to treat anyone differently): ${JSON.stringify(result.sources.onlinePresence).slice(0, 800)}\n\n` +
          `OBSERVED INTENT / LIFE-CHANGE FACTS (provider-observed, each with its source and date — facts, not conclusions; never a protected characteristic): ${JSON.stringify(signals.map((s) => ({ fact: s.key, value: s.value, source: s.provider, months_since: s.monthsSince }))).slice(0, 800)}`,
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
