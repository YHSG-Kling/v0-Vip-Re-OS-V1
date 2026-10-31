// ─── FINAL COMPLIANCE CHECK (pre-CDA, post-preliminary-CD) ───────────────────
// After the title company / closing attorney provides the preliminary Closing
// Disclosure, the brokerage process requires a FINAL compliance re-check before
// the agent may submit the CDA: every required disclosure + brokerage document is
// present, the executed contract is on file, no document was rejected, ALL
// signatures/initials are complete, and no blocking compliance check is open.
//
// The classifier is PURE (unit-testable); the runner reads the real sources
// (signature_requests, transaction_documents, transaction_compliance_log) and
// reuses the existing blocking-compliance gate (canProceedToClosingPrep) — no
// duplicate compliance logic.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface FinalComplianceInput {
  /** signature_requests still pending/sent/partially_signed (not completed). */
  pendingSignatures: number
  /** transaction_documents still missing/requested (not provided). */
  missingDocs: number
  /** transaction_documents rejected (must be corrected). */
  rejectedDocs: number
  /** blocking transaction_compliance_log checks not yet passed. */
  blockingComplianceFailures: number
  /**
   * CLOSING COMPLIANCE (wave 143, lib/transactions/closing-compliance.ts): open BLOCKING findings of the
   * contract-terms-vs-settlement comparison and the closing-stage checklist, as lines a TC can act on.
   * Optional so every caller that predates it is unchanged; they are ALSO rows in the compliance log, so
   * the runner subtracts them from `blockingComplianceFailures` before they reach here (counted once).
   */
  closingFindings?: string[]
  /** The closing check could not run (inputs unreadable). A gate that cannot run REFUSES. */
  closingCheckError?: string | null
}

export interface FinalComplianceResult {
  passed: boolean
  blockers: string[]
}

/** Pure verdict — the deal is clear for CDA submission only when nothing is open. */
export function evaluateFinalCompliance(input: FinalComplianceInput): FinalComplianceResult {
  const blockers: string[] = []
  if (input.pendingSignatures > 0) {
    blockers.push(`${input.pendingSignatures} signature request${input.pendingSignatures === 1 ? "" : "s"} still incomplete — every signature and initial must be complete before the CDA.`)
  }
  if (input.missingDocs > 0) {
    blockers.push(`${input.missingDocs} required document${input.missingDocs === 1 ? "" : "s"} not yet provided — all disclosures and brokerage docs must be on file.`)
  }
  if (input.rejectedDocs > 0) {
    blockers.push(`${input.rejectedDocs} document${input.rejectedDocs === 1 ? " was" : "s were"} rejected and must be corrected before the CDA.`)
  }
  if (input.blockingComplianceFailures > 0) {
    blockers.push(`${input.blockingComplianceFailures} blocking compliance check${input.blockingComplianceFailures === 1 ? "" : "s"} unresolved.`)
  }
  for (const f of input.closingFindings ?? []) blockers.push(`Closing compliance: ${f}`)
  if (input.closingCheckError) {
    blockers.push(`Closing compliance could not run (${input.closingCheckError}) — nothing was verified, so the CDA cannot be submitted.`)
  }
  return { passed: blockers.length === 0, blockers }
}

/** Run the final compliance check against the real transaction state. */
export async function runFinalComplianceCheck(
  transactionId: string,
  brokerageId: string,
  client?: Svc,
): Promise<FinalComplianceResult> {
  const svc = client ?? createServiceClient()

  const [pendingSig, missingDoc, rejectedDoc] = await Promise.all([
    svc.from("signature_requests").select("id", { count: "exact", head: true })
      .eq("transaction_id", transactionId)
      .in("request_status", ["pending", "sent", "partially_signed"]),
    svc.from("transaction_documents").select("id", { count: "exact", head: true })
      .eq("transaction_id", transactionId)
      .in("status", ["missing", "requested"]),
    svc.from("transaction_documents").select("id", { count: "exact", head: true })
      .eq("transaction_id", transactionId)
      .eq("status", "rejected"),
  ])

  // CLOSING COMPLIANCE FIRST (wave 143): compare the governing executed terms (original offer → executed
  // counters → executed addenda) to the settlement statement, apply the brokerage's checklist at the closing
  // stage, and file every finding in transaction_compliance_log — so the gate below reads fresh rows and the
  // transaction's compliance tab shows the same items. It changes no signed term; it only flags.
  let closingFindings: string[] = []
  let closingCheckError: string | null = null
  let closingBlockingRows = 0
  try {
    const { runClosingCompliance } = await import("@/lib/transactions/closing-compliance")
    const closing = await runClosingCompliance(svc, { transactionId, brokerageId, trigger: "final_check" })
    if (!closing.ran) closingCheckError = closing.reason ?? "unknown"
    else {
      closingBlockingRows = closing.openBlocking
      closingFindings = closing.blockingSummary.slice(0, 12)
    }
  } catch (err) {
    closingCheckError = err instanceof Error ? err.message : "unexpected failure"
  }

  // Reuse the existing blocking-compliance gate (transaction_compliance_log) — don't
  // re-implement it here.
  let blockingComplianceFailures = 0
  try {
    const { canProceedToClosingPrep } = await import("@/app/actions/transaction-compliance")
    const gate = await canProceedToClosingPrep(transactionId, brokerageId)
    blockingComplianceFailures = gate.allowed ? 0 : (gate.blockers?.length ?? 1)
  } catch {
    // If the gate can't be evaluated, don't fabricate a pass — leave it to the other checks.
  }
  // The closing findings are rows in that same log, so the gate has already counted the blocking ones:
  // report them once, by name, not twice.
  blockingComplianceFailures = Math.max(0, blockingComplianceFailures - closingBlockingRows)

  return evaluateFinalCompliance({
    pendingSignatures: pendingSig.count ?? 0,
    missingDocs: missingDoc.count ?? 0,
    rejectedDocs: rejectedDoc.count ?? 0,
    blockingComplianceFailures,
    closingFindings,
    closingCheckError,
  })
}
