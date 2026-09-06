/**
 * lib/transactions/transaction-creation-gate.ts
 *
 * THE ONE PLACE THAT DECIDES A TRANSACTION MAY COME INTO EXISTENCE.
 *
 * Owner's rule, verbatim:
 *
 *   "when the transaction is created it is only created after the compliance is
 *    good, all documents are present with full signatures and initials. the
 *    required document list is in the settings for the transaction coordinator
 *    or admin."
 *
 * ── AND THE PRECONDITION THE OWNER PUT IN FRONT OF ALL OF IT (2026-09-04) ────
 *
 *   "compliance is involved when an offer gates to create a transaction ONCE THE
 *    OFFER IS FULLY EXECUTED BY BOTH BUYER AND SELLER, the compliance gate runs
 *    through the documents against an approved checklist provided by the
 *    brokerage to make sure all documents are present and that all signatures
 *    and initials are present, then the executed offer becomes a transaction,
 *    WHETHER WE REPRESENT THE SELLER, OR/AND THE BUYER."
 *
 * Full execution was NOT one of this gate's obligations. The gate never read
 * buyer_signed_at, seller_signed_at, seller_response_type or
 * fully_signed_contract_received_at at all — it inferred both-sides execution
 * only INDIRECTLY, from `signature_completeness` blobs on required documents,
 * which is a different claim about different rows. The direct reading lived in
 * ONE other function (offer-bridge:assertOfferReadyForTransaction) that only ONE
 * of the five `transactions` writers runs. It is now obligation 1 HERE, so every
 * writer that reaches this gate with an offer is held to it and the bridge's own
 * pre-check becomes a redundant early refusal rather than the only one.
 *
 * REPRESENTATION DOES NOT VARY IT. `dealType` already varies the CHECKLIST (a
 * seller-side deal requires seller-side paperwork); the EXECUTION PARTIES are
 * deliberately both sides regardless — see TRANSACTION_CONTRACT_PARTIES. That is
 * the owner's "whether we represent the seller, or/and the buyer", and it is
 * why the new obligation reads the same four columns on every deal type.
 *
 * Five obligations, ALL of which must hold:
 *
 *   0. THE OFFER IS FULLY EXECUTED BY BOTH BUYER AND SELLER — buyer_signed_at
 *      set, plus the fully-signed contract actually on file by one of the two
 *      admissible paths (the seller accepted, or the seller countered and the
 *      buyer signed back). Read through the ONE predicate every other
 *      enforcement point uses, lib/transactions/offer-execution-state.ts.
 *   1. COMPLIANCE IS GOOD — not pending, not unknown, not skipped. Established
 *      from the offer's own source-of-truth evidence (offers.compliance_passed_at
 *      plus the `buyer.offer.compliance.passed` audit activity) AND the absence
 *      of any still-OPEN compliance flag on that offer. A deal with no offer to
 *      point at has no compliance evidence at all, and "no evidence" is a
 *      REFUSAL, never a pass.
 *   2. EVERY REQUIRED DOCUMENT IS PRESENT — required by SETTINGS
 *      (`brokerage_required_documents`, resolved agent → team → brokerage,
 *      state-scoped), never by a list hardcoded here.
 *   3. EACH OF THOSE DOCUMENTS IS FULLY SIGNED — every required party's
 *      signature on every signature-bearing required document.
 *   4. INITIALS ARE COMPLETE — tracked SEPARATELY from signatures, because the
 *      owner names them separately. `documents.signature_completeness` carries
 *      `initials[{ signer_role, all_required_initials_present }]` alongside
 *      `signatures[{ signer_role, signed }]`, and a document whose signature
 *      block is filled while a page initial is outstanding is NOT complete.
 *
 * ── FAIL CLOSED (CLAUDE.md §4) ───────────────────────────────────────────────
 * "A gate that cannot run must refuse, not pass." Every read below destructures
 * `{ data, error }` and READS the error, because supabase-js RESOLVES refusals
 * (CLAUDE.md §3). A refused checklist read, a refused deal-file read, a missing
 * tenant anchor, an invalid id — each is a REFUSAL carrying the reason, never an
 * empty verdict that reads as clean. This is the finding-#105 shape
 * ("documents_verified passes with zero documents") kept out of the creation
 * path: `required_total` travels beside the verdict so "nothing required" is
 * always distinguishable from "nothing checked".
 *
 * ── TENANCY ─────────────────────────────────────────────────────────────────
 * `brokerageId` is the tenant anchor and every read is pinned to it. Callers
 * must pass the SESSION's brokerage — never a request body's (CLAUDE.md §4).
 * The gate additionally re-reads the offer's own brokerage_id and refuses a
 * mismatch, so a caller that got it wrong cannot walk another tenant's file.
 *
 * ── ONE VOCABULARY (CLAUDE.md §6) ───────────────────────────────────────────
 * Nothing here is a second compliance system. It composes what already exists:
 *   · the settings checklist + deal-file reader — lib/compliance/required-documents.ts
 *   · "is it actually signed AND initialed" — lib/compliance/signature-completeness.ts
 *   · the offer audit-flag ledger vocabulary — lib/buyer-offer/offer-lifecycle.ts
 * The listing side asks the identical question through
 * lib/documents/listing-agreement-gate.ts; this is its transaction-side twin.
 *
 * NOT `server-only`: the simulator drives it directly with an injected client,
 * like the rest of the kernel loaders. It only ever writes nothing at all — it
 * is a pure decision over reads.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { evaluateExecution } from "@/lib/compliance/signature-completeness"
import {
  auditOfferDocuments,
  loadDealFileDocuments,
  documentClassificationLabel,
  classificationCarriesSignatures,
  type AuditResult,
  type DealFileDocument,
  type DocumentClassification,
} from "@/lib/compliance/required-documents"
import { OFFER_AUDIT_EVENT } from "@/lib/buyer-offer/offer-lifecycle"
// OBLIGATION 0's reading, imported from the ONE place it is defined (§6). The
// offer bridge and the compliance checkpoint refuse on the identical predicate,
// so the three enforcement points cannot disagree about what "fully executed"
// means — which is exactly how this fact came to be enforced in one function and
// absent from the gate.
import {
  isOfferFullyExecuted,
  offerExecutionPath,
  SELLER_EXECUTION_EVIDENCE,
} from "./offer-execution-state"
// The flag ledger's own names — imported, never re-spelled, so this gate and the
// resolver that closes those flags can never disagree about what "open" means.
import { OFFER_COMPLIANCE_FLAG_EVENT, FLAG_STATUS_OPEN } from "@/lib/compliance/offer-flag-resolution"

/**
 * The parties whose signature AND initials a purchase contract requires. The
 * SAME pair the auto-create chain already uses
 * (lib/workflow-orchestrator/chains/compliance-transaction-auto-create.ts) —
 * both sides of the contract, regardless of which side we represent.
 */
