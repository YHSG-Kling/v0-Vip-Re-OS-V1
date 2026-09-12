/**
 * lib/showings/showing-brief.ts
 *
 * Builds a per-showing 1-pager the agent reads before walking the buyer
 * into a property. Pure-function compositor over data the platform
 * already captures.
 *
 * Vocabulary the codebase uses:
 *   LISTING  = seller-side inventory (the brokerage's own listings table)
 *   PROPERTY = buyer-side, lives in saved_properties when the buyer has
 *              shown interest, or comes from external sources (RentCast,
 *              IDX, Zillow/Realtor scrape) via /lib/property/
 *
 * Property-facts resolution order (buyer-side first, because most showings
 * are external-MLS properties the buyer found):
 *   1. saved_properties row for this (contact_id, mls / external_id /
 *      address) — best source: has price, beds/baths, sqft, photo, AI match
 *      score, the buyer's notes, dismissed flag
 *   2. listings row when showings.listing_id is set (our seller-side
 *      inventory — showings of our own listings)
 *   3. showings.external_metadata jsonb (set by ingestion adapters)
 *   4. showings.external_address as a final string fallback
 *
 * Comps come from BOTH the brokerage's listings table AND saved_properties
 * in the same ZIP so the buyer sees properties they've already considered
 * alongside seller-side inventory.
 *
 * Other parallel pulls:
 *   contact + property_preferences + buyer_financial_profiles +
 *   buyer_behavior_predictions + buyer_behavior_log (14d) + buyer_stage_coaching
 *
 * Then computeMatchup() pairs each buyer criterion against the property and
 * generateAiSummary() asks the AI for 4-6 specific talking points tied
 * to THIS buyer's signals (not generic real-estate advice).
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import { loadBuyerCriteria } from "@/lib/buyer-search/buyer-criteria"
import { VIEW_SIGNALS, SAVE_SIGNALS, DISMISS_SIGNALS } from "@/lib/behavior-learning/signal-mapping"

export interface MatchupRow {
  criterion:   string
  buyerWants:  string
  propertyHas: string
  match:       "yes" | "no" | "partial" | "unknown"
}

export interface ShowingBriefing {
  showingId:         string
  scheduledAt:       string | null
  durationMinutes:   number | null
  accessInstructions: string | null

  buyer: {
    contactId:           string | null
    fullName:            string
    timeline:            string | null
    budgetMin:           number | null
    budgetMax:           number | null
    preApprovedAmount:   number | null
    preApprovedLender:   string | null
    isCashBuyer:         boolean
    contactType:         string | null
    notes:               string | null
  }

  /**
   * The property being shown. Resolved (in priority order) from
   *   1. saved_properties (buyer-side cache, richest data)
   *   2. listings (when showings.listing_id is set — our seller-side inventory)
   *   3. showings.external_metadata jsonb (set by ingestion adapters)
   *   4. showings.external_address as final text fallback
   */
  property: {
    listingId:         string | null  // non-null only when it's our seller-side listing
    address:           string | null
    city:              string | null
    state:             string | null
    zip:               string | null
    listPrice:         number | null
    bedrooms:          number | null
    bathrooms:         number | null
    sqft:              number | null
    mlsNumber:         string | null
    status:            string | null
    source:            "saved" | "listing" | "external_metadata" | "external_address" | null
    aiMatchScore:      number | null
    matchReasons:      string[]
    buyerNotes:        string | null
  }

  matchup:           MatchupRow[]
  recentSignals:     string[]
  predictedNextAction: string | null
  // Pure market comps — same ZIP, sold/pending/active from the brokerage's
  // listings table. This is the pricing/valuation signal the agent uses
  // to anchor "is this priced right?" conversations.
  recentComps: Array<{
    address:    string
    listPrice:  number | null
    bedrooms:   number | null
    bathrooms:  number | null
    sqft:       number | null
    status:     string | null
  }>

  // Buyer-journey context — other properties THIS buyer has saved in the
  // same city. Separate from comps because this is engagement data,
  // not pricing data ("remember you also liked X for $Y").
  buyerAlsoConsidered: Array<{
    address:    string
    listPrice:  number | null
    bedrooms:   number | null
    bathrooms:  number | null
    sqft:       number | null
    propertyType: string | null
  }>

  aiSummary:         string | null
  aiTalkingPoints:   string[]
  aiObjections:      string[]
  aiRiskFlags:       string[]
  modelUsed:         string | null
}

