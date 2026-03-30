// lib/kernel/communications.ts
// LAYER 0 — Outbound communication eligibility gate.
//
// Single export: evaluateOutboundEligibility()
//
// Execution order (fail-fast):
//   1. Suppression pre-check (contact flags + contact_suppression_list)
//   2. Full compliance gate via evaluateOutbound() (brand, TCPA, authority, fair housing, them-first)
//
// This file calls evaluateOutbound() with the CORRECT EvaluateOutboundParams shape.
// Never use the flat enforceCompliance() wrapper for real contact sends —
// use this function instead.
//
// Import from '@/lib/kernel' — never import this file directly outside the kernel.

"use server"

import { evaluateOutbound } from "./compliance"
import { checkSuppression } from "./compliance/check-suppression"
import type {
  EvaluateOutboundParams,
  ComplianceResult,
  KernelContact,
  ActorContext,
  JourneyType,
  Persona,
  MessageType,
} from "./types"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface EvaluateOutboundEligibilityParams {
  /** Full actor context (userId, role, brokerageId) */
  actorContext: ActorContext
  /** Contact being messaged — must be a KernelContact shape */
  contact: KernelContact
  /** Content being sent */
  content: string
  /** Channel / message type */
  messageType: MessageType
  /** Journey context for compliance scoring */
  journeyType?: JourneyType
  /** Contact persona for brand voice and fair housing checks */
  persona?: Persona
}

export interface OutboundEligibilityResult {
  /** Whether the message is allowed to be sent */
  eligible: boolean
  /** Human-readable reason when not eligible */
  reason?: string
  /** Suppression-specific block (checked before full compliance) */
  suppressedBy?: string
  /** Full compliance result for logging / UI display */
  compliance: ComplianceResult
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * evaluateOutboundEligibility
 *
 * The canonical gate for any outbound send.
 * Runs suppression pre-check first (fast, DB-only) then full compliance evaluation.
 * Returns a structured result — never throws.
 *
 * Usage in a Server Action:
 * ```ts
 * const eligibility = await evaluateOutboundEligibility({
 *   actorContext: ctx.actorContext,
 *   contact: kernelContact,
 *   content: emailBody,
 *   messageType: "email",
 * })
 * if (!eligibility.eligible) return { error: eligibility.reason }
 * // proceed with send
 * ```
 */
export async function evaluateOutboundEligibility(
  params: EvaluateOutboundEligibilityParams
): Promise<OutboundEligibilityResult> {
  const NOT_ELIGIBLE_BASE: ComplianceResult = {
    allowed: false,
    violations: [],
    blockedReason: undefined,
    correctedContent: undefined,
  }

  try {
    // ── STAGE 1: Suppression pre-check ───────────────────────────────────────
    // Fast check against contact flags and contact_suppression_list.
    // If suppressed, skip the full compliance gate (no LLM calls, no writes).
    const suppressionChannel = messageTypeToSuppressionChannel(params.messageType)
    if (suppressionChannel) {
      const suppression = await checkSuppression({
        brokerageId: params.actorContext.brokerageId,
        contactId:   params.contact.id || null,
        email:       params.contact.email ?? null,
        phone:       params.contact.phone ?? null,
        channel:     suppressionChannel,
      })

      if (suppression.suppressed) {
        return {
          eligible:     false,
          reason:       suppression.reason ?? "Contact is suppressed",
          suppressedBy: suppression.reason,
          compliance:   {
            ...NOT_ELIGIBLE_BASE,
            violations:    [suppression.reason ?? "suppressed"],
            blockedReason: suppression.reason,
          },
        }
      }
    }

    // ── STAGE 2: Full compliance gate ─────────────────────────────────────────
    const outboundParams: EvaluateOutboundParams = {
      actorContext: params.actorContext,
      journeyType:  params.journeyType ?? inferJourneyType(params.contact),
      persona:      params.persona ?? (params.contact.persona ?? "other"),
      messageType:  params.messageType,
      content:      params.content,
      contact:      params.contact,
    }

    const compliance = await evaluateOutbound(outboundParams)

    return {
      eligible:  compliance.allowed,
      reason:    compliance.allowed ? undefined : (compliance.blockedReason ?? compliance.violations[0]),
      compliance,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Eligibility check failed"
    return {
      eligible:  false,
      reason:    message,
      compliance: {
        ...NOT_ELIGIBLE_BASE,
        violations:    [message],
        blockedReason: message,
      },
    }
  }
}

// ─── INTERNAL HELPERS ────────────────────────────────────────────────────────

function messageTypeToSuppressionChannel(
  messageType: MessageType
): import("./compliance/check-suppression").SuppressionChannel | null {
  switch (messageType) {
    case "email":       return "email"
    case "sms":         return "sms"
    case "phone":       return "phone"
    case "direct_mail": return "mail"
    default:            return null  // in_app, ai, social — no suppression list lookup
  }
}

function inferJourneyType(contact: KernelContact): JourneyType {
  if (contact.contact_type === "seller") return "seller"
  if (contact.contact_type === "both")   return "dual"
  return "buyer"
}
