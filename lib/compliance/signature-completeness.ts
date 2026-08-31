/**
 * lib/compliance/signature-completeness.ts
 *
 * "IS IT ACTUALLY SIGNED?" — asked in one place, answered the same way everywhere.
 *
 * A listing is taken on when the agreement is signed AND initialed by both the
 * listing agent and the seller. That question gets asked by the scanner's gate,
 * and it gets asked again by any surface that wants to tell an agent why their
 * listing has not gone live. Two implementations of it would eventually disagree,
 * and the disagreement would be invisible: one would say signed, the other would
 * not, and a listing would either go live unsigned or never go live at all.
 *
 * This module is client-safe on purpose (no `server-only`), so the predicate the
 * gate uses is the predicate a panel can show — and so it can be proven directly
 * rather than through a source scan.
 *
 * THE SAFETY DIRECTION IS DELIBERATE. Absence is NOT consent. A missing entry, a
 * malformed blob, a null — every one of them reads as "not signed". The scanner
 * is an AI reading a PDF; when it cannot find a signature block, the honest
 * answer is that we have not verified a signature, and a listing must not go
 * live on an answer we do not have.
 */

/** Parties whose signature AND initials a listing agreement requires. */
export const LISTING_AGREEMENT_PARTIES = ["agent", "seller"] as const
// TOMBSTONE (§1.3, 2026-08-31, lane M4): derived type `ListingAgreementParty`
// deleted — never named by any consumer; the checker below iterates
// LISTING_AGREEMENT_PARTIES (the live const) directly. Re-derive when a typed
// consumer arrives.

export interface SignatureEntry {
  signer_role?: string | null
  signer_name?: string | null
  signed?: boolean | null
}

export interface InitialEntry {
  signer_role?: string | null
  all_required_initials_present?: boolean | null
}

export interface SignatureCompleteness {
  signatures?: SignatureEntry[]
  initials?:   InitialEntry[]
}

export interface ExecutionVerdict {
  /** True only when EVERY required party has both signed and initialed. */
  executed: boolean
  /** Human-readable list of what is missing, e.g. "seller initials". */
  missing: string[]
}

/**
 * Has every required party signed AND initialed?
 *
 * @param signatureCompleteness the raw `documents.signature_completeness` blob.
 *        Anything unparseable — null, a string, an array, a missing key — yields
 *        a NOT-executed verdict listing every requirement as missing.
 * @param parties override the required parties (defaults to agent + seller).
 */
export function evaluateExecution(
  signatureCompleteness: unknown,
  parties: readonly string[] = LISTING_AGREEMENT_PARTIES,
): ExecutionVerdict {
  const sc =
    signatureCompleteness && typeof signatureCompleteness === "object" && !Array.isArray(signatureCompleteness)
      ? (signatureCompleteness as SignatureCompleteness)
      : {}

  const signatures = Array.isArray(sc.signatures) ? sc.signatures : []
  const initials   = Array.isArray(sc.initials)   ? sc.initials   : []
  const roleOf = (r: { signer_role?: string | null }) => String(r?.signer_role ?? "").trim().toLowerCase()

  const missing: string[] = []
  for (const party of parties) {
    // `=== true` is load-bearing: a truthy-but-not-true value (the string
    // "false", 1, "yes") must not be read as a signature.
    if (!signatures.some((s) => roleOf(s) === party && s?.signed === true)) {
      missing.push(`${party} signature`)
    }
    if (!initials.some((i) => roleOf(i) === party && i?.all_required_initials_present === true)) {
      missing.push(`${party} initials`)
    }
  }

  return { executed: missing.length === 0, missing }
}