export const TRANSACTION_CONTRACT_PARTIES = ["buyer", "seller"] as const

/** Which obligation refused. Ordered as the owner stated them. */
export type GateRequirement =
  /**
   * THE PRECONDITION: "once the offer is fully executed by both buyer and
   * seller". Refuses BEFORE compliance is even consulted, because on the owner's
   * sentence compliance is what runs once this is true.
   */
  | "fully_executed"
  | "compliance_good"
  | "required_documents_present"
  | "documents_fully_signed"
  | "initials_complete"
  /** The gate itself could not run — refuse, never pass. */
  | "gate_could_not_run"

export interface GateRefusal {
  requirement: GateRequirement
  /** Legible to a TC or an agent: what is wrong and what to do about it. */
  message: string
}

export interface UnexecutedDocument {
  documentId:     string
  classification: DocumentClassification | null
  label:          string
  /** e.g. ["seller signature"] — signatures only. */
  missingSignatures: string[]
  /** e.g. ["buyer initials"] — initials only, kept apart on purpose. */
  missingInitials:   string[]
  /**
   * True when the document carries NO signature record at all — it was never
   * scanned, so nothing about it has been verified. Reported apart from a real
   * gap because the remedy is different: scan it, don't chase a signer.
   */
  unscanned:         boolean
}

export interface TransactionCreationGateResult {
  allowed: boolean
  /** Every obligation that refused, in the owner's order. Empty when allowed. */
  refusals: GateRefusal[]
  /** One sentence a caller can put in an error/notification verbatim. */
  reason: string
  detail: {
    /**
     * Obligation 0. NULL when there was no offer to read it from — "never
     * established" is not "established false", exactly as requiredTotal is null
     * rather than 0 when the checklist could not be read.
     */
    fullyExecuted:    boolean | null
    /** Which columns established each side, when they did. */
    executionEvidence: string[]
    complianceState:  "passed" | "not_passed" | "unknown"
    /** null when the checklist could not be read — NOT zero. */
    requiredTotal:    number | null
    missingRequired:  string[]
    /** Documents present but not fully executed (signatures and/or initials). */
    unexecuted:       UnexecutedDocument[]
    /** Non-blocking checklist misses, passed through for the caller's notice. */
    missingWarning:   string[]
    /** What established compliance, when it did. */
    complianceEvidence: string[]
    checkedAt:        string
  }
}

