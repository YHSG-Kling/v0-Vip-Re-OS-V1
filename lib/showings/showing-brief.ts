/**
 * lib/showings/showing-brief.ts
 *
 * Builds a per-showing 1-pager the agent reads before walking the buyer
 * into a property. Pure-function compositor over data the platform
 * already captures — no new ingest, no new scraping.
 *
 * Pull order (each step is best-effort; missing data degrades gracefully):
 *   1. showing  → listing_id + contact_id + scheduled_at + access_method
 *   2. listing  → property facts
 *   3. contact  → name, contact_type, budget_min/max, timeline
 *   4. property_preferences → AI-inferred criteria (price range, beds, etc)
 *   5. buyer_financial_profiles → pre-approval amount, cash buyer flag
 *   6. buyer_behavior_predictions → ready-to-offer, predicted next action
 *   7. recent buyer_behavior_log (14d) → "they viewed 12 similar in 3 days"
 *   8. buyer_stage_coaching → suggested talking points + objections
 *   9. recent comp listings within ZIP for context
 *
 * Then computeMatchup() pairs each criterion against the listing and
 * generateAiSummary() asks the AI for 4-6 specific talking points tied
 * to THIS buyer's signals (not generic real-estate advice).
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"

export interface MatchupRow {
  criterion:   string
  buyerWants:  string
  listingHas:  string
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

  listing: {
    listingId:         string | null
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
  }

  matchup:           MatchupRow[]
  recentSignals:     string[]
  predictedNextAction: string | null
  recentComps: Array<{
    address:    string
    listPrice:  number | null
    bedrooms:   number | null
    bathrooms:  number | null
    sqft:       number | null
    status:     string | null
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

  // 1. Showing core
  const { data: showing } = await svc
    .from("showings")
    .select("id, listing_id, contact_id, agent_id, scheduled_at, duration_minutes, access_method, access_code, access_instructions, brokerage_id, external_address")
    .eq("id", showingId)
    .maybeSingle()
  if (!showing) return null

  // 2-9 in parallel
  const [
    { data: listing },
    { data: contact },
    { data: pref },
    { data: finance },
    { data: prediction },
    { data: behavior },
    { data: coaching },
    { data: comps },
  ] = await Promise.all([
    showing.listing_id
      ? svc.from("listings").select("id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, mls_number, status").eq("id", showing.listing_id).maybeSingle()
      : Promise.resolve({ data: null }),
    showing.contact_id
      ? svc.from("contacts").select("id, first_name, last_name, contact_type, budget_min, budget_max, timeline, notes, email, phone").eq("id", showing.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    showing.contact_id
      ? svc.from("property_preferences").select("preferred_price_min, preferred_price_max, inferred_min_price, inferred_max_price, inferred_beds_min, inferred_baths_min, inferred_cities, inferred_zip_codes, inferred_property_types, inferred_must_have_features, inferred_deal_breakers, confidence_score").eq("contact_id", showing.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    showing.contact_id
      ? svc.from("buyer_financial_profiles").select("pre_approval_amount, pre_approval_lender, finance_type, is_cash_buyer, down_payment_amount, estimated_monthly_budget").eq("contact_id", showing.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    showing.contact_id
      ? svc.from("buyer_behavior_predictions").select("predicted_next_action, predicted_ready_to_offer, predicted_price_max, predicted_timeline_days, engagement_score, ai_reasoning").eq("contact_id", showing.contact_id).order("generated_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
    showing.contact_id
      ? svc.from("buyer_behavior_log").select("signal_type, signal_value, property_address, bedrooms, bathrooms, list_price, created_at").eq("contact_id", showing.contact_id).gte("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(30)
      : Promise.resolve({ data: [] }),
    showing.contact_id
      ? svc.from("buyer_stage_coaching").select("buyer_stage, suggested_talking_points, common_objections, success_signals, risk_signals").eq("is_active", true).limit(5)
      : Promise.resolve({ data: [] }),
    (async (): Promise<{ data: Array<{ address: string; list_price: number | null; bedrooms: number | null; bathrooms: number | null; sqft: number | null; status: string | null }> }> => {
      // Recent comps in the same ZIP within last 90 days
      if (!showing.listing_id) return { data: [] }
      const { data: l } = await svc.from("listings").select("zip").eq("id", showing.listing_id).maybeSingle()
      if (!l?.zip) return { data: [] }
      const { data } = await svc
        .from("listings")
        .select("address, list_price, bedrooms, bathrooms, sqft, status")
        .eq("zip", l.zip)
        .neq("id", showing.listing_id)
        .in("status", ["sold", "pending", "active"])
        .order("list_price", { ascending: false })
        .limit(5)
      return { data: (data ?? []) as any }
    })(),
  ])

  // Build buyer snapshot
  const fullName = contact
    ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Buyer"
    : "Buyer"

  const buyer = {
    contactId:         contact?.id ?? null,
    fullName,
    timeline:          contact?.timeline ?? null,
    budgetMin:         contact?.budget_min ?? pref?.preferred_price_min ?? pref?.inferred_min_price ?? null,
    budgetMax:         contact?.budget_max ?? pref?.preferred_price_max ?? pref?.inferred_max_price ?? null,
    preApprovedAmount: finance?.pre_approval_amount ?? null,
    preApprovedLender: finance?.pre_approval_lender ?? null,
    isCashBuyer:       finance?.is_cash_buyer === true,
    contactType:       contact?.contact_type ?? null,
    notes:             contact?.notes ?? null,
  }

  // Listing snapshot (use external_address fallback for non-IDX listings)
  const listingView = {
    listingId:  listing?.id ?? null,
    address:    listing?.address ?? showing.external_address ?? null,
    city:       listing?.city ?? null,
    state:      listing?.state ?? null,
    zip:        listing?.zip ?? null,
    listPrice:  listing?.list_price ?? null,
    bedrooms:   listing?.bedrooms ?? null,
    bathrooms:  listing?.bathrooms ?? null,
    sqft:       listing?.sqft ?? null,
    mlsNumber:  listing?.mls_number ?? null,
    status:     listing?.status ?? null,
  }

  // Build matchup grid — each row compares one buyer criterion vs the listing
  const matchup: MatchupRow[] = []

  // Price
  if (buyer.budgetMax || buyer.preApprovedAmount) {
    const budget = buyer.preApprovedAmount ?? buyer.budgetMax ?? null
    if (budget && listingView.listPrice) {
      const fitsBudget = listingView.listPrice <= budget * 1.05
      const stretches  = listingView.listPrice > budget && listingView.listPrice <= budget * 1.05
      matchup.push({
        criterion:  "Budget",
        buyerWants: dollars(budget),
        listingHas: dollars(listingView.listPrice),
        match:      fitsBudget ? (stretches ? "partial" : "yes") : "no",
      })
    }
  }

  // Beds
  const wantBedsMin = pref?.inferred_beds_min ?? null
  if (wantBedsMin && listingView.bedrooms != null) {
    matchup.push({
      criterion:  "Bedrooms",
      buyerWants: `≥ ${wantBedsMin}`,
      listingHas: `${listingView.bedrooms}`,
      match:      listingView.bedrooms >= wantBedsMin ? "yes" : "no",
    })
  }

  // Baths
  const wantBathsMin = pref?.inferred_baths_min ?? null
  if (wantBathsMin && listingView.bathrooms != null) {
    matchup.push({
      criterion:  "Bathrooms",
      buyerWants: `≥ ${wantBathsMin}`,
      listingHas: `${listingView.bathrooms}`,
      match:      listingView.bathrooms >= wantBathsMin ? "yes" : "no",
    })
  }

  // Cities / ZIPs
  const inferredCities = (pref?.inferred_cities ?? []) as string[]
  const inferredZips   = (pref?.inferred_zip_codes ?? []) as string[]
  if (inferredCities.length && listingView.city) {
    const m = inferredCities.some(c => c.toLowerCase() === listingView.city!.toLowerCase())
    matchup.push({
      criterion:  "Location",
      buyerWants: inferredCities.slice(0, 3).join(", "),
      listingHas: listingView.city,
      match:      m ? "yes" : "partial",
    })
  } else if (inferredZips.length && listingView.zip) {
    const m = inferredZips.includes(listingView.zip)
    matchup.push({
      criterion:  "ZIP",
      buyerWants: inferredZips.slice(0, 3).join(", "),
      listingHas: listingView.zip,
      match:      m ? "yes" : "partial",
    })
  }

  // Must-haves
  const mustHaves = (pref?.inferred_must_have_features ?? []) as string[]
  if (mustHaves.length) {
    matchup.push({
      criterion:  "Must-haves",
      buyerWants: mustHaves.slice(0, 4).join(", "),
      listingHas: "(check on tour)",
      match:      "unknown",
    })
  }

  // Deal-breakers
  const dealBreakers = (pref?.inferred_deal_breakers ?? []) as string[]
  if (dealBreakers.length) {
    matchup.push({
      criterion:  "Deal-breakers",
      buyerWants: `Avoid: ${dealBreakers.slice(0, 3).join(", ")}`,
      listingHas: "(check on tour)",
      match:      "unknown",
    })
  }

  // Recent buyer signals — humanised one-liners
  const signals: string[] = []
  const beh = (behavior ?? []) as any[]
  const last14 = beh.length
  if (last14 > 0) {
    signals.push(`${last14} signal${last14 === 1 ? "" : "s"} in last 14 days`)
  }
  const viewCount = beh.filter(b => b.signal_type === "view").length
  if (viewCount > 0) signals.push(`Viewed ${viewCount} listings`)
  const saveCount = beh.filter(b => b.signal_type === "save" || b.signal_type === "favorite").length
  if (saveCount > 0) signals.push(`Saved ${saveCount}`)
  const recentPrices = beh.map(b => b.list_price).filter((p): p is number => typeof p === "number")
  if (recentPrices.length > 2) {
    const avg = Math.round(recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length)
    signals.push(`Recent viewing avg ${dollars(avg)}`)
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

  const compsView = (comps ?? []).map((c: any) => ({
    address:   c.address,
    listPrice: c.list_price ?? null,
    bedrooms:  c.bedrooms ?? null,
    bathrooms: c.bathrooms ?? null,
    sqft:      c.sqft ?? null,
    status:    c.status ?? null,
  }))

  // AI: 4-6 specific talking points tied to THIS buyer and THIS listing
  const aiResult = await generateBriefAI({
    buyer, listing: listingView, matchup, signals, coachTalking, coachObjects,
    predictedNextAction, predictedReadyToOffer: prediction?.predicted_ready_to_offer === true,
    aiReasoning: prediction?.ai_reasoning ?? null,
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
    listing:             listingView,
    matchup,
    recentSignals:       signals,
    predictedNextAction,
    recentComps:         compsView,
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
  listing:               ShowingBriefing["listing"]
  matchup:               MatchupRow[]
  signals:               string[]
  coachTalking:          string[]
  coachObjects:          string[]
  predictedNextAction:   string | null
  predictedReadyToOffer: boolean
  aiReasoning:           string | null
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
    input.listing.address,
    input.listing.listPrice ? dollars(input.listing.listPrice) : null,
    input.listing.bedrooms != null ? `${input.listing.bedrooms} bd` : null,
    input.listing.bathrooms != null ? `${input.listing.bathrooms} ba` : null,
    input.listing.sqft ? `${input.listing.sqft} sqft` : null,
  ].filter(Boolean).join(" · ")

  const buyerLine = [
    input.buyer.fullName,
    input.buyer.timeline ? `Timeline: ${input.buyer.timeline}` : null,
    input.buyer.preApprovedAmount ? `Pre-approved ${dollars(input.buyer.preApprovedAmount)}` : input.buyer.budgetMax ? `Budget up to ${dollars(input.buyer.budgetMax)}` : null,
    input.buyer.isCashBuyer ? "Cash buyer" : null,
  ].filter(Boolean).join(" · ")

  const matchupText = input.matchup.map((m) => `- ${m.criterion}: wants ${m.buyerWants}, listing has ${m.listingHas} → ${m.match}`).join("\n")
  const signalsText = input.signals.length ? input.signals.join(" · ") : "(no recent signals)"

  const prompt = `You are coaching a real-estate agent who's about to walk a buyer through a property. Output structured guidance — be specific, never generic.

BUYER: ${buyerLine}
PROPERTY: ${propertyLine}

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
    listing_snapshot:  brief.listing as any,
    matchup:           brief.matchup as any,
    ai_summary:        brief.aiSummary,
    ai_talking_points: brief.aiTalkingPoints as any,
    ai_objections:     brief.aiObjections as any,
    ai_risk_flags:     brief.aiRiskFlags as any,
    recent_comps:      brief.recentComps as any,
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
