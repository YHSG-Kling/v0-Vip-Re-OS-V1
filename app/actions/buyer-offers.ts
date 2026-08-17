"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { createClient }        from "@/lib/supabase/server"
import { emitLifecycleTransition } from "@/lib/buyer-lifecycle/lifecycle-logger"
import { gatewayChat } from "@/lib/ai/gateway-chat"
import { KernelEvent }         from "@/lib/kernel/events"
import { isValidUUID }         from "@/lib/validations"
import { OFFER_EVENT }         from "@/lib/buyer-offer/offer-lifecycle"
import { resolveAgentId }      from "@/lib/kernel/agent-identity"
import { requireContactAccess } from "@/lib/portal/require-contact-access"
// The LIMIT gate — "how many offers does this buyer already have PENDING?".
// It and the ELIGIBILITY gate below were `canBuyerSubmitOffer` and
// `canBuyerSubmitOffers`: one letter apart, two different questions, so this
// call site imported the singular under an alias to stay readable. The exports
// were renamed (wave 14, C4) and each name now states its own question, so the
// alias is gone.
import {
  checkDuplicateOffer,
  checkPendingOfferLimit,
} from "@/app/actions/buyer-offer/handle-multi-offer"
// The ELIGIBILITY gate — the SAME function the three offer surfaces render from
// (/offers, /offers/new and the contact page), so the action and the UI cannot
// disagree about whether this buyer may be making offers at all.
import { checkBuyerOfferEligibility } from "@/app/actions/buyer-lifecycle-core"
import { MAX_PENDING_OFFERS } from "@/lib/offers/multi-offer-rules"

// ─── STAFF GATE ───────────────────────────────────────────────────────────────
// Several exports below are agent-only writes on a buyer's file — creating the
// offer, sending it for signature, recording its outcome. `requireContactAccess`
// deliberately also admits the CONTACT themselves (that is correct for portal
// READS like `getBuyerOffers`), so for those writers we need the stronger
// question: are you STAFF in the contact's brokerage?
//
// The tenant still comes from the contact row, never from the caller — the
// `brokerageId` parameters on these exports are retained and ignored per the
// house pattern so existing call sites keep type-checking.
//
// `users.role` is RETIRED (almost every live row is NULL); authority is read
// from `user_type`, which is what `requireContactAccess` hands back.
// SCOPE LADDER (staff roster): 'superadmin' removed — dead as users.user_type
// (0 live rows); broker_owner added — storable same-tenant seat that owns the brokerage.
const STAFF_USER_TYPES = ["agent", "team_lead", "tc", "admin", "broker", "broker_owner"]

async function requireStaffOnContact(contactId: string): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  if (!isValidUUID(contactId)) return { ok: false, error: "Invalid contact ID" }
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { ok: false, error: access.error }
  if (access.isContactSelf && !STAFF_USER_TYPES.includes(access.userType ?? "")) {
    // A buyer signed into their own portal is not authority to act as their agent.
    return { ok: false, error: "Forbidden" }
  }
  if (!STAFF_USER_TYPES.includes(access.userType ?? "")) {
    return { ok: false, error: "Forbidden" }
  }
  return { ok: true, userId: access.userId, brokerageId: access.brokerageId }
}

// Resolve the caller's OWN brokerage from their session. Used by the exports
// that are brokerage-scoped rather than contact-scoped (listing search, e-sign
// provider lookup) and that previously accepted the tenant as a parameter.
// Destructures `error` — supabase-js RESOLVES a refused query, and a gate that
// reads a refusal as "no brokerage" must fail CLOSED, which it does here.
async function requireCallerBrokerage(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (error) return { ok: false, error: "Could not verify the caller" }
  const brokerageId = (data?.brokerage_id ?? null) as string | null
  if (!brokerageId) return { ok: false, error: "Brokerage not configured" }
  return { ok: true, userId: user.id, brokerageId }
}

// Prove an offer belongs to the caller's brokerage. Returns the offer's
// contact_id so callers never have to trust a caller-supplied one.
async function requireOfferInCallerBrokerage(offerId: string): Promise<
  | { ok: true; userId: string; brokerageId: string; contactId: string | null }
  | { ok: false; error: string }
> {
  if (!isValidUUID(offerId)) return { ok: false, error: "Invalid offer ID" }
  const caller = await requireCallerBrokerage()
  if (!caller.ok) return caller
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("offers").select("brokerage_id, contact_id").eq("id", offerId).maybeSingle()
  if (error) return { ok: false, error: "Could not read the offer" }
  if (!data) return { ok: false, error: "Offer not found" }
  if (data.brokerage_id !== caller.brokerageId) return { ok: false, error: "Forbidden" }
  return {
    ok: true,
    userId: caller.userId,
    brokerageId: caller.brokerageId,
    contactId: (data.contact_id ?? null) as string | null,
  }
}