const dollars = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`

/**
 * Loads every input from the live DB and returns a complete briefing
 * payload. Used by both the cron (batch generate) and the on-demand
 * regenerate server action.
 */
export async function buildShowingBriefing(showingId: string): Promise<ShowingBriefing | null> {
  const svc = createServiceClient()

  // 1. Showing core — listing_id is set for seller-side inventory shows;
  //    for buyer-side external MLS shows it's null and external_* carry the
  //    property reference.
  const { data: showing } = await svc
    .from("showings")
    .select("id, listing_id, contact_id, agent_id, scheduled_at, duration_minutes, access_method, access_code, access_instructions, brokerage_id, external_address, external_mls_id, external_metadata")
    .eq("id", showingId)
    .maybeSingle()
  if (!showing) return null

  // 2-N in parallel — buyer data + (optional) seller-side listing row
  const [
    { data: listing },
    { data: contact },
    pref,
    { data: finance },
    { data: prediction },
    behaviorRes,
    { data: coaching },
    { data: savedRow },
  ] = await Promise.all([
    showing.listing_id
      ? svc.from("listings").select("id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, mls_number, status").eq("id", showing.listing_id).maybeSingle()
      : Promise.resolve({ data: null }),
    showing.contact_id
      ? svc.from("contacts").select("id, first_name, last_name, contact_type, budget_min, budget_max, timeline, notes, email, phone").eq("id", showing.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    showing.contact_id
      ? loadBuyerCriteria(svc, showing.contact_id)   // consolidated normalized criteria reader
      : Promise.resolve(null),
    showing.contact_id
      ? svc.from("buyer_financial_profiles").select("pre_approval_amount, pre_approval_lender, finance_type, is_cash_buyer, down_payment_amount, estimated_monthly_budget").eq("contact_id", showing.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    showing.contact_id
      ? svc.from("buyer_behavior_predictions").select("predicted_next_action, predicted_ready_to_offer, predicted_price_max, predicted_timeline_days, engagement_score, ai_reasoning").eq("contact_id", showing.contact_id).order("generated_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
    // listing_id + mls_number let the brief match log rows against THIS
    // showing's property ("they already saved this one"); source separates
    // portal self-serve signals from agent-dashboard ones; agent_id (FK →
    // agents.id, same target as showings.agent_id) says who was with them.
    showing.contact_id
      ? svc.from("buyer_behavior_log").select("signal_type, signal_value, property_address, bedrooms, bathrooms, sqft, list_price, created_at, listing_id, mls_number, source, agent_id").eq("contact_id", showing.contact_id).gte("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(30)
      : Promise.resolve({ data: [], error: null }),
    svc.from("buyer_stage_coaching").select("buyer_stage, suggested_talking_points, common_objections, success_signals, risk_signals").eq("is_active", true).limit(5),
    // Buyer-side property cache lookup. Match strategy (any one):
    //   - showings.listing_id matches saved_properties.listing_id
    //   - showings.external_mls_id matches saved_properties.mls_number
    //   - normalised address match within this contact's saves
    showing.contact_id
      ? (async () => {
          const orParts: string[] = []
          if (showing.listing_id)      orParts.push(`listing_id.eq.${showing.listing_id}`)
          if (showing.external_mls_id) orParts.push(`mls_number.eq.${showing.external_mls_id}`)
          if (showing.external_address) {
            // ilike with the first segment of the address (street # + name)
            const seg = showing.external_address.split(",")[0].trim().replace(/[%']/g, "")
            if (seg) orParts.push(`property_address.ilike.${seg}%`)
          }
          if (orParts.length === 0) return { data: null }
          const { data } = await svc
            .from("saved_properties")
            .select("listing_id, mls_number, external_property_id, property_address, city, state, list_price, bedrooms, bathrooms, sqft, property_type, primary_photo_url, ai_match_score, match_reasons, notes")
            .eq("contact_id", showing.contact_id)
            .or(orParts.join(","))
            .order("saved_at", { ascending: false })
            .limit(1)
            .maybeSingle()
          return { data }
        })()
      : Promise.resolve({ data: null }),
  ])

  // Comp lookup — pulls from BOTH listings (seller-side) and saved_properties
  // (buyer-side, what the buyer has already considered) in the same ZIP.
  // Buyer-shopping comps are more meaningful for a buyer-side showing.
  const compZip =
    listing?.zip ??
    (savedRow as any)?.state ?? null  // saved_properties has state but no zip column
  const resolvedZip = listing?.zip ?? null  // only seller-side has zip directly

  const [{ data: listingComps }, { data: savedComps }] = await Promise.all([
    resolvedZip
      ? svc
          .from("listings")
          .select("address, list_price, bedrooms, bathrooms, sqft, status")
          .eq("zip", resolvedZip)
          .neq("id", showing.listing_id ?? "00000000-0000-0000-0000-000000000000")
          .in("status", ["sold", "pending", "active"])
          .order("list_price", { ascending: false })
          .limit(5)
      : Promise.resolve({ data: [] }),
    // Saved-properties comps: other properties this buyer has saved in the
    // same city (best proxy when zip isn't on saved_properties).
    showing.contact_id && (savedRow as any)?.city
      ? svc
          .from("saved_properties")
          .select("property_address, list_price, bedrooms, bathrooms, sqft, property_type")
          .eq("contact_id", showing.contact_id)
          .eq("city", (savedRow as any).city)
          .neq("property_address", (savedRow as any).property_address ?? "")
          .order("saved_at", { ascending: false })
          .limit(5)
      : Promise.resolve({ data: [] }),
  ])
  void compZip

  // Build buyer snapshot
  const fullName = contact
    ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Buyer"
    : "Buyer"

  const buyer = {
    contactId:         contact?.id ?? null,
    fullName,
    timeline:          contact?.timeline ?? null,
    budgetMin:         contact?.budget_min ?? pref?.minPrice ?? null,
    budgetMax:         contact?.budget_max ?? pref?.maxPrice ?? null,
    preApprovedAmount: finance?.pre_approval_amount ?? null,
    preApprovedLender: finance?.pre_approval_lender ?? null,
    isCashBuyer:       finance?.is_cash_buyer === true,
    contactType:       contact?.contact_type ?? null,
    notes:             contact?.notes ?? null,
  }

  // Property snapshot — resolves through 4 fallback sources in priority order.
  // saved_properties wins because it's the buyer-side cache and carries the
  // platform's AI match score + the buyer's own notes.
  const saved = savedRow as any
  const meta  = (showing.external_metadata ?? {}) as Record<string, any>
  const source: ShowingBriefing["property"]["source"] =
    saved ? "saved"
    : listing ? "listing"
    : Object.keys(meta).length > 0 ? "external_metadata"
    : showing.external_address ? "external_address"
    : null

  const propertyView: ShowingBriefing["property"] = {
    listingId:    listing?.id ?? null,
    address:      saved?.property_address ?? listing?.address ?? meta?.address ?? showing.external_address ?? null,
    city:         saved?.city ?? listing?.city ?? meta?.city ?? null,
    state:        saved?.state ?? listing?.state ?? meta?.state ?? null,
    zip:          listing?.zip ?? meta?.zip ?? meta?.postal_code ?? null,
    listPrice:    saved?.list_price ?? listing?.list_price ?? meta?.list_price ?? meta?.price ?? null,
    bedrooms:     saved?.bedrooms ?? listing?.bedrooms ?? meta?.bedrooms ?? null,
    bathrooms:    saved?.bathrooms ?? listing?.bathrooms ?? meta?.bathrooms ?? null,
    sqft:         saved?.sqft ?? listing?.sqft ?? meta?.sqft ?? meta?.square_feet ?? null,
    mlsNumber:    saved?.mls_number ?? listing?.mls_number ?? showing.external_mls_id ?? meta?.mls_number ?? null,
    status:       listing?.status ?? meta?.status ?? null,
    source,
    aiMatchScore: saved?.ai_match_score ?? null,
    matchReasons: Array.isArray(saved?.match_reasons) ? (saved!.match_reasons as string[]) : [],
    buyerNotes:   typeof saved?.notes === "string" ? saved.notes : null,
  }

  // Build matchup grid — each row compares one buyer criterion vs the listing
  const matchup: MatchupRow[] = []

  // Price
  if (buyer.budgetMax || buyer.preApprovedAmount) {
    const budget = buyer.preApprovedAmount ?? buyer.budgetMax ?? null
    if (budget && propertyView.listPrice) {
      const fitsBudget = propertyView.listPrice <= budget * 1.05
      const stretches  = propertyView.listPrice > budget && propertyView.listPrice <= budget * 1.05
      matchup.push({
        criterion:  "Budget",
        buyerWants: dollars(budget),
        propertyHas: dollars(propertyView.listPrice),
        match:      fitsBudget ? (stretches ? "partial" : "yes") : "no",
      })
    }
  }

  // Beds
  const wantBedsMin = pref?.minBeds ?? null
  if (wantBedsMin && propertyView.bedrooms != null) {
    matchup.push({
      criterion:  "Bedrooms",
      buyerWants: `≥ ${wantBedsMin}`,
      propertyHas: `${propertyView.bedrooms}`,
      match:      propertyView.bedrooms >= wantBedsMin ? "yes" : "no",
    })
  }

  // Baths
  const wantBathsMin = pref?.minBaths ?? null
  if (wantBathsMin && propertyView.bathrooms != null) {
    matchup.push({
      criterion:  "Bathrooms",
      buyerWants: `≥ ${wantBathsMin}`,
      propertyHas: `${propertyView.bathrooms}`,
      match:      propertyView.bathrooms >= wantBathsMin ? "yes" : "no",
    })
  }

  // Cities / ZIPs
  const inferredCities = (pref?.cities ?? []) as string[]
  const inferredZips   = (pref?.zipCodes ?? []) as string[]
  if (inferredCities.length && propertyView.city) {
    const m = inferredCities.some(c => c.toLowerCase() === propertyView.city!.toLowerCase())
    matchup.push({
      criterion:  "Location",
      buyerWants: inferredCities.slice(0, 3).join(", "),
      propertyHas: propertyView.city,
      match:      m ? "yes" : "partial",
    })
  } else if (inferredZips.length && propertyView.zip) {
    const m = inferredZips.includes(propertyView.zip)
    matchup.push({
      criterion:  "ZIP",
      buyerWants: inferredZips.slice(0, 3).join(", "),
      propertyHas: propertyView.zip,
      match:      m ? "yes" : "partial",
    })
  }

  // Must-haves
  const mustHaves = (pref?.mustHaveFeatures ?? []) as string[]
  if (mustHaves.length) {
    matchup.push({
      criterion:  "Must-haves",
      buyerWants: mustHaves.slice(0, 4).join(", "),
      propertyHas: "(check on tour)",
      match:      "unknown",
    })
  }

  // Deal-breakers
  const dealBreakers = (pref?.dealBreakers ?? []) as string[]
  if (dealBreakers.length) {
    matchup.push({
      criterion:  "Deal-breakers",
      buyerWants: `Avoid: ${dealBreakers.slice(0, 3).join(", ")}`,
      propertyHas: "(check on tour)",
      match:      "unknown",
    })
  }

  // Recent buyer signals — humanised one-liners
  const signals: string[] = []
  if (behaviorRes.error) {
    // §3: a swallowed refusal here would render as "no recent signals" —
    // log it so a broken read never masquerades as a quiet buyer.
    console.error("[showing-brief] buyer_behavior_log read refused:", behaviorRes.error.message)
  }
  const beh = (behaviorRes.data ?? []) as any[]
  const last14 = beh.length
  if (last14 > 0) {
    signals.push(`${last14} signal${last14 === 1 ? "" : "s"} in last 14 days`)
  }
  // §6 one vocabulary: the live CHECK on buyer_behavior_log.signal_type
  // (scripts/check-vocabularies.ts) admits NO "view"/"save"/"favorite" — the
  // old filters matched zero rows structurally, so "Viewed N"/"Saved N" had
  // never rendered. The canonical signal families were LIFTED from here into
  // lib/behavior-learning/signal-mapping.ts (§6, 2026-09-01) — the module that
  // owns the buyer_behavior_log vocabulary mappers — so the audience readers
  // in app/actions/email-campaigns.ts count the same families this brief does.
  const viewCount = beh.filter(b => VIEW_SIGNALS.has(b.signal_type)).length
  if (viewCount > 0) signals.push(`Viewed ${viewCount} listing${viewCount === 1 ? "" : "s"}`)
  const saveCount = beh.filter(b => SAVE_SIGNALS.has(b.signal_type)).length
  if (saveCount > 0) signals.push(`Saved ${saveCount}`)
  const recentPrices = beh.map(b => b.list_price).filter((p): p is number => typeof p === "number")
  if (recentPrices.length > 2) {
    const avg = Math.round(recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length)
    signals.push(`Recent viewing avg ${dollars(avg)}`)
  }
  // Size trend (lane M2): buyer_behavior_log.sqft is stamped by the learner's
  // signal writer and was read by nothing — yet "are they trending bigger or
  // smaller than this house" is a live showing question. Same >2 floor as the
  // price average: two data points are an anecdote, not a trend.
  const recentSqft = beh.map(b => b.sqft).filter((s): s is number => typeof s === "number" && s > 0)
  if (recentSqft.length > 2) {
    const avgSqft = Math.round(recentSqft.reduce((a, b) => a + b, 0) / recentSqft.length)
    signals.push(`Recent viewing avg ${avgSqft.toLocaleString()} sqft`)
  }

  // "This buyer already reacted to THIS property" — matches the 14-day log
  // window against the showing's own property via listing_id (seller-side
  // shows), mls_number (external MLS shows), or a normalised address
  // fallback. Only computable now that the select carries listing_id +
  // mls_number (tranche 1a). source tells the agent whether the reaction was
  // the buyer's own (portal/alert/mobile) or logged from the agent dashboard;
  // agent_id (same agents-table FK as showings.agent_id) tells them whether
  // another agent was in the room.
  const addrKey = (a: string | null | undefined) =>
    (a ?? "").split(",")[0].trim().toLowerCase()
  const briefAddr = addrKey(propertyView.address)
  const thisPropertyRows = beh.filter(b =>
    (showing.listing_id && b.listing_id === showing.listing_id) ||
    (propertyView.mlsNumber && b.mls_number === propertyView.mlsNumber) ||
    (briefAddr && addrKey(b.property_address) === briefAddr),
  )
  if (thisPropertyRows.length > 0) {
    const PORTAL_SOURCES = new Set(["buyer_portal", "alert_email", "mobile"])
    const describe = (rows: any[]) => {
      const viaPortal = rows.some(r => PORTAL_SOURCES.has(r.source))
      const withOtherAgent = rows.some(r => r.agent_id && showing.agent_id && r.agent_id !== showing.agent_id)
      const qualifiers = [
        viaPortal ? "on their own via portal" : null,
        withOtherAgent ? "with another agent" : null,
      ].filter(Boolean).join(", ")
      return qualifiers ? ` (${qualifiers})` : ""
    }
    const viewedHere    = thisPropertyRows.filter(b => VIEW_SIGNALS.has(b.signal_type))
    const savedHere     = thisPropertyRows.filter(b => SAVE_SIGNALS.has(b.signal_type))
    const dismissedHere = thisPropertyRows.filter(b => DISMISS_SIGNALS.has(b.signal_type))
    if (savedHere.length > 0) {
      signals.push(`Already saved THIS property${describe(savedHere)}`)
    }
    if (dismissedHere.length > 0) {
      // A prior dismissal of the very property being shown is the single most
      // important line on the brief — the agent should know before the door.
      signals.push(`Previously dismissed THIS property${describe(dismissedHere)} — ask what changed`)
    }
    if (viewedHere.length > 0 && savedHere.length === 0 && dismissedHere.length === 0) {
      signals.push(`Already viewed THIS property ${viewedHere.length}×${describe(viewedHere)}`)
    }
  }

  const predictedNextAction = prediction?.predicted_next_action ?? null
  if (prediction?.predicted_ready_to_offer === true) {
    signals.push("Predicted ready to offer")
  }

  // Coaching content — pull common objections + talking points the AI can riff on
  const coachingRows = (coaching ?? []) as any[]
  const coachTalking  = coachingRows.flatMap(c => (c.suggested_talking_points ?? []) as string[]).slice(0, 4)
  const coachObjects  = coachingRows.flatMap(c => (c.common_objections ?? []) as string[]).slice(0, 3)
  const coachRisks    = coachingRows.flatMap(c => (c.risk_signals ?? []) as string[]).slice(0, 3)

  // Market comps — seller-side listings in this ZIP only. Pure pricing signal.
  const compsView: ShowingBriefing["recentComps"] = ((listingComps ?? []) as any[]).map((c) => ({
    address:   c.address ?? "",
    listPrice: c.list_price ?? null,
    bedrooms:  c.bedrooms ?? null,
    bathrooms: c.bathrooms ?? null,
    sqft:      c.sqft ?? null,
    status:    c.status ?? null,
  }))

  // Buyer-journey context — properties this buyer has also saved in the
  // same city. Distinct from comps — this is engagement data.
  const alsoConsideredView: ShowingBriefing["buyerAlsoConsidered"] = ((savedComps ?? []) as any[]).map((c) => ({
    address:      c.property_address ?? "",
    listPrice:    c.list_price ?? null,
    bedrooms:     c.bedrooms ?? null,
    bathrooms:    c.bathrooms ?? null,
    sqft:         c.sqft ?? null,
    propertyType: c.property_type ?? null,
  }))

  // AI: 4-6 specific talking points tied to THIS buyer and THIS property
  const aiResult = await generateBriefAI({
    buyer, property: propertyView, matchup, signals, coachTalking, coachObjects,
    predictedNextAction, predictedReadyToOffer: prediction?.predicted_ready_to_offer === true,
    aiReasoning: prediction?.ai_reasoning ?? null,
    buyerAlsoConsidered: alsoConsideredView,
    brokerageId: showing.brokerage_id,
  })

  return {
    showingId:           showing.id,
    scheduledAt:         showing.scheduled_at ?? null,
    durationMinutes:     showing.duration_minutes ?? null,
    accessInstructions:  [
      showing.access_method,
      showing.access_code ? `Code: ${showing.access_code}` : null,
      showing.access_instructions,
    ].filter(Boolean).join(" • ") || null,
    buyer,
    property:            propertyView,
    matchup,
    recentSignals:       signals,
    predictedNextAction,
    recentComps:         compsView,
    buyerAlsoConsidered: alsoConsideredView,
    aiSummary:           aiResult.summary,
    aiTalkingPoints:     aiResult.talkingPoints,
    aiObjections:        aiResult.objections.length ? aiResult.objections : coachObjects,
    aiRiskFlags:         aiResult.riskFlags.length ? aiResult.riskFlags : coachRisks,
    modelUsed:           aiResult.modelUsed,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// AI step — generates the summary + tailored talking points
// ────────────────────────────────────────────────────────────────────────────

interface AiBriefInput {
  buyer:                 ShowingBriefing["buyer"]
  property:              ShowingBriefing["property"]
  matchup:               MatchupRow[]
  signals:               string[]
  coachTalking:          string[]
  coachObjects:          string[]
  predictedNextAction:   string | null
  predictedReadyToOffer: boolean
  aiReasoning:           string | null
  buyerAlsoConsidered:   ShowingBriefing["buyerAlsoConsidered"]
  brokerageId:           string | null
}

interface AiBriefOutput {
  summary:       string | null
  talkingPoints: string[]
  objections:    string[]
  riskFlags:     string[]
  modelUsed:     string | null
}

async function generateBriefAI(input: AiBriefInput): Promise<AiBriefOutput> {
  const propertyLine = [
    input.property.address,
    input.property.listPrice ? dollars(input.property.listPrice) : null,
    input.property.bedrooms != null ? `${input.property.bedrooms} bd` : null,
    input.property.bathrooms != null ? `${input.property.bathrooms} ba` : null,
    input.property.sqft ? `${input.property.sqft} sqft` : null,
  ].filter(Boolean).join(" · ")

  const buyerLine = [
    input.buyer.fullName,
    input.buyer.timeline ? `Timeline: ${input.buyer.timeline}` : null,
    input.buyer.preApprovedAmount ? `Pre-approved ${dollars(input.buyer.preApprovedAmount)}` : input.buyer.budgetMax ? `Budget up to ${dollars(input.buyer.budgetMax)}` : null,
    input.buyer.isCashBuyer ? "Cash buyer" : null,
  ].filter(Boolean).join(" · ")

  const matchupText = input.matchup.map((m) => `- ${m.criterion}: wants ${m.buyerWants}, property has ${m.propertyHas} → ${m.match}`).join("\n")
  const signalsText = input.signals.length ? input.signals.join(" · ") : "(no recent signals)"

  // Buyer-side enrichment from saved_properties — the platform may have
  // already explained WHY this property matched + the buyer's own notes.
  const matchReasonsText = input.property.matchReasons.length
    ? `WHY THIS MATCHED ORIGINALLY: ${input.property.matchReasons.slice(0, 4).join("; ")}`
    : ""
  const buyerNotesText = input.property.buyerNotes
    ? `BUYER'S OWN NOTES: "${input.property.buyerNotes}"`
    : ""
  const aiScoreText = input.property.aiMatchScore != null
    ? `AI MATCH SCORE: ${Math.round(input.property.aiMatchScore * 100)}%`
    : ""

  // Buyer-journey context — other properties this buyer is shopping. Lets the
  // AI riff on "compared to the X you also saved at $Y, this one offers Z".
  const alsoConsideredText = input.buyerAlsoConsidered.length
    ? `BUYER IS ALSO CONSIDERING: ${input.buyerAlsoConsidered.slice(0, 4).map(p => {
        const beds = p.bedrooms != null ? `${p.bedrooms}bd` : ""
        const price = p.listPrice ? dollars(p.listPrice) : ""
        return [p.address, beds, price].filter(Boolean).join(" ")
      }).join("; ")}`
    : ""

  const prompt = `You are coaching a real-estate agent who's about to walk a buyer through a property. Output structured guidance — be specific, never generic.

BUYER: ${buyerLine}
PROPERTY: ${propertyLine}
${aiScoreText}
${matchReasonsText}
${buyerNotesText}
${alsoConsideredText}

MATCHUP:
${matchupText || "(no inferred criteria yet)"}

RECENT BUYER ACTIVITY: ${signalsText}
${input.predictedNextAction ? `PREDICTED NEXT ACTION: ${input.predictedNextAction}` : ""}
${input.predictedReadyToOffer ? "PREDICTED READY TO OFFER: yes" : ""}
${input.aiReasoning ? `AI READING: ${input.aiReasoning}` : ""}

Return STRICT JSON, no markdown fences:
{
  "summary": "2-sentence pitch the agent should keep in mind",
  "talkingPoints": ["4-6 specific things to say or do during the showing"],
  "objections": ["2-4 likely objections this buyer will raise"],
  "riskFlags": ["1-3 red flags to watch for"]
}

Each talking point must reference specific buyer signals or property features — no generic real-estate advice.`

  try {
    const result = await generateTextRouted({
      feature:     "showing_brief",
      brokerageId: input.brokerageId ?? undefined,
      system:      "You're a sharp, pragmatic real-estate sales coach. Output JSON only.",
      prompt,
      temperature: 0.4,
    })
    const cleaned = result.text.trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim()
    const parsed = JSON.parse(cleaned)
    return {
      summary:       typeof parsed.summary === "string" ? parsed.summary : null,
      talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints.filter((s: any) => typeof s === "string") : [],
      objections:    Array.isArray(parsed.objections) ? parsed.objections.filter((s: any) => typeof s === "string") : [],
      riskFlags:     Array.isArray(parsed.riskFlags) ? parsed.riskFlags.filter((s: any) => typeof s === "string") : [],
      modelUsed:     (result as any).modelId ?? null,
    }
  } catch {
    // Fall back to coaching content when AI fails — agent still gets something useful
    return {
      summary:       null,
      talkingPoints: input.coachTalking,
      objections:    input.coachObjects,
      riskFlags:     [],
      modelUsed:     null,
    }
  }
}

