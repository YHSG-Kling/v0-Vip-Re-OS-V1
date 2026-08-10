// lib/voice/outbound-call-gates.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PRE-DIAL GATE STACK FOR OUTBOUND AI CALLS — one ordered list, one runner.
//
// WHY THIS FILE EXISTS (wave 8, the outbound slice). Two functions used to place
// an outbound phone call and they carried DIFFERENT gates:
//
//   · lib/providers/dispatch.ts:dispatchPhone  — autonomy + checkSuppression
//     (contact flags AND contact_suppression_list) + evaluateOutboundCompliance
//     + de-conflict.  ZERO callers.  DELETED in this wave.
//   · lib/voice/twilio-outbound.ts:placeOutboundAiCall — TCPA chokepoint +
//     vendor budget + caller-ID honesty.  LIVE: this is what actually dials.
//
// The live one's TCPA gate (lib/communication/tcpa-gate.ts) reads the contact
// FLAG `contacts.dnc_status` and NEVER reads `contact_suppression_list`. So a
// contact suppressed via the LIST rather than the flag — the exact case
// dispatch.ts's own comment named — was still dialable by the AI outbound lane.
// That is a live TCPA/DNC exposure, not a tidiness problem.
//
// The three gates the orphan had and the survivor lacked are merged in here, in
// dispatch.ts's own order, and `placeOutboundAiCall` now runs THIS stack — so
// there is exactly ONE gate stack for outbound AI voice, not two.
//
// ORDER (deliberate, and asserted by scripts/outbound-call-gates-simulator.ts):
//   1. autonomy      — trust boundary. Cached posture read; refuses before any
//                      consumer data is touched. Opt-in by manager (see below).
//   2. suppression   — checkSuppression: contact flags (dnc_status /
//                      call_stop_flag) AND contact_suppression_list,
//                      brokerage-scoped. FAILS CLOSED (an unreadable list
//                      refuses the dial). THIS is the gate that closes the hole.
//   3. tcpa          — enforceTCPACompliance: consent / quiet hours / RND /
//                      phone status, and the compliance-log row plaintiff
//                      discovery reads. FAILS CLOSED. (Unchanged; it was the
//                      survivor's gate and is not weakened — it is now merely
//                      preceded by two cheaper refusals.)
//   4. deconflict    — over-touch suppression (default: 1 call / 7 days per
//                      contact), writes deconflict_suppression_log either way.
//   5. vendor_budget — the only gate about MONEY, so it runs last: budget must
//                      never mask a consumer-protection refusal, and a
//                      compliance refusal must never spend. FAILS OPEN by
//                      design (a broken budget system may not silence a
//                      compliant, consented call).
//
// NOTHING IN THIS MODULE DIALS. It has no connector import and no Twilio URL;
// the dial lives in twilio-outbound.ts AFTER the runner returns null. That is
// why "a gate after the Twilio call" is structurally impossible here rather
// than a convention someone has to remember.
//
// Every dependency is loaded with `await import` inside its gate — the idiom
// twilio-outbound.ts already uses — so importing this module (a proof, a
// simulator) never drags `server-only` or a service-role client into the graph.

import type { ManagerKey } from "@/lib/kernel/manager-registry"

/** Refusal in `PlaceOutboundResult`'s own shape (lib/voice/twilio-outbound.ts). */
export interface OutboundCallRefusal {
  ok: false
  error: string
  blocked?: boolean
  blockReason?: string
}

export interface OutboundCallGateContext {
  /** Tenant the call is scoped and billed to. Required — every gate is brokerage-scoped. */
  brokerageId: string
  /** The number being dialled (E.164). Also the suppression-list phone key. */
  toNumber: string
  contactId: string | null
  /** Unconverted LEAD origin, when there is one — gives the lead the same
   *  over-touch protection a contact gets (evaluateDeconflict counts lead
   *  touches from isa_outreach_log). */
  leadId?: string | null
  initiatedBy?: string | null
  /** TCPA-transactional (recipient-initiated) — relaxes express-written-consent
   *  ONLY. DNC, quiet hours, suppression and over-touch all still apply. */
  transactional?: boolean
  /** Attribution for the de-conflict audit row, and the fallback signal the
   *  autonomy gate infers a manager from (SYSTEM_SOURCE_TO_MANAGER). */
  systemSource?: string
  /** The governed AI manager placing this call. Set ONLY for autonomous
   *  (unattended) manager calls — it ARMS the autonomy gate. Leave unset for a
   *  human-initiated dial: an agent clicking "call" is not an unattended send
   *  and must never be held. Absent manager ⇒ gate is a no-op, by design. */
  managerKey?: ManagerKey | null
  /** A human approved this call (approval queue) — bypasses the autonomy gate. */
  humanApproved?: boolean
  /** Minutes to price the budget pre-flight against. Default 3 (the figure the
   *  Twilio-native lane has always estimated for an AI ISA call). */
  estimatedMinutes?: number
}

