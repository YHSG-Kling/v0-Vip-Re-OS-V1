/**
 * lib/lead-intent/inbound-lead-intent.ts
 *
 * THE ONE DOOR EVERY INBOUND MESSAGE FROM A LEAD GOES THROUGH.
 *
 * The owner's ruling: "leads are not assigned to any [agent] just the brokerage
 * and the inbound messages from a lead has to be received for intent and needs to
 * be evaluated in case they are ready for an agent to convert or doesn't want to
 * be contacted. leads converting should be automatic as soon as positive feedback
 * is returned or a positive response from inbound calls/texts, email or direct
 * mail."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS ALREADY THERE, AND WHAT WAS NOT
 *
 * The intent classifier and the conversion lane BOTH already exist and are NOT
 * rebuilt here:
 *
 *   lib/ai-isa/inbound-intent-classifier.ts  classifyAndRouteInbound
 *     → convertSellerLeadOnIntent / convertBuyerLeadOnIntent
 *     → app/actions/ai-isa/accept-handoff.ts  acceptAIISAHandoff
 *     → lib/lead-assignment/assignment-engine.ts  evaluateAndAssignLead   ← LANE 2
 *     → lib/kernel/lead-acquisition-handlers.ts  handleLeadAssigned
 *     → lib/contact-promotion/contact-creator.ts  createContactFromLead
 *
 * What was missing was COVERAGE. Traced across the four channels the ruling names:
 *
 *   EMAIL   ✓ app/api/providers/inbound/route.ts:333 → processInboundEmail →
 *             classifyAndRouteInbound.
 *   VOICE   ✓ lib/ai-isa/lead-call-intent.ts routeLeadCallIntent, fired from the
 *             Twilio status callback when the call row closes.
 *   SMS     ✗ THE GAP. The same inbound router matches a texting lead at Step 4
 *             (route.ts:85-108, `leads` by phone_digits) and records a lifecycle
 *             event — but the intent branch at Step 8b is guarded on
 *             `inbound.fromEmail`, which an SMS never has. A lead who texted
 *             "yes, I'm interested" was matched, logged, and then dropped. It
 *             could not convert, ever.
 *   MAIL    ✗ THE OTHER GAP. `direct_mail_responses` carries `contact_id` and no
 *             `lead_id` at all (live schema), and its writers
 *             (app/actions/direct-mail.ts logResponse, app/api/qr/scan/route.ts)
 *             evaluate no intent. A lead's mail response has nowhere to land and
 *             nothing to read it. This door accepts one; the two writers need a
 *             one-argument pass-through to reach it (reported, not edited — those
 *             files are outside this lane).
 *
 * So this module is the SHARED PATH, not a fifth implementation: it records the
 * message, decides opt-out vs positive vs neutral ONCE, and hands positive intent
 * to the lane above.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THRESHOLDS, STATED
 *
 *   OPT-OUT  → `detectOptOutIntent(body)` returning `confidence === "high"`.
 *              Binding suppression is written (flags + the address-keyed
 *              suppression rows) and the message NEVER reaches the classifier.
 *              A "medium" reading is deliberately NOT auto-suppressed: the
 *              channel patterns are substring regexes and a global DNC is
 *              hard to reverse, so a medium hit is held — no suppression, and
 *              equally NO conversion — for the human review the inbound router
 *              already raises (route.ts:255, smart_assistant_suggestions +
 *              a compliance notification).
 *
 *   POSITIVE → whatever `classifyAndRouteInbound` calls positive, unchanged:
 *              an AI label from a strict 9-value enum instructed to answer
 *              "none" when unsure, with the PURE `keywordIntentFallback` phrase
 *              list as the deterministic floor when the model errors or returns
 *              an unrecognised label. A bare positive ("yes, sounds good") with
 *              no known buyer/seller side classifies as AMBIGUOUS, not positive.
 *
 *   NEUTRAL  → nothing happens. No conversion, no suppression. The classifier
 *              records a nurture touch and the lead keeps being nurtured.
 *
 *   REOPEN   → OWNER RULING, settled: a CLEAR POSITIVE from a lead already under
 *              a consent stop REOPENS them automatically. The inbound message is
 *              the consent signal — they re-initiated contact. Three things keep
 *              it honest: opt-out detection above still runs first and still wins
 *              (a "stop" can never be read as a reopen); only a clear positive
 *              from the ONE classifier qualifies (ambiguous stays held); and the
 *              reopen is written to the SAME lifecycle_events ledger the opt-out
 *              is, carrying the message text that justified it, what/who reopened
 *              and when (lib/lead-intent/lead-opt-out.ts reopenLeadOnInboundConsent).
 *              A reopen restores REACHABILITY, never TCPA consent — tcpa_consent
 *              is deliberately untouched, so sms/phone stay gated by Rule 7.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCE — three independent guards, none of them assumed
 *
 *   1. THE MESSAGE. Every inbound is recorded on `lead_conversation_history`
 *      BEFORE it is evaluated, carrying `metadata.provider_ref`. m488 added
 *      `lead_conversation_history_provider_ref_uniq` — a partial unique index on
 *      (lead_id, metadata->>'provider_ref') — so a retried webhook is refused by
 *      the DATABASE at the recorder, before a second model call or a second
 *      suppression write can happen. Proven live in the migration.
 *   2. THE CONVERSION. `acceptAIISAHandoff` (accept-handoff.ts:63) returns the
 *      existing `leads.contact_id` and creates nothing when it is already set.
 *      A second positive reply cannot make a second contact.
 *   3. THIS DOOR. It reads `leads.contact_id` itself and short-circuits to
 *      `already_converted` without spending a model call at all.
 *
 * NOTE ON `leads.converted_at`: the parent brief named it as a guard. It is not
 * one today — NOTHING in the tree writes it (only lib/platform/demo-tenant.ts
 * seeds it, and lib/agents/referral-closer.ts writes the unrelated
 * `referrals.converted_at`). `handleLeadAssigned` now stamps it, so it becomes a
 * real guard going forward; `contact_id` is the guard that was already true.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { bestEffort } from "@/lib/db/best-effort"
import { detectOptOutIntent } from "@/lib/ai-isa/opt-out-utils"
import {
  applyLeadOptOut,
  reopenLeadOnInboundConsent,
  type LeadOptOutChannel,
  type LeadOptOutSource,
} from "./lead-opt-out"

/** The transport an inbound lead message arrived on — the four the ruling names. */
export type InboundLeadChannel = "email" | "sms" | "voice" | "direct_mail"