/**
 * Persists the briefing into showing_briefings, upserting on showing_id so
 * regenerate-button replacements stay clean.
 */
export async function persistShowingBriefing(brief: ShowingBriefing, brokerageId: string, agentId: string | null): Promise<{ id: string } | null> {
  const svc = createServiceClient()
  const row = {
    showing_id:        brief.showingId,
    brokerage_id:      brokerageId,
    agent_id:          agentId,
    buyer_snapshot:    brief.buyer as any,
    listing_snapshot:  brief.property as any,
    matchup:           brief.matchup as any,
    ai_summary:        brief.aiSummary,
    ai_talking_points: brief.aiTalkingPoints as any,
    ai_objections:     brief.aiObjections as any,
    ai_risk_flags:     brief.aiRiskFlags as any,
    recent_comps:      brief.recentComps as any,
    buyer_also_considered: brief.buyerAlsoConsidered as any,
    generated_at:      new Date().toISOString(),
    ai_model_used:     brief.modelUsed,
    updated_at:        new Date().toISOString(),
  }
  const { data, error } = await svc
    .from("showing_briefings")
    .upsert(row, { onConflict: "showing_id" })
    .select("id")
    .maybeSingle()
  if (error || !data) return null
  return { id: data.id }
}

/**
 * Cron-friendly: finds showings scheduled in next N hours that don't yet
 * have a briefing, builds one for each.
 */
