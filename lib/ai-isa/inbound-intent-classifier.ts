/**
 * lib/ai-isa/inbound-intent-classifier.ts
 *
 * INBOUND INTENT CLASSIFIER — the autonomy capstone.
 *
 * When a lead REPLIES (email / SMS / web), the AI ISA reads the message,
 * CLASSIFIES the intent, and routes ITSELF to the right conversion + milestone —
 * no human picks the reason. This module maps an inbound message →
 * {side: 'buyer'|'seller', reason} (or none / negative) and calls the matching
 * converter:
 *
 *   seller → convertSellerLeadOnIntent  (positive_reply | cma_request | appointment_request)
 *   buyer  → convertBuyerLeadOnIntent   (positive_reply | criteria_request |
 *                                         preapproval_request | showing_request)
 *
 * HONEST CONSERVATISM — converting on a MISREAD positive signal is costly:
 *   - clear POSITIVE intent  → convert + route to the matching milestone.
 *   - clear NEGATIVE intent  → HALT (reuse haltEngagementForNegativeReply); NEVER convert.
 *   - AMBIGUOUS / no signal  → NO conversion; record a nurture touch, keep nurturing
 *                              (reason 'none'). A positive reply IS the engaged consent
 *                              the canonical handoff requires; silence is not.
 *
 * Two seams:
 *   1. keywordIntentFallback(message, knownSide?) — PURE, deterministic, testable.
 *      The default classifier and the safety net when the AI is unavailable.
 *   2. classifyAndRouteInbound(params, {classifier?}) — LIVE. Reads lead/contact
 *      context (known side + what's already known), runs the injectable classifier
 *      (AI by default, keyword fallback as the floor), halts on negative, routes on
 *      clear positive, records the nurture touch on ambiguous. Idempotent + gated.
 *
 * Reuse, don't rebuild: the converters, the canonical handoff, the negative-intent
 * halt and the AI-classification idiom (generateText + a strict enum, mirroring
 * app/api/internal/voice-command/route.ts) all already exist.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { guardedGenerateText } from "@/lib/data-guard/guarded-generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import {
  detectNegativeIntent,
  haltEngagementForNegativeReply,
} from "./conversation-handler"
import {
  convertSellerLeadOnIntent,
  type SellerIntentReason,
} from "./convert-seller-lead-on-intent"
import {
  convertBuyerLeadOnIntent,
  type BuyerIntentReason,
} from "./convert-buyer-lead-on-intent"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type IntentSide = "buyer" | "seller"

/** The pure classification: which side + which converter reason. */
export interface ClassifiedIntent {
  side: IntentSide
  reason: SellerIntentReason | BuyerIntentReason
}

/** What the live router knows about the lead/contact when it classifies. */
export interface InboundContext {
  /** The lead's known side, derived from motivation_type/lead_type. null = unknown. */
  knownSide: IntentSide | null
  /** Already has a saved search / criteria captured? (buyer) */
  hasCriteria: boolean
  /** Already has a (started/verified) pre-approval profile? (buyer) */
  hasPreapproval: boolean
  /** Already has a CMA proposed/generated? (seller) */
  hasCma: boolean
}

/** The injectable classifier seam — AI by default, keyword fallback as the floor. */
export type InboundClassifier = (
  message: string,
  ctx: InboundContext,
) => Promise<ClassifiedIntent | null> | (ClassifiedIntent | null)

export interface ClassifyAndRouteParams {
  leadId: string
  brokerageId: string
  /** The inbound reply text (email body / SMS / web message). */
  message: string
  /** Optional — for the AI classifier's context + the CMA/showing property data. */
  propertyData?: Record<string, any>
}