export interface InboundLeadSignal {
  brokerageId: string
  leadId: string
  channel: InboundLeadChannel
  /** The lead's own words: SMS body, email body, call transcript, mail-response note. */
  body: string
  /** Provider message id (Twilio MessageSid, provider message id, response row id).
   *  When present it is the idempotency key m488 enforces. */
  providerRef?: string | null
  occurredAt?: string
  /** Free-form provenance kept on the recorded message (campaign id, response type…). */
  context?: Record<string, unknown>
  /**
   * TRUE when the CALLER has already run `classifyAndRouteInbound` for this exact
   * message. The email lane has: the inbound router hands the body to
   * `processInboundEmail`, which classifies, auto-replies and routes. Passing
   * `true` records the message and evaluates the opt-out — which that lane does
   * NOT bind — and stops short of a second classification (a second model spend
   * and a second nurture activity for one message).
   */
  intentAlreadyRouted?: boolean
}

export type InboundLeadOutcome =
  /** A retry of a message already recorded — nothing re-run. */
  | "duplicate"
  /** High-confidence "don't contact me": suppression written, never classified. */
  | "opted_out"
  /** Medium-confidence opt-out: held for the human review the router raises. No convert. */
  | "held_for_review"
  /** Clear positive intent — converted through the canonical lane. */
  | "converted"
  /** Already a contact before this message; recorded, not re-converted. */
  | "already_converted"
  /** Negative (but not an opt-out phrase) — engagement halted by the classifier. */
  | "halted"
  /** Ambiguous / no clear intent — nurture touch recorded, nothing else. */
  | "nurtured"
  /** An opted-out lead came back with CLEAR positive intent: suppression lifted,
   *  the reopen recorded on the compliance ledger, and the lead converted. */
  | "reopened"
  /** Nothing to do (no body, lead not found, classification deferred to the caller). */
  | "skipped"