export async function generateShowingBriefingsCronTick(opts?: { lookaheadHours?: number; limit?: number }): Promise<{ processed: number; generated: number }> {
  const lookahead = opts?.lookaheadHours ?? 24
  const limit = opts?.limit ?? 30

  const svc = createServiceClient()
  const fromIso = new Date().toISOString()
  const toIso = new Date(Date.now() + lookahead * 3_600_000).toISOString()

  // Pull upcoming showings with no briefing yet. We use a left-join via
  // two separate queries because Supabase's PostgREST left-join can be
  // fussy on UPSERT-managed tables.
  const { data: upcoming } = await svc
    .from("showings")
    .select("id, agent_id, brokerage_id, scheduled_at")
    .gte("scheduled_at", fromIso)
    .lt("scheduled_at", toIso)
    .not("status", "in", "(cancelled,canceled,no_show)")
    .order("scheduled_at", { ascending: true })
    .limit(limit)

  const ids = (upcoming ?? []).map((s: { id: string }) => s.id)
  if (ids.length === 0) return { processed: 0, generated: 0 }

  const { data: existing } = await svc
    .from("showing_briefings")
    .select("showing_id")
    .in("showing_id", ids)
  const alreadyBriefed = new Set((existing ?? []).map((b: { showing_id: string }) => b.showing_id))

  let generated = 0
  for (const s of (upcoming ?? []) as Array<{ id: string; agent_id: string | null; brokerage_id: string | null }>) {
    if (alreadyBriefed.has(s.id)) continue
    if (!s.brokerage_id) continue
    try {
      const brief = await buildShowingBriefing(s.id)
      if (!brief) continue
      const persisted = await persistShowingBriefing(brief, s.brokerage_id, s.agent_id)
      if (persisted) generated++
    } catch (err) {
      console.error("[showing-prep] Failed to generate brief for showing", s.id, err)
    }
  }

  return { processed: ids.length, generated }
}
