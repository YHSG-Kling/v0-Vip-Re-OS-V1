/**
 * lib/documents/document-versions.ts — WAVE 153 (lane 153D). DOCUMENT VERSIONS AND ISSUER-OWNED CORRECTIONS. PURE, client-safe.
 *
 * Owner (verbatim, 2026-11-14): "lender/title or any vendors can correct their own documents." and "the brokerage has a list of
 * documents that need to be present so final closing compliance should be checking to be sure the required docs are at least in
 * the file in order to release a cda and if brokerage doesnt use the cda, as well."
 *
 * THE VERSION LINK (which row replaced which) is ONE vocabulary held beside the deal file it decides —
 * lib/compliance/required-documents.ts DOCUMENT_VERSION_KEYS / isSupersededDocument / followSupersession. This module is the rule for
 * WHO may file a corrected version.
 *
 * WHO MAY CORRECT WHAT (decideIssuerCorrection). The issuer of a document is the party whose document it IS: the lender for the
 * borrower's Closing Disclosure on a financed deal, the title company / closing attorney for the settlement statement, title
 * commitment, wire instructions and escrow receipt, the appraiser for the appraisal, the inspector for the inspection, the insurance
 * agent for the binder. A vendor corrects ITS OWN document only — never another issuer's, never the parties' signed contract
 * instruments, never the brokerage's fee agreements, never across tenants, never a version that was already replaced. After the
 * close the closed record is not touched: the correction is filed as a separate post-closing adjustment (a governed task), never a
 * mutation.
 */

import { DOCUMENT_VERSION_KEYS } from "@/lib/compliance/required-documents"

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

// ── The issuer ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Who issues a document. `lender` is a vendor of a lender category (lib/kernel/lender-linkage.ts) — never a user type. */
type DocumentIssuerKind = "lender" | "title" | "vendor"

export interface DocumentIssuer {
  kind: DocumentIssuerKind
  /** vendors.id for a lender / vendor issuer; null for a title company resolved through the title portal. */
  vendorId: string | null
  /** vendors.category for a vendor issuer (appraiser / inspector / insurance / attorney / …); null when unknown. */
  category: string | null
}

/** The brokerage's own fee agreements — no vendor ever replaces one (owner: never "update underlying brokerage fee agreements"). */
const BROKERAGE_AGREEMENTS = new Set(["commission_agreement", "seller_broker_agreement", "listing_agreement"])
/** The PARTIES' contract instruments and identity papers — never a vendor's document, whoever uploaded the file. */
const PARTY_DOCUMENTS = new Set(["signed_contract", "counter_offer", "addendum", "agency_disclosure", "disclosure", "id_document", "proof_of_funds"])

/**
 * The classifications each issuer issues, used ONLY when the original's issuer was never recorded (an agent uploaded the lender's
 * letter, say). `closing_disclosure` is the LENDER's on a financed deal (TRID: the lender issues the borrower's CD) and the title
 * company's settlement statement on a cash deal — a lender's revised CD and title's revised statement are separate issuer-owned facts.
 */
function issuerClasses(issuer: DocumentIssuer, financed: boolean | null): ReadonlySet<string> {
  if (issuer.kind === "lender") return new Set(["lender_letter", "pre_approval_letter", "appraisal_report", ...(financed === true ? ["closing_disclosure"] : [])])
  const category = (issuer.category ?? "").toLowerCase()
  if (issuer.kind === "title" || category === "title" || category === "attorney") {
    return new Set(["title_report", "preliminary_closing_statement", "wire_instructions", "earnest_money_receipt", ...(financed === false ? ["closing_disclosure"] : [])])
  }
  if (category === "appraiser") return new Set(["appraisal_report"])
  if (category === "inspector" || category === "pest_control" || category === "roofer" || category === "hvac") return new Set(["inspection_report"])
  if (category === "insurance") return new Set(["insurance_binder"])
  if (category === "home_warranty" || category === "surveyor") return new Set(["other"])
  return new Set<string>()
}

/** Same issuer: the same kind and, for a vendor / lender, the same vendor. A title company is identified by its assignment to the deal. */
function sameIssuer(a: DocumentIssuer, b: DocumentIssuer): boolean {
  const titleish = (i: DocumentIssuer) => i.kind === "title" || ["title", "attorney"].includes((i.category ?? "").toLowerCase())
  if (titleish(a) && titleish(b)) return a.vendorId && b.vendorId ? a.vendorId === b.vendorId : true
  if (a.kind !== b.kind) return false
  return !!a.vendorId && a.vendorId === b.vendorId
}