export interface InboundLeadIntentResult {
  outcome: InboundLeadOutcome
  /** contacts.id when this message converted the lead (or when it already had one). */
  contactId?: string
  /** The channel(s) suppressed, when the outcome was opted_out. */
  optOutChannels?: string[]
  /** Why we stopped where we did. */
  reason?: string
  error?: string
}

/** The inbound transport → the opt-out writer's provenance vocabulary. */
const OPT_OUT_SOURCE: Record<InboundLeadChannel, LeadOptOutSource> = {
  email: "inbound_email",
  sms: "inbound_sms",
  voice: "inbound_call",
  direct_mail: "inbound_direct_mail",
}

/**
 * evaluateInboundLeadSignal — receive an inbound message from a LEAD, evaluate
 * its intent, and act.
 *
 * Never throws: every caller is a provider webhook, and a 500 makes the provider
 * retry the whole delivery. Failures come back in `error` with an honest outcome.
 */
export async function evaluateInboundLeadSignal(
  signal: InboundLeadSignal,
): Promise<InboundLeadIntentResult> {
  try {
    const supabase = createServiceClient()
    const body = (signal.body ?? "").trim()
    if (!body) return { outcome: "skipped", reason: "empty_body" }

    // ── Read the lead. TENANT: brokerage_id is in the predicate — the service
    // client bypasses RLS, so a lead id alone would cross tenants. A refused read
    // resolves as { data: null, error }; report it rather than reading it as "no
    // such lead", which would silently drop a real consumer message.
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, brokerage_id, contact_id, dnc_status, is_active")
      .eq("id", signal.leadId)
      .eq("brokerage_id", signal.brokerageId)
      .maybeSingle()

    if (leadError) {
      return { outcome: "skipped", reason: "lead_read_refused", error: leadError.message }
    }
    if (!lead) {
      return { outcome: "skipped", reason: "lead_not_found" }
    }

    // ── 1. RECORD FIRST — the recorder is the idempotency guard (m488) ────────
    const recorded = await recordInboundLeadMessage(supabase, signal, body)
    if (recorded === "duplicate") {
      return { outcome: "duplicate", reason: "provider_ref_already_recorded" }
    }

    // ── 2. OPT-OUT, ahead of everything ──────────────────────────────────────
    // A request to be left alone is never a conversion signal, and it must not be
    // able to lose a race with one. This runs before the classifier and before
    // the already-converted short-circuit — a converted lead's inbound STOP still
    // has to bind.
    const optOut = detectOptOutIntent(body)
    if (optOut.isOptOut && optOut.confidence === "high") {
      const channel: LeadOptOutChannel = optOut.channel === "all" ? "all" : optOut.channel
      const applied = await applyLeadOptOut({
        brokerageId: signal.brokerageId,
        leadId: signal.leadId,
        channel,
        source: OPT_OUT_SOURCE[signal.channel],
        rawMessage: body,
      })
      if (!applied.applied) {
        // The request was real and the write did not land. Say so — the caller
        // logs it, and the outcome is NOT reported as honoured.
        return {
          outcome: "skipped",
          reason: "opt_out_write_failed",
          error: applied.error,
        }
      }
      return {
        outcome: "opted_out",
        optOutChannels: applied.channelsSuppressed,
        reason: applied.globalDNC ? "global_dnc" : "channel_opt_out",
      }
    }

    if (optOut.isOptOut) {
      // MEDIUM confidence. Not suppressed (a false global DNC is close to
      // irreversible and these patterns are substring regexes), and equally not
      // converted — an ambiguous "stop" is not positive feedback. The inbound
      // router already raises the human review for this case.
      return { outcome: "held_for_review", reason: `possible_opt_out_${optOut.channel}` }
    }

    // ── 3. AN OPTED-OUT LEAD WHO CAME BACK ───────────────────────────────────
    //
    // OWNER RULING: a positive reply from an opted-out lead REOPENS them
    // automatically. The inbound message is the consent signal — the person
    // re-initiated contact — and the reopen is RECORDED on the same ledger the
    // opt-out is, never silent.
    //
    // THREE THINGS GUARD IT, IN THIS ORDER:
    //   • Step 2 above already ran and did not fire. Opt-out detection still wins:
    //     a message saying "stop" is suppressed there and never reaches this line.
    //   • Only a CLEAR POSITIVE reopens. "Clear positive" is not redefined here —
    //     it is whatever the ONE existing classifier
    //     (lib/ai-isa/inbound-intent-classifier.ts) converts on. Ambiguous and
    //     negative both leave the lead held, exactly as before.
    //   • The reopen write is CHECKED. A refused reopen is reported, never
    //     reported as honoured.
    //
    // ORDER, STATED HONESTLY: the classifier is the only entry point that both
    // classifies and routes — it converts as part of saying "this was positive" —
    // so the conversion lands a moment BEFORE the suppression is lifted. That is
    // the safe direction: if the reopen write then fails, the lead is a contact
    // whose sends are still blocked by every gate. The reverse order (lift first,
    // classify second) would un-suppress a person on a message that turns out to
    // be ambiguous. See the lane report for the one-line export in the classifier
    // module that would let this decide before it acts.
    const isDNC = (lead as { dnc_status?: boolean | null }).dnc_status === true

    if (isDNC && signal.intentAlreadyRouted) {
      // The caller (the email lane) already classified and routed this message and
      // did not tell us its verdict. We cannot claim a clear positive we never saw,
      // and a consent stop is not lifted on an assumption.
      return { outcome: "held_for_review", reason: "lead_is_dnc_verdict_not_visible" }
    }

    if (isDNC) {
      const routed = await routeInboundIntent(supabase, signal, body)
      if (routed.outcome !== "converted" || !routed.classified) {
        // Ambiguous, negative, or a failed conversion — the stop stands.
        return {
          outcome: "held_for_review",
          reason: `lead_is_dnc_no_clear_positive_intent (classifier: ${routed.outcome}${routed.reason ? `/${routed.reason}` : ""})`,
          error: routed.error,
        }
      }

      const reopened = await reopenLeadOnInboundConsent({
        brokerageId: signal.brokerageId,
        leadId: signal.leadId,
        source: OPT_OUT_SOURCE[signal.channel],
        rawMessage: body,
        intent: { side: routed.classified.side, reason: routed.classified.reason },
        providerRef: signal.providerRef ?? null,
      })

      if (!reopened.reopened) {
        // The lead converted but the suppression could NOT be lifted. Say so —
        // the person is still suppressed on every gate, which is the safe state,
        // and the caller logs a reopen that needs a human.
        return {
          outcome: "held_for_review",
          contactId: routed.contactId,
          reason: "reopen_write_failed",
          error: reopened.error,
        }
      }

      return {
        outcome: "reopened",
        contactId: routed.contactId,
        reason: reopened.recorded
          ? "positive_intent_from_opted_out_lead — suppression lifted and recorded"
          : "positive_intent_from_opted_out_lead — suppression lifted, compliance record REFUSED",
        error: reopened.error,
      }
    }

    // ── 4. Already a contact — record, don't re-convert, don't spend a model call ─
    const existingContactId = (lead as { contact_id?: string | null }).contact_id ?? null
    if (existingContactId) {
      return {
        outcome: "already_converted",
        contactId: existingContactId,
        reason: "leads.contact_id already set",
      }
    }

    // ── 5. The caller already classified this message (the email lane) ───────
    if (signal.intentAlreadyRouted) {
      return { outcome: "skipped", reason: "intent_routed_by_caller" }
    }

    // ── 6. INTENT — the existing classifier, unchanged ───────────────────────
    const routed = await routeInboundIntent(supabase, signal, body)

    return {
      outcome:
        routed.outcome === "converted"
          ? routed.alreadyConverted
            ? "already_converted"
            : "converted"
          : routed.outcome === "halted"
          ? "halted"
          : routed.outcome === "nurtured"
          ? "nurtured"
          : "skipped",
      contactId: routed.contactId,
      reason: routed.reason,
      error: routed.error,
    }
  } catch (err) {
    // A provider webhook must never 500 on us — a non-2xx makes it retry the
    // whole delivery, and a retry storm loses every other message behind it.
    console.error("[inbound-lead-intent] evaluation failed:", err)
    return {
      outcome: "skipped",
      reason: "unexpected_error",
      error: err instanceof Error ? err.message : "evaluation failed",
    }
  }
}