export interface TransactionCreationGateParams {
  /** THE SESSION'S brokerage. Never a request body's. */
  brokerageId:  string
  /** The offer this transaction would be created from, when there is one. */
  offerId?:     string | null
  listingId?:   string | null
  /** Contacts anchoring the deal file (buyer and/or seller). */
  contactIds?:  Array<string | null | undefined>
  /** users.id of the deal's agent — drives the agent scope of the checklist. */
  agentUserId?: string | null
  teamId?:      string | null
  dealType:     "buyer" | "seller" | "dual"
  stateCode?:   string | null
  /** Who/what is asking, for the refusal text ("manual transaction sheet"). */
  door?:        string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function refuse(
  refusals: GateRefusal[],
  detail: TransactionCreationGateResult["detail"],
): TransactionCreationGateResult {
  return {
    allowed: false,
    refusals,
    reason: refusals.map((r) => r.message).join(" "),
    detail,
  }
}

/**
 * PURE. Which required, signature-bearing documents in this deal file are not
 * fully executed — with SIGNATURES and INITIALS reported separately, because the
 * owner names them separately and a TC fixing one is not fixing the other.
 *
 * ABSENCE IS NOT CONSENT (the doctrine evaluateExecution was written under): a
 * required contract with NO `signature_completeness` blob at all has not been
 * verified, and an unverified document is reported as unexecuted with every
 * requirement listed missing. That is the same direction the listing gate takes
 * and the opposite of the bug this whole lane exists to close.
 */
export function findUnexecutedDocuments(
  dealFile: ReadonlyArray<DealFileDocument>,
  requiredClassifications: ReadonlyArray<DocumentClassification>,
  parties: ReadonlyArray<string> = TRANSACTION_CONTRACT_PARTIES,
): UnexecutedDocument[] {
  const requiredSet = new Set<string>(requiredClassifications as string[])
  const out: UnexecutedDocument[] = []

  for (const doc of dealFile) {
    if (!doc.classification) continue
    if (!requiredSet.has(doc.classification)) continue
    if (!classificationCarriesSignatures(doc.classification)) continue

    const verdict = evaluateExecution(doc.signature_completeness, parties)
    if (verdict.executed) continue

    // `missing` reads like ["buyer signature", "seller initials"] — split it so
    // obligation 3 and obligation 4 refuse under their own names.
    const missingSignatures = verdict.missing.filter((m) => m.endsWith("signature"))
    const missingInitials   = verdict.missing.filter((m) => m.endsWith("initials"))
    const sc = doc.signature_completeness
    const unscanned = !(sc && typeof sc === "object" && !Array.isArray(sc))
    out.push({
      documentId:     doc.id,
      classification: doc.classification,
      label:          documentClassificationLabel(doc.classification),
      missingSignatures,
      missingInitials,
      unscanned,
    })
  }
  return out
}

/**
 * The columns this gate reads off the offer. Hoisted OUT of the query chain for
 * the same reason offer-bridge hoists its own: scripts/tenant-scope-guard.ts
 * examines the 500 characters that follow `.from("<table>")` looking for scoping
 * evidence, and a select list long enough to push `.eq("id", …)` past that
 * window would read as an unscoped query.
 *
 * THE FOUR EXECUTION COLUMNS ARE NEW HERE and are the whole point of obligation
 * 0: this gate previously selected only `id, brokerage_id, transaction_id,
 * compliance_passed_at`, so it could not have refused an un-executed offer even
 * in principle — it had never read the columns that say so.
 */
const GATE_OFFER_COLUMNS = [
  "id", "brokerage_id", "transaction_id", "compliance_passed_at",
  "buyer_signed_at", "seller_signed_at", "seller_response_type",
  "fully_signed_contract_received_at",
].join(", ")

/** Compliance AND execution evidence for one offer — read fail-closed. */
async function readOfferCompliance(
  supabase: SupabaseClient,
  params: { offerId: string; brokerageId: string },
): Promise<
  | {
      ok: true; passed: boolean; evidence: string[]; why: string | null
      /** Obligation 0 — both sides signed and the contract is on file. */
      fullyExecuted: boolean
      /** Why not, when not. Null when it is. */
      executionWhy: string | null
      /** What established each side, for the refusal text and the detail block. */
      executionEvidence: string[]
    }
  | { ok: false; error: string }
> {
  const { data: offer, error: offerErr } = await supabase
    .from("offers")
    .select(GATE_OFFER_COLUMNS)
    .eq("id", params.offerId)
    .maybeSingle()
  if (offerErr) return { ok: false, error: `offer could not be read: ${offerErr.message}` }
  if (!offer)   return { ok: false, error: "offer not found" }
  if ((offer as any).brokerage_id !== params.brokerageId) {
    return { ok: false, error: "offer belongs to a different brokerage" }
  }

  // ── OBLIGATION 0: FULLY EXECUTED BY BOTH BUYER AND SELLER ─────────────────
  // Read through the ONE predicate (§6). The refusal NAMES the missing side,
  // because "the buyer has not signed" and "the seller has not accepted" go to
  // different people.
  const execPath = offerExecutionPath(offer as any)
  const buyerSignedAt = (offer as any).buyer_signed_at as string | null
  const fullyExecuted = isOfferFullyExecuted(offer as any)
  const executionEvidence: string[] = []
  if (buyerSignedAt) executionEvidence.push(`offers.buyer_signed_at=${buyerSignedAt}`)
  if (execPath)      executionEvidence.push(SELLER_EXECUTION_EVIDENCE[execPath])
  let executionWhy: string | null = null
  if (!fullyExecuted) {
    const missing: string[] = []
    if (!buyerSignedAt) missing.push("the buyer has not signed")
    if (!execPath) {
      missing.push(
        (offer as any).fully_signed_contract_received_at
          ? "the seller has neither accepted nor signed a counter"
          : "the fully-signed contract is not on file",
      )
    }
    executionWhy = `this offer is not fully executed by both buyer and seller — ${missing.join(" and ")}`
  }

  const evidence: string[] = []
  const compliancePassedAt = (offer as any).compliance_passed_at as string | null
  if (compliancePassedAt) evidence.push(`offers.compliance_passed_at=${compliancePassedAt}`)

  // The audit activity is the ledger the compliance gate module calls "the ONLY
  // source of truth for compliance status". Both are read: a column without its
  // event, or an event without its column, is a half-stamped gate.
  const { data: passedEvent, error: eventErr } = await supabase
    .from("activities")
    .select("id, created_at")
    .eq("entity_type", "offer")
    .eq("entity_id", params.offerId)
    .eq("activity_type", OFFER_AUDIT_EVENT.COMPLIANCE_PASSED)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (eventErr) return { ok: false, error: `compliance ledger could not be read: ${eventErr.message}` }
  if (passedEvent) evidence.push(`${OFFER_AUDIT_EVENT.COMPLIANCE_PASSED}@${(passedEvent as any).created_at}`)

  // A still-OPEN compliance flag means compliance is NOT good, whatever the
  // stamp says — the TC has outstanding work on this offer.
  const { data: openFlags, error: flagErr } = await supabase
    .from("activities")
    .select("id, title")
    .eq("brokerage_id", params.brokerageId)
    .eq("entity_type", "offer")
    .eq("entity_id", params.offerId)
    .eq("activity_type", OFFER_COMPLIANCE_FLAG_EVENT)
    .eq("status", FLAG_STATUS_OPEN)
  if (flagErr) return { ok: false, error: `compliance flag ledger could not be read: ${flagErr.message}` }

  if (openFlags && openFlags.length > 0) {
    const titles = (openFlags as Array<{ title?: string | null }>)
      .map((f) => f.title).filter(Boolean).slice(0, 5).join("; ")
    return {
      ok: true,
      passed: false,
      evidence,
      why: `${openFlags.length} compliance flag(s) still open on this offer${titles ? `: ${titles}` : ""}`,
      fullyExecuted, executionWhy, executionEvidence,
    }
  }

  if (!compliancePassedAt || !passedEvent) {
    const half = !compliancePassedAt && !passedEvent
      ? "compliance has not passed on this offer"
      : !compliancePassedAt
        ? "the compliance-passed event exists but offers.compliance_passed_at was never stamped"
        : "offers.compliance_passed_at is stamped but the compliance-passed audit event is missing"
    return { ok: true, passed: false, evidence, why: half, fullyExecuted, executionWhy, executionEvidence }
  }

  return { ok: true, passed: true, evidence, why: null, fullyExecuted, executionWhy, executionEvidence }
}

/**
 * THE GATE. Returns `allowed:true` only when all four obligations hold; every
 * other outcome is a refusal that NAMES which requirement failed and which
 * documents are missing, unsigned or un-initialed.
 */
export async function assertTransactionCreationAllowed(
  supabase: SupabaseClient,
  params: TransactionCreationGateParams,
): Promise<TransactionCreationGateResult> {
  const checkedAt = new Date().toISOString()
  const door = params.door ? ` (${params.door})` : ""
  const baseDetail: TransactionCreationGateResult["detail"] = {
    fullyExecuted:      null,
    executionEvidence:  [],
    complianceState:    "unknown",
    requiredTotal:      null,
    missingRequired:    [],
    unexecuted:         [],
    missingWarning:     [],
    complianceEvidence: [],
    checkedAt,
  }

  // ── 0. Can the gate run at all? ──────────────────────────────────────────
  if (!params.brokerageId || !UUID_RE.test(params.brokerageId)) {
    return refuse([{
      requirement: "gate_could_not_run",
      message: `Transaction creation refused${door}: no brokerage on the session, so the compliance gate could not run. Nothing was checked, so nothing may be created.`,
    }], baseDetail)
  }
  if (params.offerId && !UUID_RE.test(params.offerId)) {
    return refuse([{
      requirement: "gate_could_not_run",
      message: `Transaction creation refused${door}: the offer id is not a valid id, so the compliance gate could not run.`,
    }], baseDetail)
  }

  // ── 1. Compliance is GOOD ────────────────────────────────────────────────
  const refusals: GateRefusal[] = []
  let complianceState: "passed" | "not_passed" | "unknown" = "unknown"
  let complianceEvidence: string[] = []
  // NULL, not false: "no offer, so execution was never established" is a
  // different fact from "an offer that is not executed", and a boolean cannot
  // hold both. Same discipline as requiredTotal (null ≠ 0).
  let fullyExecuted: boolean | null = null
  let executionEvidence: string[] = []

  if (!params.offerId) {
    // No offer means no compliance evidence exists for this deal. The owner's
    // rule admits no "assumed good" — a transaction whose compliance nobody can
    // point at must not exist. This is what refuses the manual doors.
    refusals.push({
      requirement: "compliance_good",
      message: `Transaction creation refused${door}: there is no accepted offer on this deal, so compliance has never been reviewed for it. A transaction is created only after compliance passes on a fully executed contract.`,
    })
  } else {
    const compliance = await readOfferCompliance(supabase, {
      offerId: params.offerId, brokerageId: params.brokerageId,
    })
    if (!compliance.ok) {
      return refuse([{
        requirement: "gate_could_not_run",
        message: `Transaction creation refused${door}: the compliance state could not be read (${compliance.error}). Nothing was verified, so nothing may be created.`,
      }], { ...baseDetail })
    }
    complianceEvidence = compliance.evidence
    complianceState = compliance.passed ? "passed" : "not_passed"
    fullyExecuted = compliance.fullyExecuted
    executionEvidence = compliance.executionEvidence
    // OBLIGATION 0 REFUSES FIRST, and it refuses under its OWN name. The owner
    // put full execution in FRONT of the compliance run ("compliance is involved
    // … once the offer is fully executed"), so an un-executed offer must not be
    // told its problem is compliance — the remedy is a signature, not a TC.
    if (!compliance.fullyExecuted) {
      refusals.push({
        requirement: "fully_executed",
        message: `Transaction creation refused${door}: ${compliance.executionWhy}. A transaction is created only once the offer is fully executed by both buyer and seller.`,
      })
    }
    if (!compliance.passed) {
      refusals.push({
        requirement: "compliance_good",
        message: `Transaction creation refused${door}: ${compliance.why}.`,
      })
    }
  }

  // ── 2. Every required document present (from SETTINGS) ───────────────────
  let audit: AuditResult
  if (params.offerId) {
    audit = await auditOfferDocuments(supabase, {
      offerId:     params.offerId,
      brokerageId: params.brokerageId,
      contactId:   (params.contactIds ?? []).find(Boolean) ?? null,
      agentUserId: params.agentUserId ?? null,
      teamId:      params.teamId ?? null,
      dealType:    params.dealType,
      stateCode:   params.stateCode ?? null,
    })
  } else {
    // No offer: still resolve the checklist + the deal file so the refusal can
    // name the outstanding paperwork rather than only the missing offer.
    const { resolveRequiredDocuments } = await import("@/lib/compliance/required-documents")
    const required = await resolveRequiredDocuments(supabase, {
      brokerageId: params.brokerageId,
      agentUserId: params.agentUserId ?? null,
      teamId:      params.teamId ?? null,
      dealType:    params.dealType,
      stateCode:   params.stateCode ?? null,
    })
    const file = await loadDealFileDocuments(supabase, {
      brokerageId: params.brokerageId,
      listingId:   params.listingId ?? null,
      contactIds:  params.contactIds ?? [],
    })
    if (!required.ok || !file.ok) {
      audit = {
        required_total: 0, present: [], missing_blocking: [], missing_warning: [],
        required_breakdown: [],
        unavailable_reason: !required.ok ? required.error : (file as { error: string }).error,
        deal_file: [],
      }
    } else {
      const presentSet = new Set<DocumentClassification>()
      for (const d of file.rows) if (d.classification) presentSet.add(d.classification)
      audit = {
        required_total:   required.docs.length,
        present:          Array.from(presentSet),
        missing_blocking: required.docs.filter(r => r.block_on_missing && !presentSet.has(r.classification)).map(r => r.classification),
        missing_warning:  required.docs.filter(r => !r.block_on_missing && !presentSet.has(r.classification)).map(r => r.classification),
        required_breakdown: required.docs,
        unavailable_reason: null,
        deal_file: file.rows,
      }
    }
  }

  if (audit.unavailable_reason) {
    // THE FAIL-CLOSED CASE. The checklist or the deal file could not be read.
    // An unreadable file is not an empty one, and an empty verdict here would be
    // "nobody checked" rendered as "checked and fine".
    return refuse([{
      requirement: "gate_could_not_run",
      message: `Transaction creation refused${door}: the required-document check could not run (${audit.unavailable_reason}). Nothing was verified, so nothing may be created.`,
    }], { ...baseDetail, fullyExecuted, executionEvidence, complianceState, complianceEvidence })
  }

  if (audit.missing_blocking.length > 0) {
    refusals.push({
      requirement: "required_documents_present",
      message: `Transaction creation refused${door}: ${audit.missing_blocking.length} required document(s) missing from the deal file — ${audit.missing_blocking.map(documentClassificationLabel).join(", ")}. Upload them and resubmit to compliance.`,
    })
  }

  // ── 3 + 4. Fully signed, and initials complete ───────────────────────────
  const requiredClassifications = audit.required_breakdown.map((r) => r.classification)
  const unexecuted = findUnexecutedDocuments(audit.deal_file, requiredClassifications)

  const signatureGaps = unexecuted.filter((u) => u.missingSignatures.length > 0)
  const initialGaps   = unexecuted.filter((u) => u.missingInitials.length > 0)

  // A document nobody scanned has a DIFFERENT remedy from one a party has not
  // signed — "scan it" rather than "chase the seller" — so the refusal says which.
  const describe = (u: UnexecutedDocument, which: "sig" | "ini") =>
    u.unscanned
      ? `${u.label} (never scanned — nothing about it has been verified)`
      : `${u.label} (missing ${(which === "sig" ? u.missingSignatures : u.missingInitials).join(", ")})`

  if (signatureGaps.length > 0) {
    refusals.push({
      requirement: "documents_fully_signed",
      message: `Transaction creation refused${door}: ${signatureGaps.length} required document(s) are not fully signed — ${signatureGaps.map((u) => describe(u, "sig")).join("; ")}.`,
    })
  }
  if (initialGaps.length > 0) {
    refusals.push({
      requirement: "initials_complete",
      message: `Transaction creation refused${door}: initials are still outstanding on ${initialGaps.length} required document(s) — ${initialGaps.map((u) => describe(u, "ini")).join("; ")}. A signature block being filled does not make a document complete when a page initial is blank.`,
    })
  }

  const detail: TransactionCreationGateResult["detail"] = {
    fullyExecuted,
    executionEvidence,
    complianceState,
    requiredTotal:   audit.required_total,
    missingRequired: audit.missing_blocking.map(documentClassificationLabel),
    unexecuted,
    missingWarning:  audit.missing_warning.map(documentClassificationLabel),
    complianceEvidence,
    checkedAt,
  }

  if (refusals.length > 0) return refuse(refusals, detail)

  return {
    allowed: true,
    refusals: [],
    reason: `Compliance gate passed at ${checkedAt} — offer fully executed by both buyer and seller, compliance good, all ${audit.required_total} required document(s) present, every signature and every initial complete.`,
    detail,
  }
}
