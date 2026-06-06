/**
 * lib/kernel/compliance.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 0 — Outbound compliance gate for the platform messaging pipeline.
 *
 * Gate execution order (fail-fast on authority; brand voice always runs):
 *   1. Brand Voice     — applyBrandVoice() from ./brand-voice
 *   2. TCPA Consent    — contacts.tcpa_consent for sms/phone channels
 *   3. Authority Rule  — representation / active transaction + ISA override
 *   4. Fair Housing    — FAIR_HOUSING_VIOLATIONS from rule-evaluators
 *   5. Them-First      — prohibited phrases + pronoun ratio from rule-evaluators
 *
 * Always writes one row to compliance_events regardless of outcome.
 * Does NOT call transitionLifecycle — callers own lifecycle transitions.
 * Does NOT rewrite content — returns correctedContent only as a suggestion
 * derived from suggested_fix values in violated rules.
 *
 * Import types from './types'. Use createClient from '@/lib/supabase/server'.
 */

import { createClient } from "@/lib/supabase/server"
import { applyBrandVoice } from "./brand-voice"
import { hasActiveRepresentation } from "./compliance/active-representation"
import type { EvaluateOutboundParams, ComplianceResult } from "./types"
import { KernelEvent } from "./events"
import { processKernelEvent } from "./notification-engine"

// ─── RE-USE EXISTING RULE SETS (do not duplicate) ────────────────────────────
// Import the pure-function evaluators that already own these rule arrays.

import {
  evaluateRegulatoryCompliance,
} from "@/lib/compliance-rules/rule-evaluators"

// Them-first check — reuse the prohibited phrase list from the validator.
// We call the synchronous helpers only; we do not call validateThemFirstContent
// (that spawns an LLM call which is not appropriate inside a synchronous gate).
import type { ContentType } from "@/lib/them-first/validator"

// ─── INTERNAL: FAIR HOUSING ───────────────────────────────────────────────────
// The FAIR_HOUSING_VIOLATIONS array is not exported from rule-evaluators,
// so we delegate to evaluateRegulatoryCompliance which runs it internally.
// We surface its violations through the gate.

// ─── INTERNAL: THEM-FIRST PROHIBITED PHRASES ─────────────────────────────────
// Duplicated from lib/them-first/validator.ts PROHIBITED_PHRASES so this file
// has no runtime dependency on the AI-model path in that file.
// If the source list changes, update here too.

const THEM_FIRST_PROHIBITED: Array<{ phrase: string; category: string }> = [
  { phrase: "you'd be crazy not to", category: "pushy" },
  { phrase: "limited time offer", category: "false_urgency" },
  { phrase: "this won't last long", category: "fear_based" },
  { phrase: "trust me", category: "ironic" },
  { phrase: "i'm the best agent", category: "ego_driven" },
  { phrase: "you need to act fast", category: "pushy" },
  { phrase: "don't miss out", category: "fear_based" },
  // fair_housing entries are already caught by Gate 4 — skip duplicates
  { phrase: "this is a great investment", category: "investment_advice" },
  { phrase: "guaranteed to appreciate", category: "investment_advice" },
  { phrase: "you'll make money", category: "investment_advice" },
]

function calculatePronounRatio(content: string): number {
  const buyerWords = (content.match(/\b(you|your|yours|imagine|feel|enjoy|benefit|discover|experience)\b/gi) || []).length
  const agentWords = (content.match(/\b(i|me|my|mine|we|us|our|ours)\b/gi) || []).length
  const total = buyerWords + agentWords
  if (total === 0) return 0.5
  return buyerWords / total
}

// ─── RESTRICTED CONTACT STATES ────────────────────────────────────────────────
// States where non-ISA actors are blocked from outbound messaging.