/** Read a recorded issuer off a row's metadata (written by the correction door), or null when none was recorded. */
export function recordedIssuerOf(metadata: unknown): DocumentIssuer | null {
  const i = asObject(asObject(metadata)?.[DOCUMENT_VERSION_KEYS.issuer])
  const kind = str(i?.kind)
  if (kind !== "lender" && kind !== "title" && kind !== "vendor") return null
  return { kind, vendorId: str(i?.vendorId), category: str(i?.category) }
}

/** Off-platform handoff proof: how the issuer's corrected file reached the tenant (an email, a courier, a fax) and from whom. */
export interface OffPlatformProof { channel: string; sender: string; receivedAt: string; reference?: string | null }

interface IssuerCorrectionInput {
  /** The party correcting: the issuer acting for itself (a vendor / lender / title session), or tenant staff filing what the issuer sent off platform. */
  actor:
    | { via: "issuer"; issuer: DocumentIssuer; brokerageId: string; assigned: boolean }
    | { via: "staff_on_behalf"; issuer: DocumentIssuer; brokerageId: string; assigned: boolean; proof: OffPlatformProof | null }
  original: {
    brokerageId: string
    transactionId: string | null
    classification: string | null
    /** The issuer recorded on the original (metadata.issuer, or the transaction-documents uploader), null when nobody recorded one. */
    recordedIssuer: DocumentIssuer | null
    superseded: boolean
  }
  transaction: { id: string; brokerageId: string; closed: boolean; financed: boolean | null }
}

export type IssuerCorrectionRefusal =
  | "cross_tenant" | "not_assigned" | "already_superseded" | "brokerage_agreement" | "party_document"
  | "another_issuer" | "not_issuer_document" | "proof_required"

type IssuerCorrectionVerdict =
  | { ok: true; mode: "pre_close_version" | "post_close_adjustment"; issuer: DocumentIssuer }
  | { ok: false; code: IssuerCorrectionRefusal; message: string }

/** Plain words for every refusal (the tenant-facing contract: what happened · what it affects · who can act · one action). */
const REFUSAL: Record<IssuerCorrectionRefusal, string> = {
  cross_tenant: "This document is not on a deal you work on, so nothing was filed.",
  not_assigned: "You are not assigned to this deal, so you can't file a corrected version of its documents. Ask the agent to add you to the deal team.",
  already_superseded: "A newer version of this document is already on file. Correct the latest version instead.",
  brokerage_agreement: "This is one of the brokerage's own agreements. Only the brokerage changes it, so nothing was filed.",
  party_document: "This is a document the buyer and seller sign, not a vendor's document, so nothing was filed. The agent records any signed change.",
  another_issuer: "This document was issued by another company. Only its issuer can file a corrected version, so nothing was filed.",
  not_issuer_document: "This kind of document isn't one your company issues on this deal, so nothing was filed. Ask the agent if a correction is needed.",
  proof_required: "Say how the corrected file reached you (who sent it, how and when) before filing it for the vendor, so the file keeps its proof.",
}

/** PURE. May this party file a corrected version of this document — and, if so, as a new version (before close) or a post-closing adjustment? */
export function decideIssuerCorrection(input: IssuerCorrectionInput): IssuerCorrectionVerdict {
  const refuse = (code: IssuerCorrectionRefusal): IssuerCorrectionVerdict => ({ ok: false, code, message: REFUSAL[code] })
  const { actor, original, transaction } = input
  if (!actor.brokerageId || actor.brokerageId !== transaction.brokerageId || original.brokerageId !== transaction.brokerageId || original.transactionId !== transaction.id) return refuse("cross_tenant")
  if (!actor.assigned) return refuse("not_assigned")
  if (actor.via === "staff_on_behalf" && (!actor.proof || !str(actor.proof.sender) || !str(actor.proof.receivedAt) || !str(actor.proof.channel))) return refuse("proof_required")
  if (original.superseded) return refuse("already_superseded")
  const cls = original.classification ?? "other"
  if (BROKERAGE_AGREEMENTS.has(cls)) return refuse("brokerage_agreement")
  if (PARTY_DOCUMENTS.has(cls)) return refuse("party_document")
  if (original.recordedIssuer) {
    if (!sameIssuer(original.recordedIssuer, actor.issuer)) return refuse("another_issuer")
  } else if (!issuerClasses(actor.issuer, transaction.financed).has(cls)) {
    return refuse("not_issuer_document")
  }
  return { ok: true, mode: transaction.closed ? "post_close_adjustment" : "pre_close_version", issuer: actor.issuer }
}
