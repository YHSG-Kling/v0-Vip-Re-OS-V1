"use server"

/**
 * app/actions/lead-signal-ingest.ts
 *
 * Thin server actions that the rest of the codebase calls when a
 * qualifying event happens. They build the SignalDelta and apply it
 * through the existing scoring path — no new tables, no replacement of
 * the AI scoring logic.
 *
 * Existing call sites that plug into these:
 *   • Buyer offer workflow → ingestOfferLostSignalAction (when an offer's
 *     final state is `lost` or `withdrawn_after_competing_accepted`)
 *     — wired: app/actions/seller-offers.ts
 *   • Open house attendee submission → ingestOpenHouseAttendeeSignalAction
 *     — wired: app/actions/seller-open-house.ts
 *   • The existing lead-scraping pipeline → ingestPredictiveSellerSignalAction
 *     (each predictive contributor — equity threshold, life event, etc.
 *     — calls in with its own signalKey + confidence)
 *     — NOT yet wired; see the note on that export.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SECURITY — why every export here is gated (w2s3)
 *
 * This file is `"use server"`, so each export is a publicly reachable HTTP
 * endpoint. `applySignalDelta()` runs on the SERVICE client and filters on
 * `contact_id` alone, so RLS is not in play once the delta reaches it.
 * Before this pass none of the three exports authenticated at all: any
 * unauthenticated caller could POST a `contactId` belonging to ANY
 * brokerage and push that tenant's lead scores up, plus write an
 * attributed `lead_score_history` audit row that looked like the platform
 * had observed a real signal.
 *
 * The gate below runs BEFORE any delta is built. It authenticates, then
 * proves the contact lives in the caller's brokerage using the COOKIE
 * client (so RLS applies to the check itself), and it fails CLOSED: a
 * refused or errored read is rejected, never treated as "no rows".
 * ─────────────────────────────────────────────────────────────────────────
 */

import { resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import {
  applySignalDelta,
  buildOfferLostSignal,
  buildOpenHouseAttendeeSignal,
  buildPredictiveSellerSignal,
} from "@/lib/lead-intelligence/signal-extensions"
import {
  evaluateInboundLeadSignal,
  type InboundLeadChannel,
  type InboundLeadIntentResult,
} from "@/lib/lead-intent"

type IngestResult = { applied: boolean; reason?: string }

/**
 * Authenticate the caller and prove `contactId` belongs to the caller's
 * brokerage. Returns a rejection *reason* rather than throwing so the
 * fire-and-forget call sites (`.catch(() => {})`) keep their shape and a
 * rejected signal never blocks the business action that emitted it.
 *
 * Fails closed on a refused read — a signal that cannot be proven in-tenant
 * is not applied.
 */
async function authorizeContactInTenant(
  contactId: string,
): Promise<{ ok: true; brokerageId: string } | { ok: false; reason: string }> {
  if (!contactId || !isValidUUID(contactId)) {
    return { ok: false, reason: "invalid_contact_id" }
  }

  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) return { ok: false, reason: "unauthorized" }

  const supabase = ctx.db
  const { data, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  // A refused read resolves as `{ data: null, error }`. Treating that as
  // "contact not found" would be correct here by accident, but treating it
  // as "no error" anywhere in this chain would be a fail-open gate — so the
  // error branch is explicit and distinguishable in the returned reason.
  if (error) return { ok: false, reason: "contact_scope_check_failed" }
  if (!data) return { ok: false, reason: "contact_not_in_tenant" }

  return { ok: true, brokerageId: ctx.brokerageId }
}

export async function ingestOfferLostSignalAction(input: {
  contactId: string
  offerId: string
  offerAmount: number
  losingMargin?: number
}): Promise<IngestResult> {
  const gate = await authorizeContactInTenant(input.contactId)
  if (!gate.ok) return { applied: false, reason: gate.reason }

  // offerAmount only feeds the human-readable reason string, but a non-finite
  // value would render as "$NaN" in the audit trail.
  const offerAmount = Number.isFinite(Number(input.offerAmount)) ? Number(input.offerAmount) : 0
  const losingMargin = Number.isFinite(Number(input.losingMargin)) ? Number(input.losingMargin) : undefined

  const delta = buildOfferLostSignal({
    contactId: input.contactId,
    offerId: input.offerId,
    offerAmount,
    losingMargin,
  })
  return applySignalDelta(delta)
}

export async function ingestOpenHouseAttendeeSignalAction(input: {
  contactId: string
  attendeeId: string
  listingId: string
  interestLevel?: 1 | 2 | 3 | 4 | 5
}): Promise<IngestResult> {
  const gate = await authorizeContactInTenant(input.contactId)
  if (!gate.ok) return { applied: false, reason: gate.reason }

  // interestLevel is multiplied into the boost, so an out-of-range or
  // non-integer value from the wire would scale the score arbitrarily.
  const raw = Number(input.interestLevel)
  const interestLevel = (
    Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : undefined
  ) as 1 | 2 | 3 | 4 | 5 | undefined

  const delta = buildOpenHouseAttendeeSignal({
    contactId: input.contactId,
    attendeeId: input.attendeeId,
    listingId: input.listingId,
    interestLevel,
  })
  return applySignalDelta(delta)
}

/**
 * Predictive-seller signal.
 *
 * NOT YET WIRED. The lane it was written for is the lead-scraping pipeline
 * (`app/api/cron/lead-scraping/route.ts`), which runs with no user session —
 * so it cannot call this gated action. Finishing the wiring means having the
 * pipeline call the library entry point `applySignalDelta()` directly (it is
 * `import "server-only"`, service-client, and already idempotent per
 * (contact, source, evidence, day)) with a brokerage-scoped contact it has
 * already resolved. That call site lives outside this slice's file set, so
 * the endpoint is hardened in place and left for the pipeline owner.
 *
 * It is kept as an action because the interactive surfaces that surface a
 * predictive signal for manual confirmation (the seller-signal review lane)
 * do have a session and can call it directly.
 */
export async function ingestPredictiveSellerSignalAction(input: {
  contactId: string
  signalKey: string
  signalLabel: string
  confidence: number
  evidenceId?: string | null
  evidence?: Record<string, unknown>
}): Promise<IngestResult> {
  const gate = await authorizeContactInTenant(input.contactId)
  if (!gate.ok) return { applied: false, reason: gate.reason }

  // The builder clamps with Math.min/Math.max, which propagates NaN rather
  // than rejecting it: a non-numeric `confidence` from the wire would reach
  // `Math.round(15 * NaN) + 3` and land NaN/null in lead_score_history's
  // numeric score columns. Reject it here instead.
  const confidence = Number(input.confidence)
  if (!Number.isFinite(confidence)) {
    return { applied: false, reason: "invalid_confidence" }
  }

  const signalKey = String(input.signalKey ?? "").trim()
  const signalLabel = String(input.signalLabel ?? "").trim()
  if (!signalKey || !signalLabel) {
    return { applied: false, reason: "missing_signal_identity" }
  }

  const delta = buildPredictiveSellerSignal({
    contactId: input.contactId,
    signalKey: signalKey.slice(0, 120),
    signalLabel: signalLabel.slice(0, 200),
    confidence: Math.max(0, Math.min(1, confidence)),
    evidenceId: input.evidenceId ?? null,
    evidence: input.evidence,
  })
  return applySignalDelta(delta)
}

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND MESSAGE FROM A LEAD — the intent / conversion / opt-out door
// ─────────────────────────────────────────────────────────────────────────────

const INBOUND_LEAD_CHANNELS = new Set<InboundLeadChannel>(["email", "sms", "voice", "direct_mail"])

/**
 * ingestInboundLeadSignalAction — receive one inbound message FROM A LEAD, on any
 * of the four channels the owner's ruling names (inbound calls, texts, email,
 * direct-mail responses), evaluate its intent, and act on it:
 *
 *   clear POSITIVE           → the lead converts to a contact AUTOMATICALLY,
 *                              through the existing canonical lane
 *                              (classifyAndRouteInbound → convertBuyer/SellerLeadOnIntent
 *                              → acceptAIISAHandoff → evaluateAndAssignLead →
 *                              handleLeadAssigned → createContactFromLead).
 *                              No human step. Idempotent — a second positive
 *                              reply returns the SAME contact.
 *   "don't contact me"       → per-channel opt-out + DNC on the lead AND the
 *                              address-keyed suppression rows the send gates
 *                              actually read.
 *   neutral / unclear        → nothing. No conversion on ambiguity.
 *
 * All of the above lives in lib/lead-intent; this export is only the door.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTH. This file is `"use server"`, so this export is a public HTTP endpoint and
 * the message body it accepts becomes a lead's recorded words and can trigger a
 * conversion or a legally-binding suppression. It requires ONE of:
 *
 *   1. A trusted internal caller: `process.env.CRON_SECRET` is configured AND
 *      `internalSecret` matches it. Webhook ingress verifies the PROVIDER
 *      signature at the route layer and forwards CRON_SECRET here — the same
 *      contract app/actions/ai-isa/handle-inbound-email.ts documents and the
 *      inbound router already honours.
 *   2. An authenticated session whose brokerage owns the lead.
 *
 * In BOTH modes the lead is re-read WITH a brokerage predicate downstream, so a
 * forged leadId cannot reach another tenant. The session mode additionally proves
 * the lead is in the caller's brokerage through the ACTING client (ctx.db), so RLS applies
 * to the proof itself, and it fails CLOSED on a refused read.
 */
export async function ingestInboundLeadSignalAction(input: {
  brokerageId: string
  leadId: string
  channel: InboundLeadChannel
  body: string
  providerRef?: string | null
  occurredAt?: string
  context?: Record<string, unknown>
  /** True when the caller already ran the intent classifier for this message. */
  intentAlreadyRouted?: boolean
  /** Set by trusted internal callers (a signature-verified webhook route, cron). */
  internalSecret?: string
}): Promise<InboundLeadIntentResult> {
  if (!isValidUUID(input.leadId) || !isValidUUID(input.brokerageId)) {
    return { outcome: "skipped", reason: "invalid_ids" }
  }
  if (!INBOUND_LEAD_CHANNELS.has(input.channel)) {
    return { outcome: "skipped", reason: "unknown_channel" }
  }

  const cronSecret = process.env.CRON_SECRET
  const isTrustedInternal =
    !!cronSecret && !!input.internalSecret && input.internalSecret === cronSecret

  if (!isTrustedInternal) {
    const ctx = await resolveWriteContextForTenant()
    if (!ctx.ok) return { outcome: "skipped", reason: "unauthorized" }
    if (ctx.brokerageId !== input.brokerageId) return { outcome: "skipped", reason: "forbidden" }

    // Prove the lead is in the caller's tenant through the ACTING client (ctx.db):
    // the cookie/RLS client for a normal seat, the service client ONLY under an active
    // FULL impersonation grant — otherwise a support session's own proof read is
    // refused, and supabase-js resolves that as zero rows with `error: null`, which
    // reads as "no such lead". A refused read resolves as `{ data: null, error }` —
    // fail closed rather than reading a refusal as "no such lead".
    const supabase = ctx.db
    const { data, error } = await supabase
      .from("leads")
      .select("id")
      .eq("id", input.leadId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (error) return { outcome: "skipped", reason: "lead_scope_check_failed" }
    if (!data) return { outcome: "skipped", reason: "lead_not_in_tenant" }
  }

  return evaluateInboundLeadSignal({
    brokerageId: input.brokerageId,
    leadId: input.leadId,
    channel: input.channel,
    body: input.body,
    providerRef: input.providerRef ?? null,
    occurredAt: input.occurredAt,
    context: input.context,
    intentAlreadyRouted: input.intentAlreadyRouted,
  })
}

/**
 * ingestDirectMailResponseSignalAction — the DIRECT-MAIL half of the same door.
 *
 * A direct-mail response reaches this system as a row in `direct_mail_responses`
 * (response_type ∈ qr_scan | landing_visit | call | form_submit | reply |
 * appointment — CHECK-verified live). That table carries `contact_id` and has NO
 * `lead_id`, and neither of its writers (app/actions/direct-mail.ts `logResponse`,
 * app/api/qr/scan/route.ts) evaluates intent — so a LEAD's response to a mail
 * piece had nowhere to land and nothing to read it. Those two files are outside
 * this lane; this action is the door they need to call, and the shape of that call
 * is documented in the hand-off notes.
 *
 * HOW EACH RESPONSE TYPE IS TREATED, and why:
 *
 *   reply | form_submit | appointment  → a HAND-RAISE. The person deliberately
 *     answered the mail piece asking to be reached. If they wrote something, their
 *     words are what gets classified. If they wrote nothing, a SYSTEM-AUTHORED
 *     sentence describing what they did is classified instead — marked
 *     `system_authored` in the recorded metadata so it is never mistaken for a
 *     quote. It can still fail to convert, and correctly: `classifyAndRouteInbound`
 *     needs a buyer/seller side, and a lead whose side is unknown stays ambiguous
 *     rather than being converted as a guess.
 *
 *   call → NOT classified here. A lead calling the tracked number already rides
 *     lib/ai-isa/lead-call-intent.ts `routeLeadCallIntent`, which classifies the
 *     TRANSCRIPT — the person's actual words, which are strictly better evidence
 *     than "they dialled". Classifying here as well would double-spend the model
 *     on the same event. The response is recorded and the voice lane converts.
 *
 *   qr_scan | landing_visit → recorded, never classified. A scan is not a sentence.
 *     Inventing an intent from a page load is exactly the ambiguity the ruling says
 *     must not convert.
 */
export async function ingestDirectMailResponseSignalAction(input: {
  brokerageId: string
  leadId: string
  /** direct_mail_responses.response_type */
  responseType: "qr_scan" | "landing_visit" | "call" | "form_submit" | "reply" | "appointment"
  /** Anything the responder actually wrote (a reply card, a form's message field). */
  message?: string
  campaignId?: string
  /** direct_mail_responses.id, or the provider's reference — the idempotency key. */
  providerRef?: string | null
  internalSecret?: string
}): Promise<InboundLeadIntentResult> {
  const HAND_RAISE = new Set(["reply", "form_submit", "appointment"])
  const wrote = (input.message ?? "").trim()
  const isHandRaise = HAND_RAISE.has(input.responseType)

  // The system-authored stand-in for a wordless hand-raise. It states the fact
  // ("yes, they answered the mailer and asked to be contacted") in plain words the
  // deterministic keyword floor and the AI classifier both read the same way —
  // and it is TRUE of every response type it is used for.
  const SYSTEM_SENTENCE: Record<string, string> = {
    reply: "Yes — they replied to our mailer and are interested.",
    form_submit: "Yes — they filled in the form on our mailer and asked to be contacted.",
    appointment: "Yes — they booked an appointment from our mailer.",
    // Recorded, never classified (see the doc block) — but still recorded, so the
    // mail response is on the lead's timeline instead of vanishing.
    call: "They called the number on our mailer.",
    qr_scan: "They scanned the QR code on our mailer.",
    landing_visit: "They visited the landing page from our mailer.",
  }

  const body = wrote || SYSTEM_SENTENCE[input.responseType] || `Direct-mail response: ${input.responseType}`

  return ingestInboundLeadSignalAction({
    brokerageId: input.brokerageId,
    leadId: input.leadId,
    channel: "direct_mail",
    body,
    providerRef: input.providerRef ?? null,
    context: {
      response_type: input.responseType,
      campaign_id: input.campaignId ?? null,
      system_authored: !wrote,
    },
    // 'call' is owned by the voice lane's transcript classifier; scans and page
    // visits carry nothing to classify. Both are recorded and stop there.
    intentAlreadyRouted: !isHandRaise,
    internalSecret: input.internalSecret,
  })
}
