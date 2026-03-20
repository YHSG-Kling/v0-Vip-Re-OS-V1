"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { createClient }        from "@/lib/supabase/server"
import { emitLifecycleTransition } from "@/lib/buyer-lifecycle/lifecycle-logger"
import { KernelEvent }         from "@/lib/kernel/events"

// ─── startOfferDraft ─────────────────────────────────────────────────────────
// Emits lifecycle_event for buyer.offer.draft_started on page mount.
// Called by /offers/new/page.tsx RSC before rendering the initiation flow.
export async function startOfferDraft(params: {
  contactId:   string
  brokerageId: string
  agentUserId: string
  listingId?:  string | null
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, brokerageId, agentUserId, listingId } = params
  const supabase = createServiceClient()

  const { error } = await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "buyer_lifecycle",
    entity_id:     contactId,
    event_type:    KernelEvent.BUYER_OFFER_DRAFT_STARTED,
    actor_user_id: agentUserId,
    metadata:      { listing_id: listingId ?? null },
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─── RESOLVE CONNECTED E-SIGN PROVIDER ────────────────────────────────────────
// Reads the active e-sign platform credential for the brokerage from
// platform_credentials. Returns null if none is connected — callers must block
// the "Send for Signatures" action and prompt the user to connect in Settings.
export async function getConnectedEsignProvider(brokerageId: string): Promise<{
  platform:     string
  accountName:  string | null
} | null> {
  if (!isValidUUID(brokerageId)) return null
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("platform_credentials")
    .select("platform, account_name")
    .eq("brokerage_id", brokerageId)
    .in("platform", ["dotloop", "docusign", "skyslope", "authentisign"])
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return { platform: data.platform, accountName: data.account_name ?? null }
}

  strategy_type:      "standard" | "aggressive" | "conservative"
  ai_narrative:       string
  success_probability: number
  risk_factors:       string[]
  comparable_context: string
  template_id:        string | null
  created_at:         string
  status:             string
}

export interface OfferFormData {
  property_address:            string
  property_city?:              string
  property_state?:             string
  property_zip?:               string
  listing_id?:                 string | null
  property_address_ai_filled?: boolean
  offer_price:                 number
  earnest_money:               number
  earnest_money_amount:        number
  down_payment_amount?:        number
  down_payment_percent?:       number
  financing_type:              string
  financing_contingency:       boolean
  financing_contingency_days:  number
  inspection_contingency:      boolean
  inspection_period_days:      number
  appraisal_contingency:       boolean
  appraisal_contingency_days:  number
  closing_date:                string
  possession_terms:            string
  closing_cost_contribution?:  number
  escalation_clause:           boolean
  escalation_cap?:             number
  seller_concessions?:         number
  buyer_notes?:                string
  special_conditions?:         string
  form_source:                 string
  form_provider_ref?:          string
  esign_provider?:             string
  strategy_recommendation_id?: string | null
}

// ─── LISTING SEARCH ───────────────────────────────────────────────────────────

export async function searchListingsByAddress(
  query: string,
  brokerageId: string
): Promise<{ id: string; address: string; city: string; state: string; zip: string; list_price: number }[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("listings")
    .select("id, address, city, state, zip, list_price")
    .eq("brokerage_id", brokerageId)
    .ilike("address", `%${query}%`)
    .is("deleted_at", null)
    .limit(5)

  if (error) return []
  return data ?? []
}

// ─── FORM SOURCE RESOLUTION ───────────────────────────────────────────────────

export async function resolveFormSource(buyerId: string, brokerageId: string): Promise<{
  source: "uploaded_doc" | "platform" | "in_app"
  label: string
  documentName?: string
  providerName?: string
  providerRef?: string
}> {
  const supabase = createServiceClient()

  // 1. Check for uploaded offer form
  const { data: doc } = await supabase
    .from("client_documents")
    .select("id, document_name")
    .eq("contact_id", buyerId)
    .eq("doc_category", "offer_form")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  if (doc) {
    return {
      source: "uploaded_doc",
      label: `Using uploaded form: ${doc.document_name}`,
      documentName: doc.document_name,
      providerRef: doc.id,
    }
  }

  // 2. Check for active esign platform credential
  const { data: cred } = await supabase
    .from("platform_credentials")
    .select("id, platform, account_name")
    .eq("brokerage_id", brokerageId)
    .in("platform", ["dotloop", "docusign", "skyslope", "authentisign"])
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  if (cred) {
    const label = cred.account_name
      ? `${cred.platform} — ${cred.account_name}`
      : cred.platform
    return {
      source: "platform",
      label: `Pulling form from ${label}`,
      providerName: cred.platform,
      providerRef: "provider_pull",
    }
  }

  // 3. Fallback — in-app form
  return {
    source: "in_app",
    label: "No form found — you'll complete all fields manually",
  }
}