export type OutboundCallGateKey =
  | "autonomy"
  | "suppression"
  | "tcpa"
  | "deconflict"
  | "vendor_budget"

export interface OutboundCallGate {
  key: OutboundCallGateKey
  /** True when this gate exists to protect the RECIPIENT (consumer protection).
   *  False for the spend ceiling. Every consumer-protection gate must precede
   *  every spend gate — the property the proof asserts, rather than a literal
   *  index. */
  consumerProtection: boolean
  run: (ctx: OutboundCallGateContext) => Promise<OutboundCallRefusal | null>
}

// ─── 1. AUTONOMY — the autonomous-send trust boundary ─────────────────────────
// Carried across from dispatch.ts:autonomyGate with its semantics intact: only a
// governed MANAGER acting unattended is gated; a human-approved send bypasses;
// absence of a posture signal ALLOWS (an unconfigured manager keeps working).
// An explicit `autonomous` posture is additionally contingent on the domain's
// measured prediction-accuracy rail, and that hold is ledgered.
async function runAutonomyGate(ctx: OutboundCallGateContext): Promise<OutboundCallRefusal | null> {
  const {
    managerForDispatch, resolveManagerAutonomy, autonomyDecision, HUMAN_APPROVED_SYSTEM_SOURCE,
  } = await import("@/lib/managers/autonomy-gate")

  const managerKey = managerForDispatch(ctx.managerKey ?? null, ctx.systemSource)
  if (!managerKey) return null

  const humanApproved = ctx.humanApproved === true || ctx.systemSource === HUMAN_APPROVED_SYSTEM_SOURCE
  const effective = await resolveManagerAutonomy(ctx.brokerageId, managerKey)

  let accuracyGate: { held: boolean; reason: string | null } | undefined
  if (effective === "autonomous" && !humanApproved) {
    try {
      const { loadAccuracyHoldForManager } = await import("@/lib/managers/accuracy-gate")
      accuracyGate = await loadAccuracyHoldForManager(ctx.brokerageId, managerKey, undefined, {
        record: true,
        systemSource: ctx.systemSource,
      })
    } catch { accuracyGate = undefined }
  }

  const decision = autonomyDecision({ managerKey, effective, humanApproved, accuracyGate })
  if (decision.allow) return null
  return {
    ok: false,
    error: `Outbound held: ${decision.reason}`,
    blocked: true,
    blockReason: "autonomy_held",
  }
}

// ─── 2. SUPPRESSION — the list-aware gate the live lane never had ─────────────
// checkSuppression reads BOTH the contact flags (dnc_status / call_stop_flag)
// and contact_suppression_list, brokerage-scoped, and FAILS CLOSED on a refused
// read (supabase-js resolves a refused query, so both reads destructure `error`
// and a read failure returns suppressed=true).
//
// FIXED AT THE SURVIVOR, not ported: dispatchPhone only ran this when it had a
// contactId or leadId, so a number-only dial skipped the suppression list
// entirely. Here the check always runs — `toNumber` is always present and is
// itself a suppression-list key, so a phone suppressed with no contact row
// attached is caught.
async function runSuppressionGate(ctx: OutboundCallGateContext): Promise<OutboundCallRefusal | null> {
  const { checkSuppression } = await import("@/lib/kernel/compliance/check-suppression")
  const suppression = await checkSuppression({
    brokerageId: ctx.brokerageId,
    contactId: ctx.contactId ?? null,
    email: null,
    phone: ctx.toNumber ?? null,
    channel: "phone",
  })
  if (!suppression.suppressed) return null
  return {
    ok: false,
    error: `Outbound blocked: ${suppression.reason}`,
    blocked: true,
    blockReason: "suppressed",
  }
}