/**
 * routeInboundIntent — run THE classifier and write the "which message caused it"
 * audit row. Extracted so the ordinary path (step 6) and the opted-out-lead reopen
 * path (step 3) run the SAME classification with the SAME audit; a second call
 * site with its own copy is how two thresholds end up disagreeing about one
 * sentence.
 *
 * Positive → the canonical lane converts. Negative → halted. Ambiguous →
 * nurtured. This module adds no scoring of its own.
 */
async function routeInboundIntent(
  supabase: ReturnType<typeof createServiceClient>,
  signal: InboundLeadSignal,
  body: string,
) {
  const { classifyAndRouteInbound } = await import("@/lib/ai-isa/inbound-intent-classifier")
  const routed = await classifyAndRouteInbound({
    leadId: signal.leadId,
    brokerageId: signal.brokerageId,
    message: body,
  })

  if (routed.outcome === "converted" && !routed.alreadyConverted) {
    await bestEffort(
      supabase.from("lifecycle_events").insert({
        brokerage_id: signal.brokerageId,
        entity_type: "lead",
        entity_id: signal.leadId,
        event_type: "LEAD_CONVERTED_ON_INBOUND_INTENT",
        metadata: {
          channel: signal.channel,
          provider_ref: signal.providerRef ?? null,
          side: routed.classified?.side ?? null,
          intent_reason: routed.classified?.reason ?? null,
          contact_id: routed.contactId ?? null,
        },
        created_at: new Date().toISOString(),
      }),
      "inbound-intent conversion audit row — the conversion lane already wrote LEAD_ASSIGNED + LEAD_CONVERTED_TO_CONTACT; this one records WHICH inbound message caused it and must not unwind the conversion",
    )
  }

  return routed
}