// ─── startOfferDraft ─────────────────────────────────────────────────────────
// Emits lifecycle_event for buyer.offer.draft_started on page mount.
// Called by /offers/new/page.tsx RSC before rendering the initiation flow.
//
// GATED. This is `"use server"` — a public endpoint — and it wrote to
// `lifecycle_events` on the service client with the brokerage, the entity AND the
// **actor** all supplied by the caller. Anyone could forge an audit row asserting
// that a named agent started an offer draft for a named contact in a named
// brokerage. `actor_user_id` is now the session's user, and `brokerage_id` comes
// from the contact row via the gate.
export async function startOfferDraft(params: {
  contactId:   string
  /** Ignored — resolved from the contact row. */
  brokerageId?: string
  /** Ignored — the actor is the session's user. */
  agentUserId?: string
  listingId?:  string | null
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, listingId } = params

  const gate = await requireStaffOnContact(contactId)
  if (!gate.ok) return { success: false, error: gate.error }

  const supabase = createServiceClient()

  const { error } = await supabase.from("lifecycle_events").insert({
    brokerage_id:  gate.brokerageId,
    entity_type:   "buyer_lifecycle",
    entity_id:     contactId,
    event_type:    KernelEvent.BUYER_OFFER_DRAFT_STARTED,
    actor_user_id: gate.userId,
    metadata:      { listing_id: listingId ?? null },
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─── RESOLVE CONNECTED E-SIGN PROVIDER ────────────────────────────────────────
// Reads the brokerage's active e-sign platform from platform_credentials.
// The contact (buyer/seller) has no provider relationship — providers are owned
// by the brokerage/team/agent and configured in Settings > Integrations.
// Returns null if no provider is connected — callers must gate the send action.
//
// GATED. This was unauthenticated and took the tenant as a parameter, so any
// caller could enumerate which e-sign vendor any brokerage on the platform has
// connected and under which account name — competitive intelligence about a
// rival's stack, from an open endpoint. The tenant is now the caller's own.
// `brokerageId` is retained and ignored (house pattern).
export async function getConnectedEsignProvider(_brokerageId?: string): Promise<{
  platform:    string
  accountName: string | null
} | null> {
  const caller = await requireCallerBrokerage()
  if (!caller.ok) return null
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("platform_credentials")
    .select("platform, account_name")
    .eq("brokerage_id", caller.brokerageId)
    .in("platform", ["dotloop", "docusign", "skyslope", "authentisign"])
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return { platform: data.platform, accountName: data.account_name ?? null }
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
  // In-app form selections (when form_source === "in_app")
  in_app_selected_form_ids?:   string[]
  in_app_form_field_values?:   Record<string, unknown>
}

// ─── LISTING SEARCH ───────────────────────────────────────────────────────────

// GATED. Unauthenticated cross-tenant listing search on the service client —
// the tenant to search was named by the caller, so any rival could type a street
// name and read another brokerage's inventory and asking prices. The tenant is
// now the caller's own; `brokerageId` is retained and ignored (house pattern).
export async function searchListingsByAddress(
  query: string,
  _brokerageId?: string
): Promise<{ id: string; address: string; city: string; state: string; zip: string; list_price: number }[]> {
  const caller = await requireCallerBrokerage()
  if (!caller.ok) return []
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("listings")
    .select("id, address, city, state, zip, list_price")
    .eq("brokerage_id", caller.brokerageId)
    .ilike("address", `%${query}%`)
    .is("deleted_at", null)
    .limit(5)

  if (error) return []
  return data ?? []
}

// ─── FORM SOURCE RESOLUTION ───────────────────────────────────────────────────

// GATED. Unauthenticated: it read another tenant's uploaded client documents
// (by name) and their connected e-sign account for any caller-named contact +
// brokerage pair. `brokerageId` retained and ignored — the tenant comes from the
// contact row.
export async function resolveFormSource(buyerId: string, _brokerageId?: string): Promise<{
  source: "uploaded_doc" | "platform" | "in_app"
  label: string
  documentName?: string
  providerName?: string
  providerRef?: string
}> {
  const gate = await requireStaffOnContact(buyerId)
  if (!gate.ok) {
    // Fail CLOSED to the manual path — never reveal what is on file.
    return { source: "in_app", label: "No form found — you'll complete all fields manually" }
  }
  const brokerageId = gate.brokerageId
  const supabase = createServiceClient()

  // 1. Check for uploaded offer form
  const { data: doc } = await supabase
    .from("client_documents")
    .select("id, document_name")
    .eq("contact_id", buyerId)
    .eq("brokerage_id", brokerageId)
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
// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface StrategyRecommendation {
  id?: string
  strategy?: string
  confidence?: number
  reasoning?: string
  suggestedPrice?: number
  competitivenessScore?: number
  escalationClause?: boolean
  daysToClose?: number
  contingencies?: string[]
  generatedAt?: string
  recommended_price?: number
  recommended_earnest?: number
  recommended_contingencies?: any
  strategy_type?: string
  ai_narrative?: string
  success_probability?: number
  risk_factors?: any[]
  comparable_context?: string
  template_id?: string | null
  created_at?: string
  status?: string
}
// GATED. Unauthenticated, and it burns a paid **Claude Opus** call per miss
// (`gatewayChat`, 1024 max tokens) while reading the named brokerage's last ten
// offer prices and its accumulated strategy-outcome history to build the prompt.
// So it was simultaneously an open AI-spend faucet billed to us and a read of a
// rival's pricing behaviour. It also INSERTED a `strategy_recommendations` row
// under a caller-named brokerage and agent.
//
// `brokerageId` / `agentUserId` are retained and ignored (house pattern) — the
// tenant comes from the contact row and the actor from the session.
export async function getOrGenerateStrategyRecommendation(
  contactId: string,
  listingId: string | null,
  _brokerageId?: string,
  _agentUserId?: string
): Promise<{ success: boolean; recommendation?: StrategyRecommendation; error?: string }> {
  const gate = await requireStaffOnContact(contactId)
  if (!gate.ok) return { success: false, error: gate.error }
  const brokerageId = gate.brokerageId
  const agentUserId = gate.userId

  // A listing id is only honoured when it belongs to the SAME tenant — otherwise
  // the prompt would be grounded in another brokerage's list price and DOM.
  let scopedListingId: string | null = null
  if (listingId && isValidUUID(listingId)) {
    const svc = createServiceClient()
    const { data: l, error: lErr } = await svc
      .from("listings").select("brokerage_id").eq("id", listingId).maybeSingle()
    if (!lErr && l?.brokerage_id === brokerageId) scopedListingId = listingId
  }
  listingId = scopedListingId

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

  // STRATEGY-LEARNING read side — ground the recommendation in what ACTUALLY won
  // (the outcome-closing loop's accumulated strategy_outcomes), not just priors.
  let outcomeContext = "No prior offer-strategy outcomes recorded yet — use standard priors."
  try {
    const { generateStrategyInsights } = await import("@/lib/strategy-learning/strategy-insights")
    outcomeContext = (await generateStrategyInsights({ brokerageId }, supabase)).promptContext
  } catch { /* best-effort — never block a recommendation */ }

  const prompt = `Analyze this offer situation and recommend a strategy.
Property: $${listing?.list_price?.toLocaleString() ?? "unknown"}, ${dom} days on market, ${listing?.address ?? "external property"}
Buyer: ${contact?.contact_type ?? "buyer"}, pre-approved${contact ? " (on file)" : ""}
Market context: ${comparableContext}
What's winning in this brokerage: ${outcomeContext}
Available templates: ${templates.map(t => t.strategy_type).join(", ") || "standard"}
Return ONLY valid JSON: { "recommended_price": number, "recommended_earnest": number, "recommended_contingencies": { "financing": bool, "financing_days": number, "inspection": bool, "inspection_days": number, "appraisal": bool, "appraisal_days": number }, "strategy_type": "standard"|"aggressive"|"conservative", "ai_narrative": string, "success_probability": number, "risk_factors": string[], "comparable_context": string }`

  let parsed: any
  try {
    const aiRes = await gatewayChat({
      model: "anthropic/claude-opus-4-5",
      maxTokens: 1024,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    })
    const text = aiRes.content ?? ""
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

/**
 * WHAT TO DO ABOUT IT — one remedy per blocker the LIFECYCLE gate can raise.
 *
 * Keyed on the blocker vocabulary of
 * lib/buyer-lifecycle/gating-helpers.ts:isOfferAllowed, which is the only thing
 * that produces these strings. A refusal that names the rule and withholds the
 * remedy is the dead end this sequence of waves keeps removing, so the gate's
 * own `reason` is returned WITH the way out rather than instead of it.
 *
 * A non-exported const in a `"use server"` file is fine — the build rule is that
 * a "use server" file may only EXPORT async functions.
 */
const OFFER_LIFECYCLE_GATE_REMEDY: Record<string, string> = {
  no_buyer_state:
    "This buyer has no recorded lifecycle state at all, so nothing can vouch for where they are in the journey. Take them through intake on the contact's Buyer tab (that records the first transition) and verify their finances, then create the offer.",
  lifecycle_gate_not_enabled:
    "The offer_creation gate opens at BUYER_OFFER_ELIGIBLE. Advance the buyer to that stage on the contact's Buyer tab — normally after a tour — and the offer can be created.",
  financial_verification_required:
    "Verify the buyer's finances on the contact's Financial Verification panel (proof of funds for a cash buyer, pre-approval for a financed one). If the deal cannot wait, an admin, a broker, or THIS buyer's agent of record can lift the financing gate with a written justification, which is recorded as the override and lifts this refusal with it.",
}

/**
 * The catch-all, used when the gate raises a blocker this map has not been
 * taught. It still points somewhere real rather than leaving a dead end.
 */
const OFFER_LIFECYCLE_GATE_DEFAULT_REMEDY =
  "Open the buyer's Buyer tab on the contact record — the gate panel there names which requirement is outstanding and who can clear it."

// AUTHENTICATED → now also AUTHORIZED. The previous version proved a session
// existed and then ignored it: `contactId`, `brokerageId` and `agentUserId` all
// came from the caller and none was checked against that session. Any signed-in
// user — including a buyer holding only a portal login — could create a binding
// offer on another brokerage's contact, stamped with another agent's identity.
// The financial-verification gate below was likewise being asked about a
// caller-named (contact, brokerage) pair, so naming a brokerage where the
// contact had a verified profile satisfied it for a contact who did not.
//
// `brokerageId` / `agentUserId` are retained and ignored (house pattern).
export async function createOffer(
  contactId: string,
  _brokerageId: string | undefined,
  _agentUserId: string | undefined,
  form: OfferFormData
): Promise<{ success: boolean; offerId?: string; error?: string }> {
  const gate = await requireStaffOnContact(contactId)
  if (!gate.ok) return { success: false, error: gate.error }
  const brokerageId = gate.brokerageId
  const agentUserId = gate.userId

  const supabase = createServiceClient()

  // offers.agent_id / listings.agent_id are FKs to agents.id (NOT users.id).
  // agentUserId is the session user id — resolve it to the agents.id. Null is
  // acceptable (e.g. broker/admin without an agent profile); never fall back to
  // the user id, which would write a wrong/invalid FK value.
  const agentId = await resolveAgentId(supabase, agentUserId)

  // ── GATE 1 of 2: THE LIFECYCLE ELIGIBILITY GATE ────────────────────────────
  //
  // "MAY THIS BUYER BE MAKING OFFERS AT ALL?" — buyer-lifecycle-core.ts
  // :checkBuyerOfferEligibility → lib/buyer-lifecycle/gating-helpers.ts:isOfferAllowed:
  // is their lifecycle state at or past BUYER_OFFER_ELIGIBLE, and are they
  // financially verified.
  //
  // THIS IS WHERE IT HAD TO BIND. Three surfaces call this gate to decide what to
  // RENDER — /offers, /offers/new (which redirects away on a refusal) and the
  // contact page — and the server action that WRITES the offer row consulted
  // nothing. A gate the UI enforces is a suggestion: this export is directly
  // invocable, and every path that is not the wizard (a stale tab, the upload
  // route, an agent-assistant tool call) went straight past it.
  //
  // BINDING IT HERE CANNOT LOCK THE WIZARD OUT: /offers/new already hard-refuses
  // the same call before it renders, so any buyer who reaches the wizard has
  // already passed exactly this gate. What changes is only that the paths which
  // never asked now have to.
  //
  // THE OVERRIDE IS ALREADY SETTLED, AND NO SECOND ONE IS INVENTED HERE. The
  // owner's ruling — "admin or agent can override the financing gate" — is
  // expressed as RECORDED STATE, not as a flag on the call:
  // lib/buyer-execution/multi-party-updates.ts:adminOverrideFinancialGate checks
  // authority (admin/broker brokerage-wide, or the agent OF RECORD on this
  // contact) and then writes a financial-verification event, which
  // checkFinancialVerification reads back and isOfferAllowed consults. So an
  // override that has been granted lifts THIS refusal automatically, through the
  // same gate, with the actor and the written justification on the record.
  // Adding an `isOverride` parameter to createOffer would be a second, weaker
  // override mechanism with no authority check and no audit — so there is none.
  const lifecycleGate = await checkBuyerOfferEligibility(contactId)
  if (!lifecycleGate.allowed) {
    const remedies = (lifecycleGate.blockers ?? [])
      .map((blocker) => OFFER_LIFECYCLE_GATE_REMEDY[blocker])
      .filter((r): r is string => !!r)
    const remedy = remedies.length > 0 ? remedies.join(" ") : OFFER_LIFECYCLE_GATE_DEFAULT_REMEDY
    return {
      success: false,
      error: `${lifecycleGate.reason ?? "This buyer is not eligible to submit offers"} — ${remedy}`,
    }
  }

  // ── Financial verification gate (System J3.1 — buyer cannot make offers
  //    until verified or explicitly bypassed by the agent). Previously this
  //    gate was UI-only — the panel toggled `buyer_financial_profiles.verified`
  //    but no backend caller ever checked it, so any client could POST and
  //    create an offer for an unverified buyer. Enforce here at the API
  //    boundary.
  //
  //    KEPT ALONGSIDE GATE 1, AND NOT COLLAPSED INTO IT, because the two read
  //    DIFFERENT stores and this one is the stricter of the pair: this is the
  //    `buyer_financial_profiles.verified` COLUMN that
  //    app/actions/buyer-financial.ts:markFinanciallyVerified sets, while gate
  //    1's financial half is the ACTIVITY trail that
  //    lib/buyer-lifecycle/financial-verification.ts:checkFinancialVerification
  //    reads. BOTH OVERRIDE LANES NOW LIFT BOTH STORES. The agent bypass on the
  //    Financial Verification panel goes through markFinanciallyVerified and
  //    always set this column; the emergency lane (buyer-execution.ts
  //    :adminOverrideFinancialVerification → multi-party-updates.ts
  //    :adminOverrideFinancialGate) used to write ONLY the activity, so an
  //    override granted there opened gate 1 and was then stopped dead HERE — the
  //    agent told "not financially verified" moments after an authorised
  //    override said otherwise, with nothing explaining the contradiction. That
  //    was the owner's ruling ("admin or agent can override the financing gate")
  //    being defeated rather than enforced. The fix completed the OVERRIDE, not
  //    weakened the GATE: this check is exactly as strict for everyone who has
  //    not been granted one, and the override refuses out loud if it cannot lift
  //    both stores.
  const { data: finProfile } = await supabase
    .from("buyer_financial_profiles")
    .select("verified")
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (!finProfile?.verified) {
    return {
      success: false,
      error: "Buyer is not financially verified. Complete the verification gate (proof of funds for cash, or pre-approval for financed) before submitting an offer.",
    }
  }

  // listing_id is nullable on offers. It points to a seller-owned `listings`
  // row ONLY when the buyer is offering on one of our own listings. For
  // external/IDX/off-platform properties (the common buyer case) it stays NULL
  // — the property is identified by `property_address`. We never fabricate a
  // synthetic seller listing for a buyer's external target; listings belong to
  // sellers and the two domains stay separate.
  //
  // A caller-supplied listing id is only honoured when the listing is in the
  // SAME tenant — otherwise the offer would be hung off another brokerage's
  // listing row and surface in that brokerage's offers screen.
  let resolvedListingId: string | null = null
  if (form.listing_id && isValidUUID(form.listing_id)) {
    const { data: linkListing, error: linkErr } = await supabase
      .from("listings").select("brokerage_id").eq("id", form.listing_id).maybeSingle()
    if (linkErr) return { success: false, error: "Could not verify the listing" }
    if (!linkListing || linkListing.brokerage_id !== brokerageId) {
      return { success: false, error: "Forbidden: listing is not in your brokerage" }
    }
    resolvedListingId = form.listing_id
  }

  // ── GATE 2 of 2: THE PENDING-OFFER LIMIT ───────────────────────────────────
  //
  // "HOW MANY OFFERS DOES THIS BUYER ALREADY HAVE OUT?" — a DIFFERENT question
  // from gate 1, which is why both are here and neither is collapsed into the
  // other. Gate 1 knows nothing about how many offers are live; this one knows
  // nothing about the buyer's stage or their finances. A buyer can pass either
  // and fail the other.
  //
  // Until now the cap existed only in a client banner
  // (app/components/offer/multi-offer-status-banner.tsx), which says in its own
  // header that it "does not block creation" — and nothing else did either, so
  // MAX_PENDING_OFFERS bound nowhere. It binds here.
  //
  // FAILS CLOSED. `success:false` means the count did not run — a refused
  // activities read, an unreadable lifecycle trail — and a limit that cannot be
  // verified must refuse, not wave the offer through on a count of zero. Every
  // table is EMPTY pre-rollout, so "nothing came back" is exactly the shape a
  // refusal takes here.
  //
  // NO OVERRIDE, DELIBERATELY. The settled owner ruling covers the FINANCING
  // gate (gate 1). Nothing has ever been ruled about overriding the pending cap,
  // and inventing an override for it here would be inventing policy — the
  // remedy is to resolve one of the offers that is actually holding a slot, and
  // the refusal names them.
  const limitGate = await checkPendingOfferLimit(contactId)
  if (!limitGate.success) {
    return {
      success: false,
      error: `The ${MAX_PENDING_OFFERS}-pending-offer limit could not be checked for this buyer (${limitGate.reason ?? "the check did not run"}), so no offer was created. Retry; if it keeps failing, this buyer's offer lifecycle trail cannot be read and needs an admin — an unverifiable limit is not an open one.`,
    }
  }
  if (!limitGate.can_submit) {
    const holding = limitGate.pending_offer_ids ?? []
    return {
      success: false,
      error: `${limitGate.reason ?? `Maximum ${MAX_PENDING_OFFERS} pending offers reached`} (${limitGate.pending_count ?? MAX_PENDING_OFFERS} pending). Withdraw or resolve one of this buyer's pending offers first${holding.length > 0 ? ` — ${holding.join(", ")}` : ""}; they are listed on the contact's Offers tab, and a seller response or a withdrawal frees the slot immediately.`,
    }
  }

  // ── MULTI-OFFER GOVERNANCE (System 7.1A Domain 2) ──────────────────────────
  // "No duplicate offers on the same listing" is the rule that module states and
  // enforces nowhere: checkDuplicateOffer was written for exactly this moment
  // and had no caller, so the only offer creator on the platform never asked.
  // Only a LIVE offer blocks — the check counts non-terminal offers, and DRAFT
  // is excluded here on purpose so an abandoned draft cannot lock a buyer out of
  // the property they actually want to bid on.
  // Applies only to our OWN listings; for an external/IDX target listing_id is
  // NULL and there is no listing key to dedupe on (property_address dedupe is a
  // separate, unbuilt piece of work).
  if (resolvedListingId) {
    const dupe = await checkDuplicateOffer(contactId, resolvedListingId)
    if (dupe.success && dupe.has_duplicate && dupe.existing_state !== "DRAFT") {
      return {
        success: false,
        error: `This buyer already has a live offer on this property (${dupe.existing_state?.toLowerCase()}). Withdraw or resolve offer ${dupe.existing_offer_id} before submitting another.`,
      }
    }
  }

  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .insert({
      contact_id:                  contactId,
      brokerage_id:                brokerageId,
      agent_id:                    agentId,
      listing_id:                  resolvedListingId,
      property_address:            form.property_address,
      property_address_ai_filled:  form.property_address_ai_filled ?? false,
      offer_price:                 form.offer_price,
      earnest_money:               form.earnest_money,
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
      // metadata stores in-app form selections separately so buyer_notes
      // remains human-readable plain text and is never corrupted with JSON.
      metadata:                    form.in_app_selected_form_ids?.length
        ? {
            selected_form_ids: form.in_app_selected_form_ids,
            form_field_values: form.in_app_form_field_values ?? {},
          }
        : null,
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

  // ── THE OFFER LIFECYCLE LANE'S MISSING WRITER ──────────────────────────────
  // `buyer.offer.draft.created` on activities(entity_type='offer', entity_id) is
  // the event the whole offer state machine derives DRAFT from:
  //   · app/actions/buyer-offer/track-offer-lifecycle.ts:getOfferLifecycleState
  //   · lib/buyer-offer/expire-offers.ts, lib/buyer-offer/status-sync.ts
  //   · handle-multi-offer.ts (pending counts, duplicates, active-offer list)
  //   · app/components/offer/multi-offer-status-banner.tsx (buyer-facing)
  //   · the offer-expiry cron
  // NOTHING in the repo ever wrote it. Every one of those readers therefore got
  // "Offer not found" for every offer that has ever existed: the banner showed
  // zero active offers, the 3-pending cap could never bind, submitOffer could
  // never move an offer out of DRAFT because there was no DRAFT to move, and
  // offers.status could not sync. The canonical creator is the right emitter.
  //
  // brokerage_id is supplied explicitly — it is NOT NULL on activities, and an
  // emitter that omits it writes zero rows while reporting success.
  // `error` is read rather than swallowed for the same reason.
  const { error: lifecycleActivityErr } = await supabase.from("activities").insert({
    brokerage_id:  brokerageId,
    agent_id:      agentId,
    contact_id:    contactId,
    listing_id:    resolvedListingId,
    // Canonical constant, not a literal — lib/buyer-offer/offer-lifecycle.ts is
    // the only place an offer event name is spelled. This row already carried
    // both halves of the key (brokerage_id + entity_type/entity_id), verified on
    // re-read; only the spelling changed.
    activity_type: OFFER_EVENT.DRAFT_CREATED,
    title:         "Offer draft created",
    description:   `Offer draft created for ${form.property_address}`,
    notes:         JSON.stringify({ offer_id: offer.id, new_state: "DRAFT" }),
    status:        "completed",
    entity_type:   "offer",
    entity_id:     offer.id,
  })
  if (lifecycleActivityErr) {
    // Non-fatal — the offer row is the durable artifact — but LOUD, because a
    // silent failure here is what put this lane in the dark to begin with.
    console.error(
      `[createOffer] offer ${offer.id} created but its buyer.offer.draft.created lifecycle event failed (${lifecycleActivityErr.message}) — lifecycle-derived state for this offer will read as "not found".`,
    )
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

/** SIGNING-ORDER MICRO-CHECK (concierge micro-list: "record who will
 *  physically sign and their signing order, so e-sign flows don't break at
 *  the last second"). Confirm BEFORE any send; suggestions derive from the
 *  contact's legal names (the scan write-back feeds this directly). */
//
// GATED. Unauthenticated: the offer was scoped only to a caller-supplied
// `brokerageId`, so naming the right tenant was the whole authorization. This
// is the record of WHO LEGALLY SIGNS a purchase contract, and it is the gate
// `sendOfferForESign` reads — forging it both rewrote the signer list and
// unlocked the send. `brokerageId` retained and ignored (house pattern).
export async function confirmSigningOrderAction(
  offerId: string,
  _brokerageId: string | undefined,
  signers: string[],
): Promise<{ success: boolean; error?: string }> {
  const gate = await requireOfferInCallerBrokerage(offerId)
  if (!gate.ok) return { success: false, error: gate.error }

  const supabase = createServiceClient()
  const clean = signers.map((x) => x.trim()).filter(Boolean).slice(0, 6)
  if (clean.length === 0) return { success: false, error: "At least one signer is required" }
  const { data: offer } = await supabase.from("offers")
    .select("id, metadata").eq("id", offerId).eq("brokerage_id", gate.brokerageId).maybeSingle()
  if (!offer) return { success: false, error: "Offer not found" }
  const { error } = await supabase.from("offers").update({
    metadata: { ...((offer as any).metadata ?? {}), signing_order: clean, signing_order_confirmed_at: new Date().toISOString() },
  }).eq("id", offerId).eq("brokerage_id", gate.brokerageId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

//
// GATED. Unauthenticated: an open endpoint that flips a purchase offer to
// `esign_status: "sent"` and notifies a named user, for any offer in any tenant
// the caller cared to name. `contactId` is now taken from the OFFER ROW rather
// than the caller, so the signer-name suggestion can no longer be used to read
// an arbitrary contact's legal name. `brokerageId` / `agentUserId` retained and
// ignored (house pattern).
export async function sendOfferForESign(
  offerId: string,
  _contactId: string | undefined,
  _brokerageId: string | undefined,
  _agentUserId: string | undefined
): Promise<{ success: boolean; error?: string; needsSigningOrder?: boolean; suggestedSigners?: string[] }> {
  const gate = await requireOfferInCallerBrokerage(offerId)
  if (!gate.ok) return { success: false, error: gate.error }
  const brokerageId = gate.brokerageId
  const agentUserId = gate.userId
  const contactId = gate.contactId

  const supabase = createServiceClient()

  // THE GATE — no e-sign leaves without the signing order confirmed (both
  // spouses? POA? entity signer?) — the flow that breaks at the last second
  // when it's left to memory. Suggestions lead with the LEGAL name when the
  // document scan has already filled it.
  const { data: offerRow } = await supabase.from("offers")
    .select("metadata").eq("id", offerId).eq("brokerage_id", brokerageId).maybeSingle()
  const signingOrder = ((offerRow as any)?.metadata?.signing_order ?? []) as string[]
  if (!Array.isArray(signingOrder) || signingOrder.length === 0) {
    // offers.contact_id is nullable. A null id must NOT be coerced to "" — that
    // is a 22P02 on a uuid column, not an empty result. Skip the lookup instead.
    const { data: c } = contactId
      ? await supabase.from("contacts")
          .select("first_name, last_name, legal_first_name, legal_last_name")
          .eq("id", contactId).maybeSingle()
      : { data: null as any }
    const legal = [(c as any)?.legal_first_name, (c as any)?.legal_last_name].filter(Boolean).join(" ")
    const plain = [(c as any)?.first_name, (c as any)?.last_name].filter(Boolean).join(" ")
    return {
      success: false,
      needsSigningOrder: true,
      suggestedSigners: [legal || plain || "Buyer"].filter(Boolean),
      error: "Confirm who physically signs and in what order before sending — both spouses? POA? entity signer? E-sign flows break at the last second when this is left to memory.",
    }
  }

  const { error } = await supabase
    .from("offers")
    .update({ esign_status: "sent", esign_sent_at: new Date().toISOString() })
    .eq("id", offerId)
    .eq("brokerage_id", brokerageId)

  if (error) return { success: false, error: error.message }

  // Notification to buyer — same nullable-contact_id rule as above.
  const { data: contact } = contactId
    ? await supabase
        .from("contacts")
        .select("first_name, last_name")
        .eq("id", contactId)
        .maybeSingle()
    : { data: null as any }

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

/**
 * 🚨 WAS AN UNAUTHENTICATED CROSS-TENANT READ OF LIVE OFFER TERMS.
 *
 * This is a `"use server"` export — a public HTTP endpoint. It ran on
 * `createServiceClient()` (RLS bypassed) with **no authentication of any kind**,
 * and took BOTH the contact id and the brokerage id from the caller, so
 * `.eq("brokerage_id", brokerageId)` scoped it to whatever tenant the caller
 * named. It returns a buyer's complete negotiating position: `offer_price`,
 * `earnest_money`, `financing_type`, `contingencies`, `buyer_notes`,
 * `property_address` and the closing date.
 *
 * In this domain that is not ordinary PII — a competing bidder who learns another
 * buyer's price, contingencies and financing wins the house. It is the single
 * most commercially damaging read in the offers lane.
 *
 * Gated with `requireContactAccess(contactId)`, which is the right shape for this
 * surface rather than a plain staff gate: it allows **the buyer themselves**
 * (portal) OR **staff in the contact's own brokerage**, and — the important part —
 * it returns the `brokerageId` resolved FROM THE CONTACT ROW. The tenant can no
 * longer be asserted by the caller. The `brokerageId` parameter is retained and
 * ignored (house pattern) so any future call site keeps type-checking.
 */
export async function getBuyerOffers(
  contactId: string,
  _brokerageId?: string
): Promise<{ success: boolean; offers?: any[]; error?: string }> {
  if (!isValidUUID(contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("offers")
    // `listing_id` is PORTED from the inline copy that used to live in
    // app/crm/contacts/[contactId]/offers/page.tsx (w6s3) — that page selected it
    // and this reader did not, so consolidating onto this survivor without it would
    // have dropped a capability the offers client relies on.
    .select(`
      id, property_address, offer_price, status, esign_status,
      esign_sent_at, form_source, esign_provider, strategy_recommendation_id,
      created_at, submitted_at, closing_date, financing_type,
      earnest_money, contingencies, buyer_notes, listing_id
    `)
    .eq("contact_id", contactId)
    // Tenant anchor comes from the contact row via the gate, never the caller.
    .eq("brokerage_id", access.brokerageId)
    .order("created_at", { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, offers: data ?? [] }
}

// ─── RECORD OUTCOME ───────────────────────────────────────────────────────────

/**
 * 🚨 THIS WAS "ANYONE CAN ACCEPT OR REJECT ANY OFFER ON THE PLATFORM".
 *
 * A `"use server"` export — a public HTTP endpoint — with **no authentication of
 * any kind**, running on `createServiceClient()` so RLS never applied, whose
 * first act was:
 *
 *     .from("offers").update({ status: statusMap[outcome] }).eq("id", offerId)
 *
 * filtered on the offer uuid ALONE — not even the caller-supplied `brokerageId`
 * was applied to it. Any unauthenticated caller holding an offer uuid could set
 * that offer to `accepted`, `rejected` or `countered` in any tenant, then have
 * `emitLifecycleTransition` drive the buyer from BUYER_OFFER_SUBMITTED to
 * BUYER_UNDER_CONTRACT (or back to eligible) under a named agent's identity, and
 * insert a `strategy_outcomes` row poisoning the strategy-learning corpus that
 * `getOrGenerateStrategyRecommendation` reads back to price future offers.
 *
 * Now: session required; the tenant and the actor come from the offer row and the
 * session; every write carries the tenant anchor; the recommendation must belong
 * to the same tenant; and — new — the outcome must actually be recordable. The
 * `contactId` is taken from the offer, not the caller, so the lifecycle
 * transition can no longer be pointed at a different buyer than the one who made
 * the offer.
 *
 * `contactId` / `brokerageId` / `agentUserId` are retained and ignored (house
 * pattern) so the existing call site keeps type-checking.
 */
export async function recordOfferOutcome(
  offerId: string,
  recommendationId: string | null,
  _contactId: string | undefined,
  _brokerageId: string | undefined,
  _agentUserId: string | undefined,
  outcome: "accepted" | "rejected" | "countered" | "withdrawn",
  finalPrice: number | null,
  notes: string
): Promise<{ success: boolean; error?: string }> {
  const gate = await requireOfferInCallerBrokerage(offerId)
  if (!gate.ok) return { success: false, error: gate.error }
  const brokerageId = gate.brokerageId
  const agentUserId = gate.userId
  const contactId = gate.contactId

  const supabase = createServiceClient()

  // Update offer status — TENANT ANCHORED. The unfiltered `.eq("id", offerId)`
  // was the whole vulnerability.
  const statusMap = {
    accepted:  "accepted",
    rejected:  "rejected",
    countered: "countered",
    withdrawn: "submitted",
  }
  const { error: statusError } = await supabase
    .from("offers")
    .update({ status: statusMap[outcome], updated_at: new Date().toISOString() })
    .eq("id", offerId)
    .eq("brokerage_id", brokerageId)
  // supabase-js RESOLVES a refused write — read the error or a refusal reports
  // as success and the caller's optimistic UI shows a status that never landed.
  if (statusError) return { success: false, error: statusError.message }

  // Insert strategy outcome if there's a recommendation
  if (recommendationId && isValidUUID(recommendationId)) {
    const { data: rec } = await supabase
      .from("strategy_recommendations")
      .select("recommended_price")
      .eq("id", recommendationId)
      // Same tenant, or the learning corpus can be written across tenants.
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    // No same-tenant recommendation → do NOT file an outcome against it. Writing
    // one anyway would attribute this result to a recommendation we could not
    // read, which is exactly how the learning corpus gets poisoned. The offer
    // status change above still stands, and the lifecycle transition below still
    // runs — only the strategy-learning row is withheld.
    if (rec) {
      const deviation = finalPrice != null
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
  }

  // Lifecycle transition. `offers.contact_id` is nullable — an offer with no CRM
  // contact has no buyer lifecycle to move, and passing a null id downstream is
  // a 22P02, not a no-op.
  if (!contactId) return { success: true }

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