// ─── STRATEGY RECOMMENDATION ─────────────────────────────────────────────────

export async function getOrGenerateStrategyRecommendation(
  contactId: string,
  listingId: string | null,
  brokerageId: string,
  agentUserId: string
): Promise<{ success: boolean; recommendation?: StrategyRecommendation; error?: string }> {
  const supabase = createServiceClient()

  // Check for recent recommendation (< 24h)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: existing } = await supabase
    .from("strategy_recommendations")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .eq("status", "pending")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  if (existing) {
    const ai = existing.ai_analysis as Record<string, any>
    return {
      success: true,
      recommendation: {
        id: existing.id,
        recommended_price: existing.recommended_price,
        recommended_earnest: existing.recommended_earnest,
        recommended_contingencies: existing.recommended_contingencies as any,
        strategy_type: ai?.strategy_type ?? "standard",
        ai_narrative: existing.ai_narrative ?? "",
        success_probability: Number(existing.success_probability ?? 0.5),
        risk_factors: existing.risk_factors ?? [],
        comparable_context: existing.comparable_context ?? "",
        template_id: existing.template_id,
        created_at: existing.created_at,
        status: existing.status,
      },
    }
  }

  // Build context
  const [contactRes, listingRes, comparablesRes, templatesRes] = await Promise.all([
    supabase.from("contacts").select("*").eq("id", contactId).single(),
    listingId
      ? supabase.from("listings").select("*").eq("id", listingId).single()
      : Promise.resolve({ data: null }),
    supabase
      .from("offers")
      .select("offer_price, status, created_at, property_address")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("offer_strategy_templates")
      .select("*")
      .eq("is_active", true)
      .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`),
  ])

  const contact    = contactRes.data
  const listing    = listingRes.data
  const comparables = comparablesRes.data ?? []
  const templates  = templatesRes.data ?? []

  const dom = listing?.listing_date
    ? Math.floor((Date.now() - new Date(listing.listing_date).getTime()) / 86400000)
    : 0

  const comparableContext = comparables.length > 0
    ? `${comparables.length} recent offers in brokerage, avg price $${
        Math.round(comparables.reduce((s, o) => s + Number(o.offer_price ?? 0), 0) / comparables.length).toLocaleString()
      }`
    : "No comparable offer data available"

  const prompt = `Analyze this offer situation and recommend a strategy.
Property: $${listing?.list_price?.toLocaleString() ?? "unknown"}, ${dom} days on market, ${listing?.address ?? "external property"}
Buyer: ${contact?.contact_type ?? "buyer"}, pre-approved${contact ? " (on file)" : ""}
Market context: ${comparableContext}
Available templates: ${templates.map(t => t.strategy_type).join(", ") || "standard"}
Return ONLY valid JSON: { "recommended_price": number, "recommended_earnest": number, "recommended_contingencies": { "financing": bool, "financing_days": number, "inspection": bool, "inspection_days": number, "appraisal": bool, "appraisal_days": number }, "strategy_type": "standard"|"aggressive"|"conservative", "ai_narrative": string, "success_probability": number, "risk_factors": string[], "comparable_context": string }`

  let parsed: any
  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:      "claude-opus-4-5",
        max_tokens: 1024,
        messages:   [{ role: "user", content: prompt }],
      }),
    })
    const raw  = await aiRes.json()
    const text = raw?.content?.[0]?.text ?? ""
    const match = text.match(/\{[\s\S]*\}/)
    parsed = match ? JSON.parse(match[0]) : null
  } catch {
    parsed = null
  }

  if (!parsed) {
    const listPrice = Number(listing?.list_price ?? 0)
    parsed = {
      recommended_price:    listPrice > 0 ? Math.round(listPrice * 0.98) : 0,
      recommended_earnest:  listPrice > 0 ? Math.round(listPrice * 0.01) : 0,
      recommended_contingencies: {
        financing: true, financing_days: 21,
        inspection: true, inspection_days: 10,
        appraisal: true, appraisal_days: 21,
      },
      strategy_type:      "standard",
      ai_narrative:       "Standard offer strategy recommended based on current market conditions.",
      success_probability: 0.65,
      risk_factors:       ["Market competitiveness unknown"],
      comparable_context: comparableContext,
    }
  }

  // Match to template
  const matchedTemplate = templates.find(t => t.strategy_type === parsed.strategy_type) ?? null

  const { data: inserted, error: insertError } = await supabase
    .from("strategy_recommendations")
    .insert({
      brokerage_id:              brokerageId,
      contact_id:                contactId,
      listing_id:                listingId ?? null,
      agent_user_id:             agentUserId,
      template_id:               matchedTemplate?.id ?? null,
      recommended_price:         parsed.recommended_price,
      recommended_earnest:       parsed.recommended_earnest,
      recommended_contingencies: parsed.recommended_contingencies,
      ai_narrative:              parsed.ai_narrative,
      success_probability:       parsed.success_probability,
      risk_factors:              parsed.risk_factors,
      comparable_context:        parsed.comparable_context,
      ai_analysis:               { strategy_type: parsed.strategy_type },
      status:                    "pending",
    })
    .select()
    .single()

  if (insertError || !inserted) {
    return { success: false, error: insertError?.message ?? "Failed to save recommendation" }
  }

  return {
    success: true,
    recommendation: {
      id: inserted.id,
      recommended_price: inserted.recommended_price,
      recommended_earnest: inserted.recommended_earnest,
      recommended_contingencies: inserted.recommended_contingencies as any,
      strategy_type: parsed.strategy_type,
      ai_narrative: inserted.ai_narrative ?? "",
      success_probability: Number(inserted.success_probability ?? 0.5),
      risk_factors: inserted.risk_factors ?? [],
      comparable_context: inserted.comparable_context ?? "",
      template_id: inserted.template_id,
      created_at: inserted.created_at,
      status: inserted.status,
    },
  }
}

// ─── CREATE OFFER ─────────────────────────────────────────────────────────────

export async function createOffer(
  contactId: string,
  brokerageId: string,
  agentUserId: string,
  form: OfferFormData
): Promise<{ success: boolean; offerId?: string; error?: string }> {
  const serverClient = await createClient()
  const { data: { user } } = await serverClient.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }

  const supabase = createServiceClient()

  // Resolve listing_id — required by NOT NULL constraint on offers.listing_id
  let resolvedListingId = form.listing_id
  if (!resolvedListingId) {
    // Create a synthetic listing row for external properties
    const { data: syntheticListing, error: lErr } = await supabase
      .from("listings")
      .insert({
        address:       form.property_address,
        city:          form.property_city ?? "",
        state:         form.property_state ?? "",
        zip:           form.property_zip ?? "",
        brokerage_id:  brokerageId,
        agent_id:      agentUserId,
        list_price:    form.offer_price,
        status:        "external",
        lifecycle_stage: "LEAD",
      })
      .select("id")
      .single()

    if (lErr || !syntheticListing) {
      return { success: false, error: "Could not resolve listing for offer" }
    }
    resolvedListingId = syntheticListing.id
  }

  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .insert({
      contact_id:                  contactId,
      brokerage_id:                brokerageId,
      agent_id:                    agentUserId,
      listing_id:                  resolvedListingId,
      property_address:            form.property_address,
      property_address_ai_filled:  form.property_address_ai_filled ?? false,
      offer_price:                 form.offer_price,
      earnest_money:               form.earnest_money,
      earnest_money_amount:        form.earnest_money_amount,
      down_payment_amount:         form.down_payment_amount ?? null,
      down_payment_percent:        form.down_payment_percent ?? null,
      financing_type:              form.financing_type,
      financing_contingency_days:  form.financing_contingency ? form.financing_contingency_days : null,
      inspection_period_days:      form.inspection_contingency ? form.inspection_period_days : null,
      appraisal_contingency_days:  form.appraisal_contingency ? form.appraisal_contingency_days : null,
      contingencies:               [
        ...(form.financing_contingency  ? ["financing"]  : []),
        ...(form.inspection_contingency ? ["inspection"] : []),
        ...(form.appraisal_contingency  ? ["appraisal"]  : []),
      ],
      closing_date:                form.closing_date || null,
      possession_terms:            form.possession_terms,
      closing_cost_contribution:   form.closing_cost_contribution ?? null,
      escalation_clause:           form.escalation_clause,
      escalation_cap:              form.escalation_cap ?? null,
      buyer_notes:                 form.buyer_notes ?? null,
      form_source:                 form.form_source,
      form_provider_ref:           form.form_provider_ref ?? null,
      esign_provider:              form.esign_provider ?? null,
      esign_status:                "pending",
      strategy_recommendation_id:  form.strategy_recommendation_id ?? null,
      status:                      "draft",
      offer_type:                  "standard",
      current_round:               1,
    })
    .select("id")
    .single()

  if (offerError || !offer) {
    return { success: false, error: offerError?.message ?? "Failed to create offer" }
  }

  // Accept the recommendation
  if (form.strategy_recommendation_id) {
    await supabase
      .from("strategy_recommendations")
      .update({ status: "accepted", offer_id: offer.id })
      .eq("id", form.strategy_recommendation_id)
  }

  // Emit lifecycle event if stage < BUYER_OFFER_SUBMITTED
  const { data: contact } = await supabase
    .from("contacts")
    .select("buyer_stage")
    .eq("id", contactId)
    .single()

  const OFFER_SUBMITTED_STAGES = [
    "BUYER_OFFER_SUBMITTED", "BUYER_UNDER_CONTRACT", "BUYER_CLOSED", "BUYER_LIFETIME",
  ]
  const currentStage = contact?.buyer_stage ?? "BUYER_OFFER_ELIGIBLE"

  if (!OFFER_SUBMITTED_STAGES.includes(currentStage)) {
    await emitLifecycleTransition({
      contactId,
      brokerageId,
      fromState:     currentStage as any,
      toState:       "BUYER_OFFER_SUBMITTED",
      triggeredBy:   "agent",
      authorityRole: "agent",
      userId:        agentUserId,
      sourceSystem:  "offer_builder",
      metadata:      { offer_id: offer.id },
    })
  }

  // lifecycle_events insert
  await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "buyer_lifecycle",
    entity_id:     contactId,
    event_type:    "offer.created",
    actor_user_id: agentUserId,
    metadata:      { offer_id: offer.id, property_address: form.property_address },
  })

  return { success: true, offerId: offer.id }
}

// ─── SEND FOR ESIGN ───────────────────────────────────────────────────────────

export async function sendOfferForESign(
  offerId: string,
  contactId: string,
  brokerageId: string,
  agentUserId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from("offers")
    .update({ esign_status: "sent", esign_sent_at: new Date().toISOString() })
    .eq("id", offerId)
    .eq("brokerage_id", brokerageId)

  if (error) return { success: false, error: error.message }

  // Notification to buyer
  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name")
    .eq("id", contactId)
    .single()

  const name = contact ? `${contact.first_name} ${contact.last_name}` : "Buyer"

  await supabase.from("notifications").insert({
    brokerage_id: brokerageId,
    user_id:      agentUserId,
    type:         "offer.esign_sent",
    title:        "Offer sent for signature",
    body:         `Offer sent to ${name} for signature`,
    entity_type:  "offer",
    entity_id:    offerId,
    priority:     "high",
    channel:      "in_app",
  })

  return { success: true }
}

// ─── GET OFFERS ───────────────────────────────────────────────────────────────

export async function getBuyerOffers(
  contactId: string,
  brokerageId: string
): Promise<{ success: boolean; offers?: any[]; error?: string }> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("offers")
    .select(`
      id, property_address, offer_price, status, esign_status,
      esign_sent_at, form_source, esign_provider, strategy_recommendation_id,
      created_at, submitted_at, closing_date, financing_type,
      earnest_money, contingencies, buyer_notes
    `)
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, offers: data ?? [] }
}

// ─── RECORD OUTCOME ───────────────────────────────────────────────────────────

export async function recordOfferOutcome(
  offerId: string,
  recommendationId: string | null,
  contactId: string,
  brokerageId: string,
  agentUserId: string,
  outcome: "accepted" | "rejected" | "countered" | "withdrawn",
  finalPrice: number | null,
  notes: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  // Update offer status
  const statusMap = {
    accepted:  "accepted",
    rejected:  "rejected",
    countered: "countered",
    withdrawn: "submitted",
  }
  await supabase
    .from("offers")
    .update({ status: statusMap[outcome], updated_at: new Date().toISOString() })
    .eq("id", offerId)

  // Insert strategy outcome if there's a recommendation
  if (recommendationId) {
    const { data: rec } = await supabase
      .from("strategy_recommendations")
      .select("recommended_price")
      .eq("id", recommendationId)
      .single()

    const deviation = rec && finalPrice
      ? Math.abs(finalPrice - Number(rec.recommended_price))
      : null

    await supabase.from("strategy_outcomes").insert({
      brokerage_id:               brokerageId,
      recommendation_id:          recommendationId,
      offer_id:                   offerId,
      outcome,
      final_price:                finalPrice ?? null,
      deviation_from_recommendation: deviation,
      notes,
    })
  }

  // Lifecycle transition
  if (outcome === "accepted") {
    await emitLifecycleTransition({
      contactId,
      brokerageId,
      fromState:     "BUYER_OFFER_SUBMITTED",
      toState:       "BUYER_UNDER_CONTRACT",
      triggeredBy:   "agent",
      authorityRole: "agent",
      userId:        agentUserId,
      sourceSystem:  "offer_builder",
      metadata:      { offer_id: offerId, outcome },
    })
  } else if (outcome === "rejected") {
    await emitLifecycleTransition({
      contactId,
      brokerageId,
      fromState:     "BUYER_OFFER_SUBMITTED",
      toState:       "BUYER_OFFER_ELIGIBLE",
      triggeredBy:   "agent",
      authorityRole: "agent",
      userId:        agentUserId,
      sourceSystem:  "offer_builder",
      metadata:      { offer_id: offerId, outcome },
    })
  }

  return { success: true }
}
