// lib/forms/esign-anchor-eval.ts
//
// E-SIGN ANCHOR EVAL — the autonomous-agent guarantee for signatures, in the same FINRA-discipline as
// the Director/manager evals. Two checks, both pure:
//   1. PLACEMENT SAFETY — every auto-derived anchor's party matches its source field name's party, and
//      no field flagged AMBIGUOUS was ever auto-assigned. This is what makes "a signature can never
//      land on the wrong party's line" a proven invariant, not a hope.
//   2. EXECUTION (the tagged → signed → verified close) — every form that CARRIED signature anchors
//      must be fully signed before the packet is certified complete; a tagged-but-unsigned form is
//      surfaced, never waved through.

import { deriveEsignAnchors, type DerivedAnchors } from "./esign-anchors"

export interface AnchorPlacementResult {
  ok: boolean
  violations: string[]
}

/**
 * evalAnchorPlacement — assert the derived anchors are safe: each anchor's role is the SINGLE role its
 * own field name resolves to, and no ambiguous field leaked into the auto-assigned set. Pure.
 */
export function evalAnchorPlacement(derived: DerivedAnchors): AnchorPlacementResult {
  const violations: string[] = []
  const ambiguousFields = new Set((derived.ambiguous ?? []).map((a) => a.fieldName))

  for (const anchor of derived.anchors ?? []) {
    // Re-derive from this single field — it must resolve to exactly this one role.
    const reDerived = deriveEsignAnchors([anchor.fieldName])
    const roles = reDerived.anchors.map((a) => a.role)
    if (roles.length !== 1 || roles[0] !== anchor.role) {
      violations.push(`anchor ${anchor.key} on "${anchor.fieldName}" assigned role ${anchor.role}, but the field resolves to [${roles.join(", ") || "none"}] — a signature could reach the wrong party`)
    }
    if (ambiguousFields.has(anchor.fieldName)) {
      violations.push(`field "${anchor.fieldName}" is both auto-anchored AND flagged ambiguous — must be placed manually, never auto-assigned`)
    }
  }
  return { ok: violations.length === 0, violations }
}

export interface FormAnchorStatus {
  formKey: string
  /** how many signature/initial anchors the form carries. */
  anchorCount: number
  /** is the form fully signed (provider reported all marks executed)? */
  signed: boolean
}

export interface AnchorExecutionResult {
  allExecuted: boolean
  /** forms that carried anchors but aren't fully signed. */
  incomplete: string[]
  reasons: string[]
}

/**
 * evalAnchorExecution — the close of the loop: a form that CARRIED signature anchors must be fully
 * signed before we certify "ready." A form with zero anchors needs no signature and is fine. Pure.
 *
 * WIRED (wave 46 lane EC): app/api/webhooks/dotloop/route.ts calls this on every
 * `document.signed` event to decide whether the WHOLE loop's packet may flip to
 * ready — a Dotloop loop fires this event once PER DOCUMENT, and without this
 * gate the offer's esign_status, the listing agreement's fully_executed_at, and
 * the voice-cockpit packet finalize all flipped "fully signed" the moment the
 * FIRST signer in a multi-document loop signed. FormAnchorStatus[] there is
 * assembled from every client_documents row tracked under the loop's
 * dotloop_loop_id (each carries anchorCount 1 — tracked-in-a-signature-loop
 * implies at least one anchor by construction) with `signed` from its own
 * status column. When evalAnchorExecution reports incomplete, the webhook
 * publishes a manager signal (compliance_officer → deal_coordinator,
 * signalType "esign_loop_partially_signed") and skips every ready-marking
 * write for that event.
 *
 * STILL OPEN: the FormAnchorStatus[] above is coarse (anchorCount 1 per
 * document, not the provider's real per-tag anchor count). The finer thread —
 * assembling anchors from esign-anchor-adapters.ts's per-tag provider payload,
 * which needs that count persisted at send time rather than only previewed by
 * app/actions/buyer-offer/esign-anchor-plan.ts — is a further integration, not
 * a caller stub. The coarse version already closes the real defect (partial
 * loops no longer read as complete); the finer one would only sharpen which
 * FIELD is still unsigned within an already-known-incomplete document.
 * Exercised by scripts/esign-anchor-simulator.ts */
export function evalAnchorExecution(forms: FormAnchorStatus[]): AnchorExecutionResult {
  const incomplete: string[] = []
  const reasons: string[] = []
  for (const f of forms ?? []) {
    if ((f.anchorCount ?? 0) > 0 && !f.signed) {
      incomplete.push(f.formKey)
      reasons.push(`${f.formKey}: carries ${f.anchorCount} signature anchor(s) but isn't fully signed`)
    }
  }
  return { allExecuted: incomplete.length === 0, incomplete, reasons }
}

// TOMBSTONE (orphan tranche 4): anchorsForRole deleted. Partitioning anchors per
// party is done more completely by the live provider adapters —
// lib/forms/esign-anchor-adapters.ts groups tags per CANONICAL role for the
// actual send (docusignTabsByRecipient / tabsByCanonicalRole) and
// recipientRolesForProvider derives the recipient list; the one-line
// `.filter((a) => a.role === role)` this wrapper held needs no named home.