// ─── 3. TCPA — the survivor's own chokepoint, unchanged ───────────────────────
// Consent / quiet hours / RND staleness / phone status, and the
// outbound_message_compliance_log row that exists for plaintiff discovery and
// state RE commission audits. Fails closed.
async function runTcpaGate(ctx: OutboundCallGateContext): Promise<OutboundCallRefusal | null> {
  const { enforceTCPACompliance } = await import("@/lib/communication/tcpa-gate")
  const gate = await enforceTCPACompliance({
    channel: "call",
    phone: ctx.toNumber,
    contactId: ctx.contactId,
    brokerageId: ctx.brokerageId,
    initiatedBy: ctx.initiatedBy ?? null,
    transactional: ctx.transactional ?? false,
  })
  if (gate.allowed) return null
  return {
    ok: false,
    error: gate.message ?? "TCPA gate blocked the call",
    blocked: true,
    blockReason: gate.blockReason,
  }
}

// ─── 4. DE-CONFLICT — over-touch suppression ──────────────────────────────────
// The De-Conflict Engine counts this contact's (or lead's) recent PHONE touches
// across every ledger the platform owns and defers one call too many. Default
// policy: 1 call / 7 days. Writes one deconflict_suppression_log row either way,
// which is what the broker cockpit reads.
async function runDeconflictGate(ctx: OutboundCallGateContext): Promise<OutboundCallRefusal | null> {
  if (!ctx.contactId && !ctx.leadId && !ctx.toNumber) return null
  const { evaluateDeconflict } = await import("@/lib/kernel/deconflict")
  const { DECONFLICT_GATE_KEY } = await import("@/lib/campaign-sequences/deferral-policy")
  const decision = await evaluateDeconflict({
    brokerageId: ctx.brokerageId,
    channel: "phone",
    contactId: ctx.contactId ?? null,
    leadId: ctx.leadId ?? null,
    recipientPhone: ctx.toNumber ?? null,
    systemSource: ctx.systemSource ?? "twilio_outbound",
  })
  if (decision.allowed) return null
  return {
    ok: false,
    error: `Outbound deferred: ${decision.reason}`,
    blocked: true,
    blockReason: DECONFLICT_GATE_KEY,
  }
}

// ─── 5. VENDOR BUDGET — the survivor's spend ceiling, unchanged ───────────────
// Over-ceiling tenants pause outbound voice. FAILS OPEN on its own breakage:
// a budget system that cannot answer must never silence a compliant call, and
// only an AFFIRMATIVE over-ceiling verdict blocks. Last in the stack because it
// is the only gate about money.
async function runVendorBudgetGate(ctx: OutboundCallGateContext): Promise<OutboundCallRefusal | null> {
  try {
    const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
    const { estimatePlatformVendorCost } = await import("@/lib/vendor-governance/meter-vendor")
    const budget = await checkVendorBudget({
      brokerageId: ctx.brokerageId,
      addCost: estimatePlatformVendorCost("twilio_voice", ctx.estimatedMinutes ?? 3),
    })
    if (!budget.allowed) {
      return {
        ok: false,
        error: "Vendor budget exceeded — outbound voice paused",
        blocked: true,
        blockReason: "vendor_budget_exceeded",
      }
    }
  } catch { /* budget read failure never blocks a compliant call */ }
  return null
}

/**
 * THE stack. Order is the contract — see the header. Exported as data so a proof
 * can assert the ordering property (every consumer-protection gate before the
 * spend gate) against the real list rather than against the spelling of a
 * function body.
 */
export const OUTBOUND_CALL_GATES: readonly OutboundCallGate[] = [
  { key: "autonomy",      consumerProtection: true,  run: runAutonomyGate },
  { key: "suppression",   consumerProtection: true,  run: runSuppressionGate },
  { key: "tcpa",          consumerProtection: true,  run: runTcpaGate },
  { key: "deconflict",    consumerProtection: true,  run: runDeconflictGate },
  { key: "vendor_budget", consumerProtection: false, run: runVendorBudgetGate },
]

/** The declared order, for readiness surfaces and proofs. */
export const OUTBOUND_CALL_GATE_ORDER: readonly OutboundCallGateKey[] =
  OUTBOUND_CALL_GATES.map((g) => g.key)

/**
 * Run every pre-dial gate in order and return the FIRST refusal, or null when
 * the call may proceed. Short-circuits: a refusal means no later gate runs, so
 * a compliance refusal never reaches the spend ceiling and never dials.
 *
 * `gates` is a test seam (the proof injects synthetic gates to prove the
 * short-circuit); production callers pass one argument.
 */
export async function runOutboundCallGates(
  ctx: OutboundCallGateContext,
  gates: readonly OutboundCallGate[] = OUTBOUND_CALL_GATES,
): Promise<OutboundCallRefusal | null> {
  for (const gate of gates) {
    const refusal = await gate.run(ctx)
    if (refusal) return refusal
  }
  return null
}
