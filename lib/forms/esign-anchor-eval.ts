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

import { deriveEsignAnchors, type DerivedAnchors, type EsignAnchor } from "./esign-anchors"

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
 */
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

/** Convenience: only the anchors a given party is responsible for. Pure. */
export function anchorsForRole(anchors: EsignAnchor[], role: EsignAnchor["role"]): EsignAnchor[] {
  return (anchors ?? []).filter((a) => a.role === role)
}