/**
 * recordInboundLeadMessage — land the message on the ONE lead-keyed inbound
 * table, and let the database say whether it is a retry.
 *
 * `lead_conversation_history` was a writer-less legacy table (noted as such at
 * app/actions/ai-chat.ts:1021). It is exactly the right shape — lead_id NOT NULL,
 * brokerage_id, channel, direction, message_content, metadata, occurred_at — and
 * it is the only place a LEAD's inbound message can live at all: `messages` is
 * conversation/contact-keyed, and `direct_mail_responses` has no lead_id. Adopting
 * it beats inventing a fifth table for the same rows.
 *
 * Returns "duplicate" when m488's partial unique index refuses the insert
 * (23505), which is the retry signal. Any OTHER refusal is logged and treated as
 * "recorded" — losing the transcript of a message must never stop the system from
 * honouring an opt-out inside it.
 */
async function recordInboundLeadMessage(
  supabase: ReturnType<typeof createServiceClient>,
  signal: InboundLeadSignal,
  body: string,
): Promise<"recorded" | "duplicate"> {
  const { error } = await supabase.from("lead_conversation_history").insert({
    lead_id: signal.leadId,
    brokerage_id: signal.brokerageId,
    channel: signal.channel,
    direction: "inbound",
    message_content: body.slice(0, 8000),
    metadata: {
      ...(signal.context ?? {}),
      provider_ref: signal.providerRef ?? null,
      source: OPT_OUT_SOURCE[signal.channel],
    },
    occurred_at: signal.occurredAt ?? new Date().toISOString(),
  })

  if (!error) return "recorded"

  // 23505 = unique_violation → m488's (lead_id, provider_ref) index. This is the
  // retried webhook, and it is the ONE error that means "stop, already handled".
  if (error.code === "23505") return "duplicate"

  console.error("[inbound-lead-intent] message record refused:", error.message)
  return "recorded"
}