export interface ClassifyAndRouteResult {
  /** What we did with this message. */
  outcome: "converted" | "halted" | "nurtured" | "skipped"
  /** The classified intent, when we routed on a positive signal. */
  classified?: ClassifiedIntent
  /** contacts.id when the message converted the lead. */
  contactId?: string
  /** True when the lead was already a contact before this call (idempotent rerun). */
  alreadyConverted?: boolean
  /** Negative intent detected → engagement halted, DNC set. */
  halted?: boolean
  /** Why we did NOT convert (ambiguous, no lead, negative, …). */
  reason?: "none" | "negative" | "lead_not_found" | "convert_failed"
  error?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE keyword fallback (deterministic, testable, no I/O)
// ─────────────────────────────────────────────────────────────────────────────

const has = (text: string, ...terms: string[]) => terms.some((t) => text.includes(t))

/**
 * keywordIntentFallback — PURE message → {side, reason} | null.
 *
 * Deterministic intent extraction. Returns null when the message is NEGATIVE
 * (the caller must HALT, never convert) OR genuinely AMBIGUOUS (no clear intent —
 * keep nurturing). When the message carries a clear POSITIVE intent it returns the
 * side + the matching converter reason.
 *
 * Side resolution: an explicit signal in the message wins (e.g. "what's my home
 * worth" is unmistakably a SELLER cma_request regardless of knownSide). When the
 * message is a bare positive reply ("yes, interested") the side falls back to
 * `knownSide` — the same positive reply routes correctly because the lead's known
 * motivation disambiguates it.
 */
export function keywordIntentFallback(
  message: string,
  knownSide?: IntentSide | null,
): ClassifiedIntent | null {
  const text = (message ?? "").toLowerCase().trim()
  if (!text) return null

  // NEGATIVE always wins — caller HALTS, never converts. Null + the caller's own
  // detectNegativeIntent both gate this; returning null here keeps the pure layer
  // honest (negative is never a positive intent).
  if (detectNegativeIntent(message)) return null

  // ── SELLER side — explicit listing / valuation / appointment signals ────────
  // Appointment to LIST is a stronger seller signal than a bare valuation ask.
  if (
    has(text, "list my home", "list my house", "list my property",
      "ready to list", "set up a time to list", "set up a listing",
      "listing appointment", "list it", "meet to list", "get my home on the market",
      "put my home on the market", "put my house on the market")
  ) {
    return { side: "seller", reason: "appointment_request" }
  }
  if (
    has(text, "what's my home worth", "what is my home worth", "whats my home worth",
      "what's my house worth", "what is my house worth", "home value", "house value",
      "home worth", "what's it worth", "market value", "cma", "comparative market analysis",
      "how much is my home", "how much is my house", "how much could i get",
      "value of my home", "value of my house", "estimate my home")
  ) {
    return { side: "seller", reason: "cma_request" }
  }
  const sellsSignal = has(text, "sell my home", "sell my house", "sell my property",
    "thinking of selling", "thinking about selling", "want to sell", "looking to sell",
    "interested in selling")

  // ── BUYER side — showing / criteria / pre-approval signals ──────────────────
  if (
    has(text, "can i see", "can i tour", "tour the", "see the house", "see the home",
      "schedule a showing", "set up a showing", "request a showing", "see this home",
      "see this house", "see 1", "see 2", "see 3", "see 4", "see 5", "see 6", "see 7",
      "see 8", "see 9", "tour 1", "view the property", "walk through", "walkthrough",
      "show me the", "come see", "this weekend")
  ) {
    return { side: "buyer", reason: "showing_request" }
  }
  if (
    has(text, "pre-approved", "preapproved", "pre approved", "pre-approval", "preapproval",
      "pre approval", "what can i afford", "how much can i afford", "what's my budget",
      "qualify for a loan", "qualify for a mortgage", "get approved", "financing",
      "mortgage pre", "afford to buy")
  ) {
    return { side: "buyer", reason: "preapproval_request" }
  }
  if (
    has(text, "looking for", "in the market for", "searching for", "want to buy",
      "bedroom", "bd ", "br ", "3bd", "2bd", "4bd", "under $", "under 5", "under 4",
      "under 6", "under 3", "budget of", "price range", "square feet", "sqft",
      "neighborhood", "looking to buy", "interested in buying", "house hunting",
      "homes in", "properties in", "houses in")
  ) {
    return { side: "buyer", reason: "criteria_request" }
  }
  const buysSignal = has(text, "buy a home", "buy a house", "buying a home", "buying a house",
    "looking to buy", "first-time buyer", "first time buyer", "interested in buying")

  // ── Side-explicit bare positive (sell / buy stated, no specific milestone) ──
  if (sellsSignal && !buysSignal) return { side: "seller", reason: "positive_reply" }
  if (buysSignal && !sellsSignal) return { side: "buyer", reason: "positive_reply" }

  // ── Bare POSITIVE reply — route on knownSide ────────────────────────────────
  const positiveReply = has(text, "yes", "interested", "tell me more", "sounds good",
    "sure", "let's talk", "lets talk", "i'm in", "im in", "okay", "ok", "absolutely",
    "definitely", "please do", "go ahead", "love to", "i'd like", "id like")
  if (positiveReply) {
    if (knownSide) return { side: knownSide, reason: "positive_reply" }
    // Positive but no idea which side → AMBIGUOUS. Don't guess a side to convert.
    return null
  }

  // No clear intent → AMBIGUOUS. Keep nurturing.
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// AI classifier (the default live seam) — mirrors voice-command/route.ts
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_ENUM = [
  "seller_positive_reply",
  "seller_cma_request",
  "seller_appointment_request",
  "buyer_positive_reply",
  "buyer_criteria_request",
  "buyer_preapproval_request",
  "buyer_showing_request",
  "negative",
  "none",
] as const

function decodeIntentLabel(label: string): ClassifiedIntent | null {
  switch (label) {
    case "seller_positive_reply":      return { side: "seller", reason: "positive_reply" }
    case "seller_cma_request":         return { side: "seller", reason: "cma_request" }
    case "seller_appointment_request": return { side: "seller", reason: "appointment_request" }
    case "buyer_positive_reply":       return { side: "buyer",  reason: "positive_reply" }
    case "buyer_criteria_request":     return { side: "buyer",  reason: "criteria_request" }
    case "buyer_preapproval_request":  return { side: "buyer",  reason: "preapproval_request" }
    case "buyer_showing_request":      return { side: "buyer",  reason: "showing_request" }
    default:                           return null // negative | none | unknown → no positive route
  }
}

/**
 * aiClassifier — the default live classifier. Classifies the inbound reply into a
 * strict intent enum via a small generateText call routed through the gateway
 * (mirrors the voice-command idiom: tiny maxOutputTokens, enum-only response).
 *
 * Falls back to keywordIntentFallback when the AI returns an unrecognized label —
 * HONEST CONSERVATISM means an unparseable AI answer never invents a conversion.
 */
async function aiClassifier(
  message: string,
  ctx: InboundContext,
): Promise<ClassifiedIntent | null> {
  // Negative is detected deterministically BEFORE we ever reach the converters
  // (the live router re-checks too) — but bias the AI to it as well.
  const sideHint =
    ctx.knownSide === "seller"
      ? "This lead's known motivation is SELLER."
      : ctx.knownSide === "buyer"
      ? "This lead's known motivation is BUYER."
      : "This lead's side (buyer vs seller) is unknown."
  const knownHint = [
    ctx.hasCriteria ? "They already shared search criteria." : "",
    ctx.hasPreapproval ? "They already have a pre-approval started." : "",
    ctx.hasCma ? "They already have a CMA proposed." : "",
  ].filter(Boolean).join(" ")

  try {
    const result = await guardedGenerateText({
      model: resolveModel("openai/gpt-4o-mini"),
      system: `You classify an inbound real-estate lead REPLY into one intent. ${sideHint} ${knownHint}
Choose EXACTLY one label:
- seller_cma_request: asking what their home is worth, a valuation, a CMA, market value.
- seller_appointment_request: asking to list / get on the market / a listing appointment.
- seller_positive_reply: positive/engaged from a seller with no specific ask.
- buyer_showing_request: asking to see/tour/walk through a specific property.
- buyer_preapproval_request: asking about pre-approval, financing, what they can afford.
- buyer_criteria_request: sharing search criteria (beds, budget, area, property type).
- buyer_positive_reply: positive/engaged from a buyer with no specific ask.
- negative: opting out, not interested, stop, unsubscribe.
- none: ambiguous, no clear intent, just chit-chat, or a question we can't classify.
Be CONSERVATIVE: only pick a positive label when the intent is CLEAR. If unsure, pick none.
Respond with ONLY the label, nothing else.`,
      messages: [{ role: "user", content: message }],
      maxOutputTokens: 12,
    })
    const label = result.text.trim().toLowerCase().replace(/[^a-z_]/g, "")
    if ((INTENT_ENUM as readonly string[]).includes(label)) {
      return decodeIntentLabel(label)
    }
  } catch {
    // AI unavailable / errored — fall through to the deterministic floor.
  }
  return keywordIntentFallback(message, ctx.knownSide)
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE router: read context → classify → halt / route / nurture
// ─────────────────────────────────────────────────────────────────────────────

function deriveSide(motivation: string | null, leadType: string | null): IntentSide | null {
  const m = (motivation ?? "").toLowerCase()
  const lt = (leadType ?? "").toLowerCase()
  // Explicit seller signal wins; 'both' and bare buyer map to buyer (mirrors
  // motivationToContactType — 'both' is worked as a buyer until split).
  if (m.includes("seller") || lt.includes("seller")) return "seller"
  if (m.includes("buyer") || m.includes("both") || lt.includes("buyer") || lt.includes("both")) return "buyer"
  return null
}

/**
 * classifyAndRouteInbound — the live capstone.
 *
 * Reads the lead/contact context, runs the (injectable) classifier, then:
 *   - NEGATIVE  → haltEngagementForNegativeReply (DNC, sequences stopped, agent paged); NO convert.
 *   - clear POSITIVE → convertSellerLeadOnIntent / convertBuyerLeadOnIntent on the matched reason.
 *   - AMBIGUOUS → record a nurture touch (activity), NO conversion (keep nurturing).
 *
 * Idempotent (the converters are idempotent per lead), gated (negative halts first),
 * and NEVER converts on negative or ambiguous. Additive — the existing inbound handler
 * keeps its own negative-intent halt; this runs behind it.
 */
export async function classifyAndRouteInbound(
  params: ClassifyAndRouteParams,
  opts: { classifier?: InboundClassifier } = {},
): Promise<ClassifyAndRouteResult> {
  const svc = createServiceClient()
  const classifier = opts.classifier ?? aiClassifier

  // ── Gate 0: NEGATIVE intent halts everything FIRST — never reaches a converter ─
  if (detectNegativeIntent(params.message)) {
    await haltEngagementForNegativeReply({
      leadId: params.leadId,
      body: params.message,
      brokerageId: params.brokerageId,
    })
    return { outcome: "halted", halted: true, reason: "negative" }
  }

  // ── Read the lead's known side + what's already known ───────────────────────
  const { data: lead } = await svc
    .from("leads")
    .select("id, motivation_type, lead_type, contact_id, address, city, state, zip_code, property_zip_code")
    .eq("id", params.leadId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!lead) {
    return { outcome: "skipped", reason: "lead_not_found", error: "Lead not found" }
  }

  const knownSide = deriveSide((lead as any).motivation_type, (lead as any).lead_type)

  // What's already known on the (possibly already-converted) contact — lets the
  // SAME positive reply route correctly and avoids redundant milestone work.
  let hasCriteria = false
  let hasPreapproval = false
  let hasCma = false
  const contactId = (lead as any).contact_id as string | null
  if (contactId) {
    const [{ count: prefC }, { count: finC }, { count: cmaC }] = await Promise.all([
      svc.from("property_preferences").select("id", { count: "exact", head: true }).eq("contact_id", contactId),
      svc.from("buyer_financial_profiles").select("id", { count: "exact", head: true }).eq("contact_id", contactId),
      svc.from("cma_reports").select("id", { count: "exact", head: true }).eq("contact_id", contactId),
    ])
    hasCriteria = (prefC ?? 0) > 0
    hasPreapproval = (finC ?? 0) > 0
    hasCma = (cmaC ?? 0) > 0
  }

  const ctx: InboundContext = { knownSide, hasCriteria, hasPreapproval, hasCma }

  // ── Classify (AI by default; keyword fallback as the floor / injectable seam) ─
  const classified = await classifier(params.message, ctx)

  // AMBIGUOUS / no clear intent → NO conversion. Record a nurture touch, keep nurturing.
  if (!classified) {
    await svc.from("activities").insert({
      contact_id: params.leadId,
      brokerage_id: params.brokerageId,
      activity_type: "ai_isa_inbound_nurture",
      title: "Inbound reply — no conversion intent",
      description: "AI ISA classified an inbound reply as ambiguous / no clear conversion intent. Kept nurturing (no conversion).",
      status: "completed",
      completed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }).then(() => null, () => null)
    return { outcome: "nurtured", reason: "none" }
  }

  // ── RETURNING-CUSTOMER hook ─────────────────────────────────────────────────
  // A clear positive reply from a PAST client (the lead links to a lifetime contact) logs a
  // contact reactivation signal so the Returning-Customer runner re-engages them WITH their
  // prior-deal memory via the right manager (Shopping Agent / Listing Concierge). Additive +
  // best-effort — it never affects the conversion routing below.
  if (contactId) {
    try {
      const { data: c } = await svc
        .from("contacts")
        .select("contact_type, lifecycle_state, buyer_stage, nurture_status")
        .eq("id", contactId)
        .maybeSingle()
      const { isReengageableLifetime } = await import("@/lib/kernel/returning-customer")
      if (c && isReengageableLifetime({ id: contactId, ...(c as Record<string, unknown>) })) {
        const { recordReactivationSignal } = await import("@/lib/ai-isa/long-term-nurture")
        await recordReactivationSignal({
          contactId,
          brokerageId: params.brokerageId,
          signalType: `returning_${classified.side}_${classified.reason}`,
          signalStrength: 80,
          signalData: { source: "inbound_intent", side: classified.side, reason: classified.reason },
        })
      }
    } catch { /* best-effort — never blocks conversion routing */ }
  }

  // ── Clear POSITIVE → route to the matching converter on the classified reason ─
  const propertyData =
    params.propertyData ??
    ((lead as any).address
      ? {
          address: (lead as any).address,
          city: (lead as any).city,
          state: (lead as any).state,
          zip: (lead as any).zip_code ?? (lead as any).property_zip_code,
        }
      : undefined)

  if (classified.side === "seller") {
    const res = await convertSellerLeadOnIntent({
      brokerageId: params.brokerageId,
      leadId: params.leadId,
      reason: classified.reason as SellerIntentReason,
      propertyData,
      // appointment_request without a concrete slot still converts + proposes; the
      // converter books only when an appointment slot is supplied. The agent confirms
      // the slot, so we deliberately do NOT fabricate one from an inbound reply.
    })
    if (!res.success) {
      return { outcome: "skipped", classified, reason: "convert_failed", error: res.error }
    }
    return {
      outcome: "converted",
      classified,
      contactId: res.contactId,
      alreadyConverted: res.alreadyConverted,
    }
  }

  // BUYER side
  const res = await convertBuyerLeadOnIntent({
    brokerageId: params.brokerageId,
    leadId: params.leadId,
    reason: classified.reason as BuyerIntentReason,
    // criteria_request / showing_request need structured data the inbound text alone
    // doesn't carry reliably — the converter STILL converts and skips the routing step
    // (routingSkippedReason) when criteria/property are absent, which is the honest
    // outcome for a bare inbound reply. The agent enriches on follow-up.
  })
  if (!res.success) {
    return { outcome: "skipped", classified, reason: "convert_failed", error: res.error }
  }
  return {
    outcome: "converted",
    classified,
    contactId: res.contactId,
    alreadyConverted: res.alreadyConverted,
  }
}