// Stored lower-case only; callers MUST normalize contact.status with
// .toLowerCase() before checking. A previous version listed mixed-case
// variants but exact-case Set.has() still failed open for any casing not
// explicitly enumerated (e.g. title-case "Representation" from a UI picker),
// silently allowing outreach to a represented contact — a compliance breach.
const RESTRICTED_STATES = new Set([
  "representation",
  "active_transaction",
  "under_contract",
])

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * evaluateOutbound
 *
 * Runs all five compliance gates in order against the provided content and
 * contact context, logs the result to compliance_events, and returns a
 * ComplianceResult. Throws only on unrecoverable DB errors.
 */
export async function evaluateOutbound(params: EvaluateOutboundParams): Promise<ComplianceResult> {
  const supabase = await createClient()
  const violations: string[] = []
  const suggestedFixes: string[] = []
  let correctedContent: string | undefined

  const { actorContext, journeyType, persona, messageType, content, contact } = params

  // ══════════════════════════════════════════════════════════════════════════
  // GATE 1 — Brand Voice
  // ══════════════════════════════════════════════════════════════════════════

  const brandResult = await applyBrandVoice({
    brokerageId: actorContext.brokerageId,
    teamId: actorContext.teamId,
    actorUserId: actorContext.userId,
    actorRole: actorContext.role,
    journeyType: journeyType === 'dual' ? 'buyer' : journeyType,
    persona,
    messageType,
    content,
  })

  for (const v of brandResult.violations) {
    violations.push(`BrandVoice: ${v}`)
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GATE 2 — TCPA Consent
  // Skipped for broadcast campaigns (contact = undefined).
  // ══════════════════════════════════════════════════════════════════════════

  // Re-fetch contact for all message types — per-channel opt-outs must be checked
  // regardless of channel, not just for SMS/phone.
  if (contact) {
    const { data: freshContact } = await supabase
      .from("contacts")
      .select("tcpa_consent, tcpa_consent_date, dnc_status, email_opt_out, sms_opt_out, phone_opt_out, direct_mail_opt_out")
      .eq("id", contact.id)
      .maybeSingle()

    const dncStatus = freshContact?.dnc_status ?? contact.dnc_status ?? false

    // Global DNC blocks all channels
    if (dncStatus) {
      violations.push("DNC: Contact is on the global Do Not Contact list")
    }

    // TCPA consent required for SMS/phone (only when not already blocked by DNC).
    // An active representation relationship (open transaction / signed agreement /
    // live offer) carries implied consent, so a client actively in a deal is
    // always reachable even if the standalone tcpa_consent flag was never set.
    if (!dncStatus && (messageType === "sms" || messageType === "phone")) {
      const tcpaConsent = freshContact?.tcpa_consent ?? contact.tcpa_consent ?? false
      const consentGiven =
        tcpaConsent ||
        (await hasActiveRepresentation(supabase, contact.id, actorContext.brokerageId))
      if (!consentGiven) {
        violations.push("TCPA: Contact has not consented to SMS/phone outreach")
      }
    }

    // Per-channel opt-out checks (applied on top of DNC — belt-and-suspenders)
    if (messageType === "email" && freshContact?.email_opt_out) {
      violations.push("OptOut: Contact has opted out of email communications")
    }
    if (messageType === "sms" && freshContact?.sms_opt_out) {
      violations.push("OptOut: Contact has opted out of SMS communications")
    }
    if (messageType === "phone" && freshContact?.phone_opt_out) {
      violations.push("OptOut: Contact has opted out of phone calls")
    }
    if (messageType === "direct_mail" && freshContact?.direct_mail_opt_out) {
      violations.push("OptOut: Contact has opted out of direct mail")
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GATE 3 — Authority Rule (ISA override allowed)
  // ═══��══════════════════════════════════���═══════════════════════════════════

  if (contact) {
    const contactStatus: string = (contact.status ?? "").toLowerCase()

    if (RESTRICTED_STATES.has(contactStatus)) {
      if (actorContext.role === "isa") {
        const isaReengageAllowed = contact.isa_reengage_allowed === true
        if (!isaReengageAllowed) {
          violations.push("Authority: Contact represented, ISA re-engagement not approved")
        }
      } else {
        violations.push("Authority: Contact in restricted state")
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GATE 4 — Fair Housing
  // Delegates to evaluateRegulatoryCompliance (owns the rule array).
  // ══════════════════════════════════════════════════════════════════════════

  const regulatoryViolations = evaluateRegulatoryCompliance({
    content_type: messageType,
    channel_intent: journeyType,
    raw_content: content,
    context: { persona },
  })

  for (const v of regulatoryViolations) {
    violations.push(`FairHousing: ${v.description}`)
    if (v.suggested_fix) {
      suggestedFixes.push(v.suggested_fix)
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GATE 5 — Them-First
  // Checks prohibited phrases and pronoun ratio (no LLM call).
  // ══════════════════════════════════════════════════════════════════════════

  const contentLower = content.toLowerCase()

  for (const item of THEM_FIRST_PROHIBITED) {
    if (contentLower.includes(item.phrase.toLowerCase())) {
      violations.push(`ThemFirst: Prohibited phrase "${item.phrase}" (${item.category})`)
    }
  }

  const pronounRatio = calculatePronounRatio(content)
  if (pronounRatio < 0.6) {
    violations.push(
      `ThemFirst: Content is only ${Math.round(pronounRatio * 100)}% contact-focused (target ≥60%). Reduce agent-centric language.`
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BUILD RESULT
  // ══════════════════════════════════════════════════════════════════════════

  const allowed = violations.length === 0
  const blockedReason = violations[0] ?? undefined

  // Surface a corrected content suggestion only if fixes are available.
  if (!allowed && suggestedFixes.length > 0) {
    correctedContent = suggestedFixes.join(" | ")
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LOG TO compliance_events (always — regardless of outcome)
  // Schema: id, brokerage_id, gate_name, allowed, violations (jsonb),
  //         blocked_reason, actor_role, entity_type, entity_id,
  //         actor_user_id, message_type, created_at
  // ══════════════════════════════════════════════════════════════════════════

  const { data: complianceEvent } = await supabase
    .from("compliance_events")
    .insert({
      brokerage_id: actorContext.brokerageId,
      gate_name: "outbound_compliance",
      allowed,
      violations: violations,            // jsonb — array stored as JSON
      blocked_reason: blockedReason ?? null,
      actor_role: actorContext.role,
      actor_user_id: actorContext.userId,
      entity_type: "contact",
      entity_id: contact?.id ?? null,
      message_type: messageType,
    })
    .select("id")
    .single()

  if (complianceEvent && !allowed) {
    // FAILURE ISOLATION: Notification processing is non-blocking
    // If processKernelEvent fails, it is logged but does NOT prevent compliance checks from completing
    // This ensures compliance evaluation ALWAYS succeeds even if notifications fail
    //
    // entityType/entityId routing: when a specific contact is present, route to that
    // contact row. For broadcast campaigns (no contact), route to "brokerage" so the
    // notification engine does not query the contacts table with a brokerage UUID.
    await processKernelEvent({
      event: KernelEvent.COMPLIANCE_VIOLATION,
      brokerageId: actorContext.brokerageId,
      entityType: params.contact ? "contact" : "brokerage",
      entityId: params.contact?.id ?? actorContext.brokerageId,
      complianceEventId: complianceEvent.id,
    }).catch(err => {
      console.error("[Compliance] Notification processing failed (non-blocking):", err)
      // INTENTIONAL: Do not rethrow. Compliance check must not be blocked by notification failure.
    })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RETURN
  // ══════════════════════════════════════════════════════════════════════════

  return {
    allowed,
    violations,
    blockedReason,
    correctedContent,
    complianceEventId: (complianceEvent?.id as string | undefined) ?? undefined,
  }
}
