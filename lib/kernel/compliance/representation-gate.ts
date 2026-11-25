/**
 * lib/kernel/compliance/representation-gate.ts
 *
 * THE SUBSTANTIVE REVIEW OF AN EXECUTED PACKET — ONE TYPED DECISION, REUSED BY EVERY DOOR (wave 156, lane 156B).
 *
 * Owner (2026-11-25): "after the fully signed listing agreement is in, the compliance gate goes before creating a
 * transaction." A SIGNATURE IS NOT COMPLIANCE. Four governing records stay distinct:
 *   · the LISTING AGREEMENT (seller representation)      — listing_agreements + its executed document
 *   · the LISTING (marketing / MLS lifecycle)             — listings (draft → … → COMING_SOON_PREP → MLS_ACTIVE)
 *   · the OFFER (an executed purchase contract in waiting) — offers + its governing packet (original → accepted counter + addenda)
 *   · the PURCHASE TRANSACTION                            — transactions, created ONLY from an executed, reviewed offer
 * A listing agreement alone never creates a purchase transaction (proved by scripts/wave156-b-representation-gate-guard.ts over
 * every `transactions` writer), and a listing never implies we represent the buyer (lib/transactions/deal-type-resolver.ts).
 *
 * WHAT ALREADY EXISTED, AND IS NOT RE-SPELLED HERE (CLAUDE.md §1, §6). The presence/signature/initial half is the two gates:
 *   lib/listings/listing-activation-gate.ts  assertListingActivationAllowed   (settings checklist, state-scoped, agent+seller)
 *   lib/transactions/transaction-creation-gate.ts assertTransactionCreationAllowed (fully executed, compliance stamp, packet)
 * They READ: is it there, is it signed, is it initialed. Neither COMPARED what the executed paper says against the record the
 * business runs on. This module is that second half, and it consumes the gate verdict it sits behind rather than re-deriving it.
 *
 * THE DECISION. `decideRepresentationCompliance` is PURE and returns the typed verdict every door acts on:
 *   allow        — the gate passed, every compared fact agrees, and a person holding review authority approved THIS evidence
 *                  (the approval is bound to the evidence hash; a later change to the compared facts unbinds it).
 *   needs_review — nothing contradicts, but no authorized person has accepted the packet yet (or something only a person can
 *                  judge — an unsigned addendum outside the contract, a legal description the scan cannot read). The model
 *                  extracts and the comparator compares; neither ACCEPTS a packet (OS-CONSTITUTION law 4).
 *   hold         — something is wrong and is fixable: a missing document, signature or initial (the gate's refusal), an empty or
 *                  failed extraction, a low-confidence reading, a superseded version, an ambiguous signer, a field the document
 *                  contradicts, an unsigned addendum. Each reason names the document and the term. A hold is never "AI failure".
 *   refuse       — the request itself is wrong: another tenant's record, a contract that already became a transaction.
 * A hold cannot be approved away: the reviewer action refuses an approval while any hold reason stands.
 *
 * REVIEWER AUTHORITY is the authority the codebase already defines for deciding compliance on a deal —
 * lib/auth/deal-work-ownership.ts resolveDealWork `capabilities.closingApproval` (compliance_officer → compliance_reviewer, or the
 * tenant admin roster minus team_lead / compliance_officer). The owning agent alone never holds it; a vendor, lender, title agent or
 * Contact never does. No new role, no new user type.
 *
 * WHAT THE EVIDENCE HASH COVERS: the record, its id and version, the gate's checklist verdict, and every COMPARED fact (document id
 * + value + the record's value). An unrelated upload (a photo, an inspection report) does not change it; a new agreement version,
 * a changed list price or a new executed addendum does.
 *
 * NOT `server-only`: the guard drives it with the in-memory client. It reads; its only write is `recordRepresentationDecision`
 * (one compliance_events receipt), and the human approval is written by app/actions/compliance/representation-review.ts.
 */

import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { evaluateExecution, LISTING_AGREEMENT_PARTIES } from "@/lib/compliance/signature-completeness"
import { isSupersededDocument } from "@/lib/compliance/required-documents"
import { resolveDealWork } from "@/lib/auth/deal-work-ownership"
import type { GateRefusal } from "@/lib/transactions/transaction-creation-gate"
import type { TenantPacketRow } from "@/lib/forms/tenant-form-packets"

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const REPRESENTATION_VERDICTS = ["allow", "hold", "refuse", "needs_review"] as const
export type RepresentationVerdict = (typeof REPRESENTATION_VERDICTS)[number]

/** The governed record the decision is about. The two are never the same record. */
export type RepresentationRecord = "listing_agreement" | "purchase_offer"

/** compliance_events.gate_name for the decision receipts and the human review — one spelling. */
export const REPRESENTATION_REVIEW_GATE = "representation_review"

export type ReasonSeverity = "refuse" | "hold" | "review"

export type ReasonCode =
  | "tenant_mismatch"
  | "already_transaction"
  | "gate_refused"
  | "no_executed_document"
  | "superseded_version"
  | "extraction_failed"
  | "extraction_empty"
  | "extraction_low_confidence"
  | "ambiguous_signature"
  | "signer_identity_mismatch"
  | "initials_missing"
  | "field_mismatch"
  | "contradictory_terms"
  | "state_mismatch"
  | "unsigned_addendum"
  | "unverified_by_machine"
  | "awaiting_reviewer"
  | "form_license"
  | "form_not_in_directory"
  | "form_directory_unread"

/**
 * EVERY HOLD HAS A REPAIR THAT TERMINATES (wave 156 round 2). Typed as a total Record, so a new reason code that forgets its repair
 * does not compile. Each path ends in a re-run of the SAME decision: an upload / re-scan re-enters the loop (scanUploadedDocument),
 * a reviewer's attestation or approval re-runs it from app/actions/compliance/representation-review.ts, a record correction is
 * re-read on the next run. `refuse` reasons end by construction (the request was wrong; nothing is waiting on them).
 */
export const REPAIR_PATHS: Readonly<Record<ReasonCode, { path: string; terminatesWhen: string }>> = Object.freeze({
  tenant_mismatch:           { path: "none — the request names another account's record", terminatesWhen: "immediately (refused)" },
  already_transaction:       { path: "none — open the existing transaction", terminatesWhen: "immediately (refused; one contract, one deal)" },
  gate_refused:              { path: "upload the missing document / obtain the missing signature or initial; the upload re-enters review", terminatesWhen: "the presence/signature gate passes on re-run" },
  no_executed_document:      { path: "upload the fully executed document; the upload re-enters review", terminatesWhen: "an executed document is on the file" },
  superseded_version:        { path: "upload the current executed version", terminatesWhen: "a non-superseded executed document is on the file" },
  extraction_failed:         { path: "re-scan / re-upload the document, OR a reviewer attests the terms read from the executed paper", terminatesWhen: "a readable scan or a reviewer attestation exists for the document" },
  extraction_empty:          { path: "re-scan / re-upload the document, OR a reviewer attests the terms read from the executed paper", terminatesWhen: "a readable scan or a reviewer attestation exists for the document" },
  extraction_low_confidence: { path: "re-scan / re-upload the document, OR a reviewer attests the terms read from the executed paper", terminatesWhen: "a high-confidence scan or a reviewer attestation exists for the document" },
  ambiguous_signature:       { path: "a reviewer confirms the signers in an attestation, or a re-signed document is uploaded", terminatesWhen: "the signers are confirmed or every signature maps to a party" },
  signer_identity_mismatch:  { path: "correct the seller on the CRM record, or obtain the owner-of-record's signature", terminatesWhen: "the signers match the seller on file" },
  initials_missing:          { path: "obtain the missing initials and upload the initialed document", terminatesWhen: "every party's initials are present" },
  field_mismatch:            { path: "correct the record to the executed term, or obtain a corrected re-signed document (the original is kept)", terminatesWhen: "document and record agree" },
  contradictory_terms:       { path: "mark the wrong paper superseded through the document-version door, or upload the governing executed instrument", terminatesWhen: "one current executed instrument states the term" },
  state_mismatch:            { path: "execute the agreement on the listing state's form and upload it", terminatesWhen: "the executed form's state matches the property" },
  unsigned_addendum:         { path: "have the addendum signed and initialed, or mark it superseded/withdrawn through the document-version door", terminatesWhen: "the addendum is executed or out of the file" },
  unverified_by_machine:     { path: "the reviewer reads it on the executed document and approves (or attests it)", terminatesWhen: "a reviewer approves this evidence" },
  awaiting_reviewer:         { path: "a reviewer with closingApproval authority approves the evidence hash", terminatesWhen: "an approval bound to the current evidence hash exists" },
  form_license:              { path: "re-execute the packet on the form's current revision (the replacement named in the reason) or renew / replace the expired license in the forms directory (/dashboard/forms#add-forms), then upload the executed copy", terminatesWhen: "the directory reads the executed form as licensed and current" },
  form_not_in_directory:     { path: "the reviewer confirms the brokerage may use this form, or adds it to the forms directory (/dashboard/forms#add-forms) — informational, never a hold", terminatesWhen: "a reviewer approves this evidence, or the directory knows the form" },
  form_directory_unread:     { path: "retry: re-open the review (or re-run the scan) once the forms directory can be read — the standing is re-read on every run", terminatesWhen: "the forms directory is read and the form's standing is known" },
})

/** The terms a reviewer may attest per record — exactly the keys the comparator reads (no free-form fields). */
export const ATTESTABLE_TERMS: Readonly<Record<"listing_agreement" | "purchase_offer", readonly string[]>> = Object.freeze({
  listing_agreement: ["property_address", "zip_code", "state", "list_price", "list_date", "expiration_date", "commission_rate", "seller_name", "legal_description"],
  purchase_offer: ["price", "counter_price", "earnest_money_amount", "closing_date", "property_address"],
})

/** A reviewer's field-by-field reading of one executed document (human, never a model). */
export interface TermAttestation { documentId: string; userId: string; at: string; terms: Record<string, unknown>; signersConfirmed: boolean }

export interface BlockingReason {
  /** wave 156 round 2: how this reason ends — never a dead end. Filled from REPAIR_PATHS. */
  repair?: string
  code: ReasonCode
  severity: ReasonSeverity
  /** Plain words a TC or agent acts on: which form, which term, what it says vs what the record says. */
  message: string
  /** The real document to open — never a generic pointer. */
  documentId: string | null
  field: string | null
  documentSays?: unknown
  recordSays?: unknown
}

export interface ReviewerAuthority {
  /** The capability the reviewer must hold (lib/auth/deal-work-ownership.ts). */
  capability: "closingApproval"
  /** The deal-work roles that carry it. */
  roles: ReadonlyArray<"compliance_reviewer" | "tenant_admin">
  /** Who never holds it on their own. */
  never: ReadonlyArray<string>
}

export const REPRESENTATION_REVIEWER_AUTHORITY: ReviewerAuthority = Object.freeze({
  capability: "closingApproval",
  roles: Object.freeze(["compliance_reviewer", "tenant_admin"] as const),
  never: Object.freeze(["owning agent alone", "team_lead", "tc", "vendor (lender, title, closing attorney)", "contact"]),
}) as ReviewerAuthority

export interface ComparedFact {
  field: string
  documentId: string
  documentSays: unknown
  recordSays: unknown
  agrees: boolean | null
  /** Where the document value came from: the scan, or a named reviewer's attestation. */
  source?: "scan" | "attested"
}

export interface RepresentationDecision {
  record: RepresentationRecord
  subjectId: string
  /** The version the decision is about: the listing_agreements row / the head (accepted) offer of the governing sequence. */
  version: string
  verdict: RepresentationVerdict
  blockingReasons: BlockingReason[]
  evidenceHash: string
  evidence: {
    documentIds: string[]; compared: ComparedFact[]; gate: string
    /** Each document the decision read: the reference the open door resolves, the form id, and who attested it (if anyone). */
    documents?: Array<{ id: string; classification: string | null; storageUrl: string | null; stateFormId: string | null; attestedBy: string | null; formStanding?: DocumentFormStanding | null }>
  }
  reviewerAuthority: ReviewerAuthority
  /** Who approved this exact evidence, when they did. */
  approval: { userId: string; at: string } | null
  /** (tenant, record, version) — the unit of once for the downstream creation. */
  idempotencyKey: string
  checkedAt: string
}

// ─── Pure normalizers ───────────────────────────────────────────────────────

const STREET_ABBR: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", drive: "dr", lane: "ln", court: "ct", boulevard: "blvd", place: "pl",
  circle: "cir", terrace: "ter", parkway: "pkwy", highway: "hwy", north: "n", south: "s", east: "e", west: "w",
}

/** PURE. "123 Main Street, Austin, TX" → "123 main st austin tx". */
export function normalizeAddress(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null
  return v.toLowerCase().replace(/[.,#]/g, " ").split(/\s+/).filter(Boolean).map((w) => STREET_ABBR[w] ?? w).join(" ")
}

/** PURE. A dollar / percent figure from a number or a printed string; null when none. */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v !== "string") return null
  const s = v.replace(/[$,%\s]/g, "")
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null
  return Number(s)
}

/** PURE. yyyy-mm-dd off a date / timestamp string; null when none. */
export function toDay(v: unknown): string | null {
  if (typeof v !== "string") return null
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

const present = (v: unknown) => v !== null && v !== undefined && !(typeof v === "string" && !v.trim())

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`
  return JSON.stringify(v ?? null)
}

/** PURE. sha256 over the canonical JSON of the decision's inputs. */
export function evidenceHashOf(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex")
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface EvidenceDocument {
  id: string
  classification: string | null
  extracted_fields: unknown
  classification_confidence: string | null
  signature_completeness: unknown
  scanned_at: string | null
  scan_error: string | null
  metadata: unknown
  state_code?: string | null
  state_form_id?: string | null
  created_at?: string | null
  /** documents.storage_url — the reference the open door resolves (lib/storage/signed-doc-url.ts documentOpenHref). */
  storage_url?: string | null
  /** Set by applyAttestations: the reviewer's reading replaced the scan for this document. */
  attested?: { userId: string; at: string; signersConfirmed: boolean } | null
  /** wave 156 (156R): the form's license / version standing in the tenant's forms directory, read ONCE per executed document by the
   *  loaders (attachFormStandings → formLicenseStanding at the foot of this file, re-exported by lib/forms/form-directory-intake.ts). Absent = not read (pure callers). */
  form_standing?: DocumentFormStanding | null
}

/** wave 156 (156R): what the forms directory says about the form an executed document was written on. */
export interface DocumentFormStanding {
  standing: "licensed_current" | "retired" | "license_expired" | "unknown" | "read_error"
  /** The form reference the document carries (library form id, provider form id or the state form number). */
  ref: string | null
  packetId?: string | null
  replacementPacketId?: string | null
  expiredOn?: string | null
  /** unknown: why the directory does not know it; read_error: the refused read. */
  reason?: string | null
}

/**
 * PURE. A reviewer's attestation REPLACES the scan for that document: the comparison runs on the terms the person read, the
 * readability holds (failed / empty / low-confidence scan) no longer apply, and — only when the reviewer confirmed the signers —
 * neither does the ambiguous-signature hold. Everything else (a contradiction with the record, missing initials, an unsigned
 * addendum) is still decided on the attested terms. The scan blob itself is never rewritten.
 */
export function applyAttestations(docs: EvidenceDocument[], attestations: Record<string, TermAttestation> | undefined): EvidenceDocument[] {
  if (!attestations) return docs
  return docs.map((d) => {
    const a = attestations[d.id]
    return a ? { ...d, extracted_fields: { ...a.terms }, attested: { userId: a.userId, at: a.at, signersConfirmed: a.signersConfirmed } } : d
  })
}

/**
 * THE FORM-LICENSE SEAM (wave 156 round 2) — the ONE function lane 156C's licensed-forms registry plugs into. Given an executed
 * document (its state_form_id / state_code), it returns a HOLD reason when the form is unlicensed or superseded, or null when it
 * has no finding. CONNECTED (wave 156, lane 156R): the default is formStandingFinding below, which reads the standing the loaders
 * attach (attachFormStandings, at the foot); setFormLicenseCheck remains the override a proof installs.
 */
export type FormLicenseCheck = (doc: EvidenceDocument) => BlockingReason | null
let formLicenseCheck: FormLicenseCheck = (doc) => formStandingFinding(doc)
export function setFormLicenseCheck(check: FormLicenseCheck): void { formLicenseCheck = check }
export function formLicenseFinding(doc: EvidenceDocument): BlockingReason | null { return formLicenseCheck(doc) }

/**
 * wave 156 (lane 156R) — THE SEAM CONNECTED. The default check reads the standing the loaders attached to the document (they ask
 * lane 156C's directory reader, formLicenseStanding at the foot of this file, once per executed document). PURE:
 *   licensed_current -> no finding.
 *   retired          -> HOLD naming the form and its replacement: re-execute on the current revision.
 *   license_expired  -> HOLD naming the form and the expiry date: renew or replace the license.
 *   unknown          -> NOT a hold (a tenant with an empty directory must still be able to close) — a REVIEW line the reviewer
 *                       sees: "this form is not in your directory".
 *   read_error       -> HOLD with a retry — a directory that could not be read is never a silent pass (CLAUDE.md §4).
 *   not read (pure callers that attach no standing) -> no opinion, exactly as before.
 */
export function formStandingFinding(doc: EvidenceDocument): BlockingReason | null {
  const st = doc.form_standing
  if (!st || st.standing === "licensed_current") return null
  const form = st.ref ? `form "${st.ref}"` : "the form this document was written on"
  if (st.standing === "retired") {
    return { code: "form_license", severity: "hold", documentId: doc.id, field: "form_version", documentSays: st.ref, recordSays: st.replacementPacketId ?? null,
      message: `The executed document is on ${form}, which your forms directory has RETIRED${st.replacementPacketId ? ` — its current revision is library form ${st.replacementPacketId}` : " with no replacement recorded"}. Re-execute the packet on the current revision and upload it; the executed original is kept.` }
  }
  if (st.standing === "license_expired") {
    return { code: "form_license", severity: "hold", documentId: doc.id, field: "form_license", documentSays: st.ref, recordSays: st.expiredOn ?? null,
      message: `The executed document is on ${form}, whose license in your forms directory EXPIRED on ${st.expiredOn ?? "an unrecorded date"}. Renew the license (or replace the form with one you hold) in the forms directory, then re-run the review.` }
  }
  if (st.standing === "read_error") {
    return { code: "form_directory_unread", severity: "hold", documentId: doc.id, field: "form_license",
      message: `Whether ${form} is licensed and current could not be checked — ${st.reason ?? "the forms directory could not be read"}. Nothing was assumed; re-open the review to retry.` }
  }
  return { code: "form_not_in_directory", severity: "review", documentId: doc.id, field: "form_license", documentSays: st.ref,
    message: `This form${st.ref ? ` ("${st.ref}")` : ""} is not in your directory${st.reason ? ` (${st.reason})` : ""}. Confirm the brokerage may use it before approving — or add it to your forms directory.` }
}

export interface ListingRepresentationInput {
  brokerageId: string
  listing: {
    id: string; brokerage_id: string; address: string | null; city: string | null; state: string | null; zip: string | null
    list_price: number | null; expiration_date: string | null; legal_description: string | null; commission_rate: number | null
  }
  agreement: {
    id: string; effective_date: string | null; expiration_date: string | null; listing_commission_rate: number | null
    total_commission_rate: number | null; agent_signed_at: string | null; seller_signed_at: string | null
  } | null
  /** Documents classified listing_agreement / seller_broker_agreement on the listing file, newest first, superseded ones included. */
  agreementDocuments: EvidenceDocument[]
  /** Addendum documents on the listing file. */
  addenda: EvidenceDocument[]
  /** The seller's name(s) on the CRM record — the expected signer. */
  sellerNames: string[]
  /** The activation gate's verdict for the same listing (presence, signatures, initials, state checklist). */
  gate: { allowed: boolean; refusals: GateRefusal[] }
  approval: { userId: string; at: string; evidenceHash: string; decision: string } | null
  /** Reviewer attestations by document id (the newest per document). */
  attestations?: Record<string, TermAttestation>
  checkedAt?: string
}

export interface OfferRepresentationInput {
  brokerageId: string
  offer: {
    id: string; brokerage_id: string; offer_price: number | null; earnest_money: number | null; closing_date: string | null
    property_address: string | null; transaction_id: string | null
  }
  /** The governing packet: accepted sequence root → head, and the executed addenda's document ids. */
  packet: { sequence: string[]; headOfferId: string; addendumDocumentIds: string[]; transactionIds: string[] }
  /** Contract paperwork (signed_contract / counter_offer) filed against the HEAD offer, newest first. */
  contractDocuments: EvidenceDocument[]
  /** Every addendum on the offer file — executed (in the packet) and not. */
  addenda: EvidenceDocument[]
  /** The creation-side checks already made on this offer (presence / signatures / initials). */
  gate: { allowed: boolean; refusals: GateRefusal[] }
  approval: { userId: string; at: string; evidenceHash: string; decision: string } | null
  attestations?: Record<string, TermAttestation>
  checkedAt?: string
}

// ─── Shared reasoning over one executed document ────────────────────────────

const objectOf = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** PURE. The machine-readability of one executed document: any failure is a HOLD that names the document. */
function readabilityReasons(doc: EvidenceDocument, label: string): BlockingReason[] {
  const out: BlockingReason[] = []
  const license = formLicenseFinding(doc)
  if (license) out.push(license)
  if (doc.attested) {
    // The reviewer read it. An attestation with no terms at all is still an empty reading.
    if (Object.values(objectOf(doc.extracted_fields)).filter(present).length === 0) out.push({ code: "extraction_empty", severity: "hold", documentId: doc.id, field: null,
      message: `${label}: the attestation recorded no terms. Record the terms you read on the executed document.` })
    return out
  }
  if (doc.scan_error || !doc.scanned_at) {
    out.push({ code: "extraction_failed", severity: "hold", documentId: doc.id, field: null,
      message: `${label}: the document scan ${doc.scan_error ? `failed (${doc.scan_error})` : "never ran"}, so nothing on it has been read. Re-run the scan or have compliance read it.` })
    return out
  }
  const fields = objectOf(doc.extracted_fields)
  if (Object.values(fields).filter(present).length === 0) {
    out.push({ code: "extraction_empty", severity: "hold", documentId: doc.id, field: null,
      message: `${label}: the scan returned no terms at all — an empty reading is not a clean one. Open the document and confirm it is the executed form.` })
  }
  if (String(doc.classification_confidence ?? "").toLowerCase() !== "high") {
    out.push({ code: "extraction_low_confidence", severity: "hold", documentId: doc.id, field: null,
      message: `${label}: the scan read it with ${doc.classification_confidence ?? "unstated"} confidence, so its terms cannot be compared automatically. Compliance must read the executed paper.` })
  }
  return out
}

/** PURE. Signatures whose signer could not be placed in a role are ambiguous — a HOLD, never a pass. */
function ambiguousSignatures(doc: EvidenceDocument, label: string, parties: readonly string[]): BlockingReason[] {
  if (doc.attested?.signersConfirmed) return []
  const sigs = Array.isArray(objectOf(doc.signature_completeness).signatures) ? (objectOf(doc.signature_completeness).signatures as Array<Record<string, unknown>>) : []
  const odd = sigs.filter((s) => s?.signed === true && !parties.includes(String(s?.signer_role ?? "").toLowerCase()) && String(s?.signer_role ?? "").toLowerCase() !== "broker")
  return odd.length
    ? [{ code: "ambiguous_signature", severity: "hold", documentId: doc.id, field: "signer_role",
        message: `${label}: ${odd.length} signature(s) could not be matched to a party (${odd.map((s) => `${s.signer_name ?? "unnamed"} as "${s.signer_role ?? "unknown"}"`).join(", ")}). Compliance must confirm who signed.` }]
    : []
}

function compareFact(facts: ComparedFact[], reasons: BlockingReason[], f: Omit<ComparedFact, "agrees">, eq: (a: unknown, b: unknown) => boolean, label: string, what: string): void {
  if (!present(f.documentSays) || !present(f.recordSays)) { facts.push({ ...f, agrees: null }); return }
  const agrees = eq(f.documentSays, f.recordSays)
  facts.push({ ...f, agrees })
  if (!agrees) {
    reasons.push({ code: "field_mismatch", severity: "hold", documentId: f.documentId, field: f.field, documentSays: f.documentSays, recordSays: f.recordSays,
      message: `${label} says ${what} is ${String(f.documentSays)}, but the record says ${String(f.recordSays)}. Correct the record or obtain a corrected, re-signed document — the executed original is kept.` })
  }
}

const numEq = (a: unknown, b: unknown) => { const x = toNumber(a), y = toNumber(b); return x !== null && y !== null && Math.abs(x - y) < 0.005 }
const dayEq = (a: unknown, b: unknown) => { const x = toDay(a), y = toDay(b); return x !== null && x === y }
const addrEq = (a: unknown, b: unknown) => {
  const x = normalizeAddress(a), y = normalizeAddress(b)
  return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `))
}
const textEq = (a: unknown, b: unknown) => normalizeAddress(a) === normalizeAddress(b)

function gateReasons(gate: { allowed: boolean; refusals: GateRefusal[] }): BlockingReason[] {
  if (gate.allowed) return []
  return gate.refusals.map((r) => ({
    code: r.requirement === "governing_packet" && /already became transaction/.test(r.message) ? "already_transaction" as const : "gate_refused" as const,
    severity: r.requirement === "governing_packet" && /already became transaction/.test(r.message) ? "refuse" as const : "hold" as const,
    message: r.message, documentId: null, field: r.requirement,
  }))
}

/** PURE. Fold reasons + approval into the verdict. */
function verdictOf(reasons: BlockingReason[], approvalMatches: boolean): RepresentationVerdict {
  if (reasons.some((r) => r.severity === "refuse")) return "refuse"
  if (reasons.some((r) => r.severity === "hold")) return "hold"
  return approvalMatches ? "allow" : "needs_review"
}

function finish(
  record: RepresentationRecord, brokerageId: string, subjectId: string, version: string, reasons: BlockingReason[],
  compared: ComparedFact[], documentIds: string[], gateSummary: string,
  approval: { userId: string; at: string; evidenceHash: string; decision: string } | null, checkedAt: string,
  docs: EvidenceDocument[] = [],
): RepresentationDecision {
  // Where each compared value came from (scan vs a named reviewer's attestation) is part of the evidence an approval binds to.
  const attestedIds = new Set(docs.filter((d) => d.attested).map((d) => d.id))
  for (const c of compared) c.source = attestedIds.has(c.documentId) ? "attested" : "scan"
  for (const r of reasons) r.repair = REPAIR_PATHS[r.code].path
  // The hash is computed over the facts — never over the approval or the time — so a person approves THESE facts.
  // wave 156 (156R): the form's directory standing is evidence too — an approval given while a form was licensed and current does
  // not survive its retirement or expiry. Added only when a loader read it, so a pure caller's hash is what it always was.
  const forms = docs.filter((d) => d.form_standing).map((d) => [d.id, d.form_standing!.standing, d.form_standing!.ref, d.form_standing!.packetId ?? null, d.form_standing!.replacementPacketId ?? null, d.form_standing!.expiredOn ?? null])
  const evidenceHash = evidenceHashOf({ record, subjectId, version, gate: gateSummary, compared, reasons: reasons.map((r) => [r.code, r.documentId, r.field]), ...(forms.length ? { forms } : {}) })
  const approvalMatches = !!approval && approval.decision === "approve" && approval.evidenceHash === evidenceHash
  const all = [...reasons]
  if (!approvalMatches && !all.some((r) => r.severity !== "review")) {
    all.push({ code: "awaiting_reviewer", severity: "review", documentId: documentIds[0] ?? null, field: null,
      message: approval && approval.decision === "approve"
        ? "The packet changed after it was approved, so the earlier approval no longer covers it. A compliance reviewer must approve the current packet."
        : "Every compared term agrees. A compliance reviewer (or a tenant admin) must accept the packet before it continues — the system does not accept a packet on its own.",
      repair: REPAIR_PATHS.awaiting_reviewer.path })
  }
  return {
    record, subjectId, version, verdict: verdictOf(all, approvalMatches), blockingReasons: all, evidenceHash,
    evidence: {
      documentIds, compared, gate: gateSummary,
      documents: docs.map((d) => ({ id: d.id, classification: d.classification, storageUrl: d.storage_url ?? null, stateFormId: d.state_form_id ?? null, attestedBy: d.attested?.userId ?? null, formStanding: d.form_standing ?? null })),
    },
    reviewerAuthority: REPRESENTATION_REVIEWER_AUTHORITY,
    approval: approvalMatches && approval ? { userId: approval.userId, at: approval.at } : null,
    idempotencyKey: `${brokerageId}:${record}:${version}`, checkedAt,
  }
}

// ─── THE LISTING DECISION ───────────────────────────────────────────────────

/**
 * PURE. Compare the executed listing agreement against the listing, the agreement record, the seller on file and the gate's
 * checklist verdict. Signer identity / role, seller signatures, required initials, address, state, legal description, list
 * price, effective and expiration dates, compensation, addenda — each one a named fact.
 */
export function decideListingRepresentation(input: ListingRepresentationInput): RepresentationDecision {
  const checkedAt = input.checkedAt ?? new Date().toISOString()
  const reasons: BlockingReason[] = []
  const compared: ComparedFact[] = []
  const L = input.listing
  const version = input.agreement?.id ?? "no-agreement"

  if (L.brokerage_id !== input.brokerageId) {
    reasons.push({ code: "tenant_mismatch", severity: "refuse", documentId: null, field: "brokerage_id", message: "This listing belongs to another account. Nothing was reviewed." })
    return finish("listing_agreement", input.brokerageId, L.id, version, reasons, compared, [], "not_run", null, checkedAt)
  }
  reasons.push(...gateReasons(input.gate))

  const current = applyAttestations(input.agreementDocuments.filter((d) => !isSupersededDocument(d.metadata)), input.attestations)
  const listingAddenda = applyAttestations(input.addenda, input.attestations)
  if (current.length === 0) {
    reasons.push(input.agreementDocuments.length > 0
      ? { code: "superseded_version", severity: "hold", documentId: input.agreementDocuments[0].id, field: null,
          message: "Every listing-agreement document on file has been replaced by a later version that is not on the listing. Upload the current executed agreement." }
      : { code: "no_executed_document", severity: "hold", documentId: null, field: null,
          message: "No executed listing-agreement document is on the listing file, so its terms cannot be compared. Upload the fully signed agreement." })
  }
  const doc = current[0]
  if (doc) {
    const label = "The listing agreement"
    reasons.push(...readabilityReasons(doc, label))
    reasons.push(...ambiguousSignatures(doc, label, LISTING_AGREEMENT_PARTIES))
    const exec = evaluateExecution(doc.signature_completeness, LISTING_AGREEMENT_PARTIES)
    const initials = exec.missing.filter((m) => m.endsWith("initials"))
    if (initials.length) reasons.push({ code: "initials_missing", severity: "hold", documentId: doc.id, field: "initials", message: `${label} is missing ${initials.join(", ")} on its pages. Have the party initial and re-upload.` })
    const sigsMissing = exec.missing.filter((m) => m.endsWith("signature"))
    if (sigsMissing.length) reasons.push({ code: "gate_refused", severity: "hold", documentId: doc.id, field: "signatures", message: `${label} is missing the ${sigsMissing.join(", ")}.` })

    const f = objectOf(doc.extracted_fields)
    const A = input.agreement
    compareFact(compared, reasons, { field: "property_address", documentId: doc.id, documentSays: f.property_address, recordSays: L.address }, addrEq, label, "the property address")
    compareFact(compared, reasons, { field: "zip", documentId: doc.id, documentSays: f.zip_code, recordSays: L.zip }, (a, b) => String(a).trim().slice(0, 5) === String(b).trim().slice(0, 5), label, "the ZIP code")
    compareFact(compared, reasons, { field: "list_price", documentId: doc.id, documentSays: f.list_price, recordSays: L.list_price }, numEq, label, "the list price")
    compareFact(compared, reasons, { field: "expiration_date", documentId: doc.id, documentSays: f.expiration_date ?? f.expires_at, recordSays: A?.expiration_date ?? L.expiration_date }, dayEq, label, "the expiration date")
    compareFact(compared, reasons, { field: "effective_date", documentId: doc.id, documentSays: f.list_date ?? f.effective_date, recordSays: A?.effective_date }, dayEq, label, "the effective date")
    compareFact(compared, reasons, { field: "commission_rate", documentId: doc.id, documentSays: f.commission_rate, recordSays: A?.total_commission_rate ?? A?.listing_commission_rate ?? L.commission_rate }, numEq, label, "the compensation rate")
    compareFact(compared, reasons, { field: "legal_description", documentId: doc.id, documentSays: f.legal_description, recordSays: L.legal_description }, textEq, label, "the legal description")

    // STATE: an agreement on another state's form is not this listing's form (the state checklist rides the gate).
    const docState = String(f.state ?? doc.state_code ?? "").trim().toUpperCase()
    if (docState && L.state && docState !== String(L.state).trim().toUpperCase()) {
      reasons.push({ code: "state_mismatch", severity: "hold", documentId: doc.id, field: "state", documentSays: docState, recordSays: L.state,
        message: `${label} is a ${docState} document${doc.state_form_id ? ` (${doc.state_form_id})` : ""}, but the listing is in ${L.state}. Use the ${L.state} form.` })
    }

    // SIGNER IDENTITY: the seller who signed must be the seller on file (and both sides' signature evidence must exist on the record).
    const sigs = Array.isArray(objectOf(doc.signature_completeness).signatures) ? (objectOf(doc.signature_completeness).signatures as Array<Record<string, unknown>>) : []
    const sellerSigners = sigs.filter((s) => String(s.signer_role ?? "").toLowerCase() === "seller" && s.signed === true).map((s) => String(s.signer_name ?? "").trim()).filter(Boolean)
    const named = [...sellerSigners, ...(typeof f.seller_name === "string" ? [f.seller_name] : [])]
    const lastNames = input.sellerNames.map((n) => n.trim().split(/\s+/).pop()!.toLowerCase()).filter(Boolean)
    if (named.length && lastNames.length) {
      const stranger = named.filter((n) => !lastNames.some((ln) => n.toLowerCase().includes(ln)))
      compared.push({ field: "seller_identity", documentId: doc.id, documentSays: named, recordSays: input.sellerNames, agrees: stranger.length === 0 })
      if (stranger.length) reasons.push({ code: "signer_identity_mismatch", severity: "hold", documentId: doc.id, field: "seller_name", documentSays: stranger, recordSays: input.sellerNames,
        message: `${label} is signed by ${stranger.join(", ")}, who is not the seller on file (${input.sellerNames.join(", ")}). Confirm every owner of record signed.` })
    }
    if (A && (!A.agent_signed_at || !A.seller_signed_at)) {
      reasons.push({ code: "gate_refused", severity: "hold", documentId: doc.id, field: "signed_at",
        message: `The agreement record carries no ${[!A.seller_signed_at && "seller", !A.agent_signed_at && "agent"].filter(Boolean).join(" or ")} signature time — the e-sign return has not been recorded on it.` })
    }
    // Facts the scan cannot read go to the person, never assumed.
    if (!present(f.legal_description)) reasons.push({ code: "unverified_by_machine", severity: "review", documentId: doc.id, field: "legal_description",
      message: `${label}: the legal description was not read by the scan${L.legal_description ? " — confirm it matches the listing's" : " and the listing has none on file"}. A reviewer confirms it.` })
  }

  // ADDENDA: an addendum that is not executed is a HOLD — and it never changes the agreement's terms.
  for (const ad of listingAddenda.filter((d) => !isSupersededDocument(d.metadata))) {
    const ex = evaluateExecution(ad.signature_completeness, LISTING_AGREEMENT_PARTIES)
    if (!ex.executed) reasons.push({ code: "unsigned_addendum", severity: "hold", documentId: ad.id, field: "addendum",
      message: `An addendum to the listing agreement is not fully executed (missing ${ex.missing.join(", ")}). It does not change the signed terms; have it signed and initialed or withdraw it.` })
  }

  const gateSummary = input.gate.allowed ? "passed" : input.gate.refusals.map((r) => r.requirement).sort().join("+")
  const docIds = [...current.map((d) => d.id), ...listingAddenda.map((d) => d.id)]
  return finish("listing_agreement", input.brokerageId, L.id, version, reasons, compared, docIds, gateSummary, input.approval, checkedAt, [...current, ...listingAddenda])
}

// ─── THE OFFER DECISION ─────────────────────────────────────────────────────

const CONTRACT_TERMS: Array<{ field: string; offerKey: "offer_price" | "earnest_money" | "closing_date" | "property_address"; docKeys: string[]; what: string; eq: (a: unknown, b: unknown) => boolean }> = [
  { field: "price", offerKey: "offer_price", docKeys: ["counter_price", "price"], what: "the purchase price", eq: numEq },
  { field: "earnest_money", offerKey: "earnest_money", docKeys: ["earnest_money_amount"], what: "the earnest money", eq: numEq },
  { field: "closing_date", offerKey: "closing_date", docKeys: ["closing_date"], what: "the closing date", eq: dayEq },
  { field: "property_address", offerKey: "property_address", docKeys: ["property_address"], what: "the property address", eq: addrEq },
]
const firstPresent = (f: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (present(f[k])) return f[k]; return null }

/**
 * PURE. The governing contract (head instrument + EXECUTED addenda, later executed addenda govern) compared against the offer
 * record the transaction will be built from. An UNSIGNED addendum never overwrites a signed term: it is excluded from the
 * governing terms, named for the reviewer, and the transaction is built on the signed terms.
 */
export function decideOfferRepresentation(input: OfferRepresentationInput): RepresentationDecision {
  const checkedAt = input.checkedAt ?? new Date().toISOString()
  const reasons: BlockingReason[] = []
  const compared: ComparedFact[] = []
  const O = input.offer
  const version = input.packet.headOfferId

  if (O.brokerage_id !== input.brokerageId) {
    reasons.push({ code: "tenant_mismatch", severity: "refuse", documentId: null, field: "brokerage_id", message: "This offer belongs to another account. Nothing was reviewed." })
    return finish("purchase_offer", input.brokerageId, O.id, version, reasons, compared, [], "not_run", null, checkedAt)
  }
  if (input.packet.transactionIds.length > 0 || O.transaction_id) {
    reasons.push({ code: "already_transaction", severity: "refuse", documentId: null, field: "transaction_id",
      message: `This executed contract already became transaction ${[...input.packet.transactionIds, O.transaction_id].filter(Boolean)[0]}. One executed contract creates one transaction.` })
  }
  reasons.push(...gateReasons(input.gate))

  const current = applyAttestations(input.contractDocuments.filter((d) => !isSupersededDocument(d.metadata)), input.attestations)
  const offerAddenda = applyAttestations(input.addenda, input.attestations)
  if (current.length === 0) {
    reasons.push({ code: input.contractDocuments.length ? "superseded_version" : "no_executed_document", severity: "hold", documentId: input.contractDocuments[0]?.id ?? null, field: null,
      message: input.contractDocuments.length
        ? "The executed contract on file was replaced by a later version that is not on this offer. Upload the current executed contract."
        : "No executed contract document is filed on this offer, so its terms cannot be compared. Upload the fully signed contract (and the accepted counter, if any)." })
  }
  // WHICH PAPER IS THE HEAD (round 3): on a countered contract the accepted COUNTER states the governing terms; the original
  // contract's paper legitimately states the original price and is not a contradiction of it. So the head is the newest counter
  // paper when the sequence carries a counter, and only papers of the head's own kind are compared against each other.
  if (input.packet.sequence.length > 1) current.sort((a, b) => Number(b.classification === "counter_offer") - Number(a.classification === "counter_offer"))
  const head = current[0]
  const sameKind = current.slice(1).filter((d) => d.classification === head?.classification)
  const executedAddenda = offerAddenda.filter((d) => input.packet.addendumDocumentIds.includes(d.id) && !isSupersededDocument(d.metadata))
  const unsignedAddenda = offerAddenda.filter((d) => !input.packet.addendumDocumentIds.includes(d.id) && !isSupersededDocument(d.metadata))

  if (head) {
    const label = input.packet.sequence.length > 1 ? "The accepted counter-offer" : "The executed purchase contract"
    reasons.push(...readabilityReasons(head, label))
    reasons.push(...ambiguousSignatures(head, label, ["buyer", "seller"]))
    for (const ad of executedAddenda) reasons.push(...readabilityReasons(ad, "An executed addendum"))
    // EVERY INSTRUMENT OF THE CONTRACT IS EXECUTED (round 3): the head (an accepted counter's own paper), the original's paper and
    // each executed addendum carry both parties' signatures AND initials — the same evaluator the creation gate uses. The review
    // runs before the stamp, so it must not accept a packet the gate would later refuse.
    for (const paper of [...current, ...executedAddenda]) {
      const ex = evaluateExecution(paper.signature_completeness, ["buyer", "seller"])
      if (!ex.executed) reasons.push({ code: ex.missing.some((m) => m.endsWith("initials")) && !ex.missing.some((m) => m.endsWith("signature")) ? "initials_missing" : "gate_refused", severity: "hold", documentId: paper.id, field: "signatures",
        message: `${paper.id === head.id ? label : paper.classification === "counter_offer" ? "A counter-offer paper" : paper.classification === "addendum" ? "An executed addendum" : "The original purchase contract"} (${String(paper.classification ?? "document").replace(/_/g, " ")}) is missing the ${ex.missing.join(", ")}. Obtain them and upload the executed paper.` })
    }

    for (const t of CONTRACT_TERMS) {
      // Governing value: the head instrument, then each EXECUTED addendum in order (a later executed amendment governs).
      let gov: { v: unknown; doc: string } | null = present(firstPresent(objectOf(head.extracted_fields), t.docKeys)) ? { v: firstPresent(objectOf(head.extracted_fields), t.docKeys), doc: head.id } : null
      for (const ad of executedAddenda) {
        const v = firstPresent(objectOf(ad.extracted_fields), t.docKeys)
        if (present(v)) {
          if (gov && !t.eq(v, gov.v)) compared.push({ field: `${t.field}:amended`, documentId: ad.id, documentSays: v, recordSays: gov.v, agrees: false })
          gov = { v, doc: ad.id }
        }
      }
      if (gov) compareFact(compared, reasons, { field: t.field, documentId: gov.doc, documentSays: gov.v, recordSays: O[t.offerKey] }, t.eq, gov.doc === head.id ? label : "The executed addendum", t.what)
      // Two current contract papers on the head that disagree with each other are a contradiction, not a choice.
      for (const other of sameKind) {
        const ov = firstPresent(objectOf(other.extracted_fields), t.docKeys)
        const hv = firstPresent(objectOf(head.extracted_fields), t.docKeys)
        if (present(ov) && present(hv) && !t.eq(ov, hv)) reasons.push({ code: "contradictory_terms", severity: "hold", documentId: other.id, field: t.field, documentSays: ov, recordSays: hv,
          message: `Two executed contract documents on this offer state different ${t.what} (${String(hv)} vs ${String(ov)}). Compliance must establish which instrument governs.` })
      }
      // An unsigned addendum that would change a term: named, never applied.
      for (const ad of unsignedAddenda) {
        const v = firstPresent(objectOf(ad.extracted_fields), t.docKeys)
        if (present(v) && gov && !t.eq(v, gov.v)) reasons.push({ code: "unsigned_addendum", severity: "review", documentId: ad.id, field: t.field, documentSays: v, recordSays: gov.v,
          message: `An addendum that is NOT fully executed states ${t.what} as ${String(v)}; the signed contract says ${String(gov.v)}. The signed term stands — the unsigned addendum changes nothing until both parties sign and initial it.` })
      }
    }
  }

  const gateSummary = input.gate.allowed ? "passed" : input.gate.refusals.map((r) => r.requirement).sort().join("+")
  const docIds = [...current.map((d) => d.id), ...offerAddenda.map((d) => d.id)]
  return finish("purchase_offer", input.brokerageId, O.id, version, reasons, compared, docIds, gateSummary, input.approval, checkedAt, [...current, ...offerAddenda])
}

// ─── Authority ──────────────────────────────────────────────────────────────

/**
 * PURE. May this person accept (or hold) a packet? Delegates to the ONE deal-work rule (resolveDealWork) — the same answer the
 * deal desk gives for "decide the compliance approval". The owning agent alone may not approve their own packet; a solo tenant's
 * owner holds the admin seat and so may. A vendor / lender / title agent / Contact holds nothing.
 */
export function mayReviewRepresentation(input: { sameTenant: boolean; userType: string | null; grantedRoles: readonly string[]; isOwningAgent: boolean; isTenantPrincipal?: boolean }): { ok: boolean; roles: string[] } {
  // THE SOLO TENANT (round 2): a tenant principal (users.is_tenant_principal — the account's owner) holds the account's admin seat
  // whatever user_type it was typed with, so a solo agent who is their own reviewer can finish their own listing. Read through the
  // same deal-work rule as an owner seat — never a new role.
  const granted = input.isTenantPrincipal ? [...input.grantedRoles, "broker_owner"] : input.grantedRoles
  const access = resolveDealWork({ sameTenant: input.sameTenant, userType: input.userType, grantedRoles: granted, isOwningAgent: input.isOwningAgent, isAssignedTc: false, isTeamLeadOfDealAgent: false, dealStatus: null, dealStage: null })
  return { ok: access.capabilities.closingApproval === true, roles: access.roles }
}

// ─── Loaders (fail closed) ──────────────────────────────────────────────────

type Db = SupabaseClient<any, any, any>
const DOC_COLUMNS = "id, classification, extracted_fields, classification_confidence, signature_completeness, scanned_at, scan_error, metadata, state_code, state_form_id, created_at, storage_url"
const LISTING_AGREEMENT_CLASSES = ["listing_agreement", "seller_broker_agreement"]

/**
 * The newest human review of this record AND the newest reviewer attestation per document (compliance_events). A refused read is
 * ok:false. Attestations are recorded only by app/actions/compliance/representation-review.ts attestRepresentationTerms — a person
 * under their own identity and review authority; no model path writes `kind: "attestation"`.
 */
export async function readRepresentationApproval(db: Db, p: { brokerageId: string; record: RepresentationRecord; subjectId: string }):
  Promise<{ ok: true; approval: ListingRepresentationInput["approval"]; attestations: Record<string, TermAttestation> } | { ok: false; error: string }> {
  const { data, error } = await db.from("compliance_events")
    .select("actor_user_id, created_at, details, allowed")
    .eq("brokerage_id", p.brokerageId).eq("gate_name", REPRESENTATION_REVIEW_GATE).eq("entity_type", p.record).eq("entity_id", p.subjectId)
    .order("created_at", { ascending: false }).limit(200)
  if (error) return { ok: false, error: `the review ledger could not be read: ${error.message}` }
  // AUTHORITY IS RE-CHECKED AT READ TIME (round 2): a row counts only when its actor holds review authority in THIS tenant now.
  // The ledger's session INSERT policy admits any tenant staff seat (OWNER SQL in the 156B report closes it at the database);
  // until then a row an agent forged through their own session is simply not an approval.
  const all = (data ?? []) as Array<Record<string, any>>
  const actorIds = [...new Set(all.filter((r) => r.details?.kind === "attestation" || r.details?.kind === "human_review").map((r) => String(r.actor_user_id ?? "")).filter(Boolean))]
  const authorized = new Set<string>()
  for (const id of actorIds) {
    const v = await reviewerHoldsAuthority(db, p.brokerageId, id)
    if (!v.ok) return { ok: false, error: v.error }
    if (v.holds) authorized.add(id)
  }
  const rows = all.filter((r) => authorized.has(String(r.actor_user_id ?? "")))
  const attestations: Record<string, TermAttestation> = {}
  for (const r of rows) {
    const docId = r.details?.document_id
    if (r.details?.kind !== "attestation" || typeof docId !== "string" || attestations[docId] || !r.actor_user_id) continue
    attestations[docId] = { documentId: docId, userId: String(r.actor_user_id), at: String(r.created_at ?? ""), terms: objectOf(r.details?.terms), signersConfirmed: r.details?.signers_confirmed === true }
  }
  const human = rows.find((r) => r.details?.kind === "human_review")
  if (!human) return { ok: true, approval: null, attestations }
  return { ok: true, attestations, approval: { userId: String(human.actor_user_id ?? ""), at: String(human.created_at ?? ""), evidenceHash: String(human.details?.evidence_hash ?? ""), decision: String(human.details?.decision ?? "") } }
}

/** Does this user hold review authority in this tenant NOW? Same rule as the door (mayReviewRepresentation); fail closed. */
export async function reviewerHoldsAuthority(db: Db, brokerageId: string, userId: string): Promise<{ ok: true; holds: boolean } | { ok: false; error: string }> {
  const [u, g] = await Promise.all([
    db.from("users").select("id, brokerage_id, user_type").eq("id", userId).eq("brokerage_id", brokerageId).maybeSingle(),
    db.from("user_role_assignments").select("role, brokerage_id").eq("user_id", userId),
  ])
  if (u.error || g.error) return { ok: false, error: `the reviewer's authority could not be read: ${(u.error ?? g.error)!.message}` }
  if (!u.data) return { ok: true, holds: false }
  const grantedRoles = ((g.data ?? []) as Array<{ role: string | null; brokerage_id: string | null }>).filter((x) => x.brokerage_id === brokerageId && x.role).map((x) => String(x.role))
  const { resolveTenantPrincipalTeamLead } = await import("@/lib/auth/resolve-user-role")
  const principal = await resolveTenantPrincipalTeamLead(db as never, userId, brokerageId)
  if (!principal.ok) return { ok: false, error: `the reviewer's authority could not be read: ${principal.reason}` }
  const userType = (u.data as { user_type?: string | null }).user_type ?? null
  // wave 156 (156R): the solo-tier principal (TIER PARITY) holds the same authority at read time as at the door, so an approval a
  // solo agent gave their own packet is not discarded when the decision re-reads the ledger.
  const solo = await isSoloTierPrincipal(db, { brokerageId, userType })
  if (!solo.ok) return { ok: false, error: `the reviewer's authority could not be read: ${solo.error}` }
  return { ok: true, holds: mayReviewRepresentation({ sameTenant: true, userType, grantedRoles, isOwningAgent: false, isTenantPrincipal: principal.isPrincipal || solo.isSolo }).ok }
}

/**
 * The ASSIGNED coordinator(s) of a listing / offer (round 2): `contacts.tc_user_id` of the artifact's contact — the same assignment
 * lib/kernel/approval-authority.ts reads ("assigned TC: contacts.tc_user_id of the artifact's contact") — plus the coordinator of a
 * transaction already on the record. Empty when none is assigned; the caller then falls back to the TC roster. Fail-soft: a refused
 * read returns the error so the caller logs it and uses the roster.
 */
export async function resolveAssignedCoordinators(db: Db, p: { brokerageId: string; contactIds: Array<string | null | undefined>; transactionId?: string | null }):
  Promise<{ userIds: string[]; error: string | null }> {
  const ids = [...new Set(p.contactIds.filter((x): x is string => !!x))]
  const out = new Set<string>()
  if (ids.length) {
    const { data, error } = await db.from("contacts").select("id, tc_user_id").eq("brokerage_id", p.brokerageId).in("id", ids)
    if (error) return { userIds: [], error: `the assigned coordinator could not be read: ${error.message}` }
    for (const c of (data ?? []) as Array<{ tc_user_id?: string | null }>) if (c.tc_user_id) out.add(c.tc_user_id)
  }
  if (p.transactionId) {
    const { data: tx, error } = await db.from("transactions").select("coordinator_id").eq("id", p.transactionId).eq("brokerage_id", p.brokerageId).maybeSingle()
    if (error) return { userIds: [...out], error: `the deal's coordinator could not be read: ${error.message}` }
    const cid = (tx as { coordinator_id?: string | null } | null)?.coordinator_id
    if (cid) {
      const { data: tc, error: tcErr } = await db.from("transaction_coordinators").select("user_id").eq("id", cid).eq("brokerage_id", p.brokerageId).maybeSingle()
      if (tcErr) return { userIds: [...out], error: `the deal's coordinator could not be read: ${tcErr.message}` }
      const uid = (tc as { user_id?: string | null } | null)?.user_id
      if (uid) out.add(uid)
    }
  }
  return { userIds: [...out], error: null }
}

/**
 * Load everything the listing decision compares — tenant-pinned, every error read — and decide. `gate` is the activation gate's
 * verdict for the same listing, passed in by the caller that already ran it (the compliance loop), never re-run here.
 */
export async function loadAndDecideListingRepresentation(db: Db, p: { brokerageId: string; listingId: string; gate: { allowed: boolean; refusals: GateRefusal[] } }):
  Promise<{ ok: true; decision: RepresentationDecision } | { ok: false; error: string }> {
  const { data: listing, error: lErr } = await db.from("listings")
    .select("id, brokerage_id, address, city, state, zip, list_price, expiration_date, legal_description, commission_rate, seller_contact_id, contact_id")
    .eq("id", p.listingId).eq("brokerage_id", p.brokerageId).maybeSingle()
  if (lErr) return { ok: false, error: `the listing could not be read: ${lErr.message}` }
  if (!listing) return { ok: false, error: "no such listing in this account" }
  const { data: agreements, error: aErr } = await db.from("listing_agreements")
    .select("id, effective_date, expiration_date, listing_commission_rate, total_commission_rate, agent_signed_at, seller_signed_at, created_at")
    .eq("listing_id", p.listingId).eq("brokerage_id", p.brokerageId).order("created_at", { ascending: false }).limit(1)
  if (aErr) return { ok: false, error: `the listing agreement could not be read: ${aErr.message}` }
  const { data: docs, error: dErr } = await db.from("documents").select(DOC_COLUMNS)
    .eq("brokerage_id", p.brokerageId).eq("listing_id", p.listingId).in("classification", [...LISTING_AGREEMENT_CLASSES, "addendum"])
    .order("created_at", { ascending: false })
  if (dErr) return { ok: false, error: `the listing file could not be read: ${dErr.message}` }
  const sellerId = ((listing as any).seller_contact_id ?? (listing as any).contact_id ?? null) as string | null
  const sellerNames: string[] = []
  if (sellerId) {
    const { data: c, error: cErr } = await db.from("contacts").select("first_name, last_name").eq("id", sellerId).eq("brokerage_id", p.brokerageId).maybeSingle()
    if (cErr) return { ok: false, error: `the seller on file could not be read: ${cErr.message}` }
    const name = [(c as any)?.first_name, (c as any)?.last_name].filter(Boolean).join(" ").trim()
    if (name) sellerNames.push(name)
  }
  const ap = await readRepresentationApproval(db, { brokerageId: p.brokerageId, record: "listing_agreement", subjectId: p.listingId })
  if (!ap.ok) return { ok: false, error: ap.error }
  const rows = await attachFormStandings(db, p.brokerageId, (listing as any).state ?? null, (docs ?? []) as EvidenceDocument[])
  return { ok: true, decision: decideListingRepresentation({
    brokerageId: p.brokerageId, listing: listing as any, agreement: ((agreements ?? [])[0] as any) ?? null,
    agreementDocuments: rows.filter((d) => LISTING_AGREEMENT_CLASSES.includes(String(d.classification))),
    addenda: rows.filter((d) => d.classification === "addendum"), sellerNames, gate: p.gate, approval: ap.approval, attestations: ap.attestations,
  }) }
}

/** Load everything the offer decision compares for the HEAD of the governing packet, and decide. */
export async function loadAndDecideOfferRepresentation(db: Db, p: {
  brokerageId: string; offerId: string
  packet: { sequence: string[]; headOfferId: string; addendumDocumentIds: string[]; transactionIds: string[] }
  gate: { allowed: boolean; refusals: GateRefusal[] }
  asReviewed?: boolean
}): Promise<{ ok: true; decision: RepresentationDecision } | { ok: false; error: string }> {
  const { data: offer, error: oErr } = await db.from("offers")
    .select("id, brokerage_id, offer_price, earnest_money, closing_date, property_address, transaction_id")
    .eq("id", p.offerId).eq("brokerage_id", p.brokerageId).maybeSingle()
  if (oErr) return { ok: false, error: `the offer could not be read: ${oErr.message}` }
  if (!offer) return { ok: false, error: "no such offer in this account" }
  const { data: docs, error: dErr } = await db.from("documents").select(DOC_COLUMNS)
    .eq("brokerage_id", p.brokerageId).filter("metadata->>linked_offer_id", "eq", p.packet.headOfferId)
    .in("classification", ["signed_contract", "counter_offer", "addendum"]).order("created_at", { ascending: false })
  if (dErr) return { ok: false, error: `the offer file could not be read: ${dErr.message}` }
  const rows = (docs ?? []) as EvidenceDocument[]
  // Executed addenda recorded against the contract may live outside the head's file — read them by id.
  const missing = p.packet.addendumDocumentIds.filter((id) => !rows.some((d) => d.id === id))
  if (missing.length) {
    const { data: more, error: mErr } = await db.from("documents").select(DOC_COLUMNS).eq("brokerage_id", p.brokerageId).in("id", missing)
    if (mErr) return { ok: false, error: `the executed addenda could not be read: ${mErr.message}` }
    rows.push(...((more ?? []) as EvidenceDocument[]))
  }
  const ap = await readRepresentationApproval(db, { brokerageId: p.brokerageId, record: "purchase_offer", subjectId: p.offerId })
  if (!ap.ok) return { ok: false, error: ap.error }
  const withStanding = await attachFormStandings(db, p.brokerageId, null, rows)
  rows.splice(0, rows.length, ...withStanding)
  // wave 156 (156R): `asReviewed` — the deal page asks for the packet AS IT WAS REVIEWED (before it became this deal), so the
  // already-a-transaction refusal does not stand in for the packet's own standing.
  const offerRow = p.asReviewed ? { ...(offer as any), transaction_id: null } : (offer as any)
  const packet = p.asReviewed ? { ...p.packet, transactionIds: [] } : p.packet
  return { ok: true, decision: decideOfferRepresentation({
    brokerageId: p.brokerageId, offer: offerRow, packet,
    contractDocuments: rows.filter((d) => d.classification === "signed_contract" || d.classification === "counter_offer"),
    addenda: rows.filter((d) => d.classification === "addendum" || p.packet.addendumDocumentIds.includes(d.id)),
    gate: p.gate, approval: ap.approval, attestations: ap.attestations,
  }) }
}

/**
 * The decision RECEIPT (law 5): one compliance_events row per decision that changed (deduped on the evidence hash + verdict by the
 * caller's prior state). Returns ok:false on a refused or unmatched insert — the caller logs it; the decision itself stands.
 */
export async function recordRepresentationDecision(db: Db, d: RepresentationDecision, actorUserId: string | null, brokerageId: string):
  Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await db.from("compliance_events").insert({
    brokerage_id: brokerageId, gate_name: REPRESENTATION_REVIEW_GATE, entity_type: d.record, entity_id: d.subjectId,
    allowed: d.verdict === "allow", blocked_reason: d.verdict === "allow" ? null : d.blockingReasons.map((r) => r.message).join(" | ").slice(0, 2000),
    severity: d.verdict === "refuse" || d.verdict === "hold" ? "high" : "info", actor_user_id: actorUserId, actor_role: actorUserId ? "user" : "system",
    violations: d.blockingReasons.filter((r) => r.severity !== "review").map((r) => ({ code: r.code, document_id: r.documentId, field: r.field })),
    details: { kind: "decision", verdict: d.verdict, version: d.version, evidence_hash: d.evidenceHash, idempotency_key: d.idempotencyKey,
      reviewer_authority: d.reviewerAuthority.roles, reasons: d.blockingReasons, compared: d.evidence.compared },
  }).select("id")
  if (error) return { ok: false, error: error.message }
  if (!data || (data as unknown[]).length === 0) return { ok: false, error: "the decision receipt matched no row" }
  return { ok: true }
}

/** PURE. The blocker lines a loop writes back and notifies — every one names its document when there is one. */
export function decisionBlockerLines(d: RepresentationDecision): string[] {
  return d.blockingReasons.map((r) => `${r.severity === "review" ? "review" : "hold"}: ${r.message}${r.documentId ? ` [document ${r.documentId}]` : ""}${r.repair ? ` — how it ends: ${r.repair}` : ""}`)
}

// ─── wave 156 (lane 156R) — the seams between lanes 156B and 156C, at the foot ───────────────────────────────────────────────

/** PURE. The form reference an executed document carries, in the order the directory can answer it most precisely. */
export function formReferenceOf(doc: EvidenceDocument): { ref: { packetId?: string | null; providerName?: string | null; providerFormId?: string | null; formCode?: string | null }; version: string | number | null; label: string | null } | null {
  const m = objectOf(doc.metadata)
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  // A working copy staged from the library (lib/forms/form-directory-intake.ts stageLibraryFormOnDeal) names its master and version.
  if (s(m.source_library_form_id)) return { ref: { packetId: s(m.source_library_form_id) }, version: (m.source_library_version as number | string | null) ?? null, label: s(m.source_library_form_id) }
  if (s(m.provider_form_id)) return { ref: { providerName: s(m.provider_name), providerFormId: s(m.provider_form_id) }, version: s(m.provider_form_version), label: s(m.provider_form_id) }
  // The state form number the scanner read off the paper (lib/documents/scan-uploaded-document.ts state_form_id).
  if (s(doc.state_form_id)) return { ref: { formCode: s(doc.state_form_id) }, version: null, label: s(doc.state_form_id) }
  return null
}

/**
 * Read each executed document's form standing ONCE, tenant-pinned, from lane 156C's forms directory (formLicenseStanding) and carry
 * it on the evidence. A refused directory read becomes `read_error` on that document (a HOLD with a retry), never "unknown"; a
 * document that names no form is `unknown` without a read. The tenant is the caller's (the loaders take it from the session-gated
 * caller), never a document value.
 */
export async function attachFormStandings(db: Db, brokerageId: string, fallbackState: string | null, docs: EvidenceDocument[]): Promise<EvidenceDocument[]> {
  const out: EvidenceDocument[] = []
  for (const d of docs) {
    const ref = formReferenceOf(d)
    if (!ref) { out.push({ ...d, form_standing: { standing: "unknown", ref: null, reason: "the document names no form number" } }); continue }
    const state = String(d.state_code ?? objectOf(d.extracted_fields).state ?? fallbackState ?? "").trim().toUpperCase()
    const r = await formLicenseStanding(db, { brokerageId, state, ref: ref.ref, version: ref.version })
    if (!r.ok) { out.push({ ...d, form_standing: { standing: "read_error", ref: ref.label, reason: r.error } }); continue }
    const x = r.result
    out.push({ ...d, form_standing:
      x.standing === "licensed_current" ? { standing: x.standing, ref: ref.label, packetId: x.packetId }
      : x.standing === "retired" ? { standing: x.standing, ref: ref.label, packetId: x.packetId, replacementPacketId: x.replacementPacketId }
      : x.standing === "license_expired" ? { standing: x.standing, ref: ref.label, packetId: x.packetId, expiredOn: x.expiredOn }
      : { standing: "unknown", ref: ref.label, reason: x.reason } })
  }
  return out
}

/**
 * THE SOLO-TIER PRINCIPAL (wave 156, lane 156R) — the existing TIER PARITY rule (lib/auth/require-caller.ts
 * requireTenantAdminOrSoloOwner; lane 156C's resolvePacketActor): a subscriber on a STORED `brokerages.plan_tier = 'solo_agent'`
 * IS their own broker. Here it is narrowed to the producing seat (canonical role `agent`), so a coordinator or a vendor seat on a
 * solo account gains nothing. A refused tier read is an error (fail closed), never "not solo" and never "solo". No new role.
 */
export async function isSoloTierPrincipal(db: Db, p: { brokerageId: string; userType: string | null }): Promise<{ ok: true; isSolo: boolean } | { ok: false; error: string }> {
  const { toCanonicalRole } = await import("@/lib/security/types")
  if (toCanonicalRole(p.userType as never) !== "agent") return { ok: true, isSolo: false }
  const { data, error } = await db.from("brokerages").select("plan_tier").eq("id", p.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `the account's plan could not be read: ${error.message}` }
  return { ok: true, isSolo: (data as { plan_tier?: string | null } | null)?.plan_tier === "solo_agent" }
}

// ── THE LICENSE / VERSION STANDING OF A FORM REFERENCE — lane 156C's reader (wave 156 round 2, written in
// lib/forms/form-directory-intake.ts), MOVED HERE UNCHANGED by lane 156R and re-exported there, so every caller keeps its import.
// Why here: this decision is its consumer, and it is reached from app/crm/page.tsx — importing the intake module (its packet writer,
// provider directory and PDF reader) would have added ~20 modules to that entry, and a module of its own one more. Reads only
// brokerage_form_library (a TYPE-only import of its row shape). ──
const FORM_STANDING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type FormLicenseStanding =
  | { standing: "licensed_current"; packetId: string; version: number | null; providerFormVersion: string | null }
  | { standing: "retired"; packetId: string; replacementPacketId: string | null }
  | { standing: "license_expired"; packetId: string; expiredOn: string }
  | { standing: "unknown"; reason: string }

/**
 * For a TENANT (the caller's session brokerage — never a body value), a STATE, a FORM REFERENCE and optionally the VERSION the
 * paperwork carries: is that form licensed and current in the tenant's directory, retired (with its replacement), license-expired,
 * or unknown to the directory? Reads brokerage_form_library only, tenant-pinned; a refused read is an error, never "unknown".
 *   · ref.packetId — the library row; ref.providerName + ref.providerFormId — an adopted provider form; ref.formCode / ref.name —
 *     matched within the STATE only (case-insensitive), never across states.
 *   · version — the row's integer `version` or the provider's `provider_form_version`. A version that is not the current one is
 *     `retired` with the current row as its replacement (the paperwork used a superseded revision).
 */
export async function formLicenseStanding(
  svc: Db,
  q: { brokerageId: string; state: string; ref: { packetId?: string | null; providerName?: string | null; providerFormId?: string | null; formCode?: string | null; name?: string | null }; version?: string | number | null; now?: Date },
): Promise<{ ok: true; result: FormLicenseStanding } | { ok: false; error: string }> {
  const state = (q.state ?? "").trim().toUpperCase()
  if (!FORM_STANDING_UUID.test(q.brokerageId ?? "")) return { ok: false, error: "no tenant" }
  const { data, error } = await svc.from("brokerage_form_library")
    .select("id, state, name, form_code, version, is_active, license_expires_at, replaced_by_id, provider_name, provider_form_id, provider_form_version")
    .eq("brokerage_id", q.brokerageId)
  if (error) return { ok: false, error: `the form directory could not be read: ${error.message}` }
  type Row = Pick<TenantPacketRow, "id" | "state" | "name" | "form_code" | "version" | "is_active" | "license_expires_at" | "replaced_by_id" | "provider_name" | "provider_form_id" | "provider_form_version">
  const rows = (data ?? []) as Row[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()
  const r = q.ref
  let hits: Row[]
  if (r.packetId) hits = rows.filter((x) => x.id === r.packetId)
  else if (r.providerFormId) hits = rows.filter((x) => x.provider_form_id === r.providerFormId && (!r.providerName || lc(x.provider_name) === lc(r.providerName)))
  else if (r.formCode) hits = rows.filter((x) => lc(x.form_code) === lc(r.formCode))
  else if (r.name) hits = rows.filter((x) => lc(x.name) === lc(r.name))
  else return { ok: true, result: { standing: "unknown", reason: "no form reference given" } }
  hits = hits.filter((x) => String(x.state).toUpperCase() === state)
  if (hits.length === 0) return { ok: true, result: { standing: "unknown", reason: `the directory has no such form for ${state || "that state"}` } }
  const finalOf = (row: Row): Row => { let cur = row; for (let i = 0; i < 10 && !cur.is_active && cur.replaced_by_id && byId.has(cur.replaced_by_id); i++) cur = byId.get(cur.replaced_by_id)!; return cur }
  const active = hits.find((x) => x.is_active) ?? null
  const v = q.version == null || q.version === "" ? null : String(q.version)
  const matchesVersion = (x: Row) => v === null || String(x.version ?? "") === v || (x.provider_form_version ?? "") === v
  const named = v === null ? (active ?? hits[0]) : (hits.find(matchesVersion) ?? null)
  if (!named) {
    return { ok: true, result: active ? { standing: "retired", packetId: hits[0].id, replacementPacketId: active.id } : { standing: "unknown", reason: `version ${v} is not in the directory` } }
  }
  if (!named.is_active) {
    const repl = finalOf(named)
    return { ok: true, result: { standing: "retired", packetId: named.id, replacementPacketId: repl.is_active && repl.id !== named.id ? repl.id : (active?.id ?? null) } }
  }
  const today = (q.now ?? new Date()).toISOString().slice(0, 10)
  if (named.license_expires_at && named.license_expires_at < today) return { ok: true, result: { standing: "license_expired", packetId: named.id, expiredOn: named.license_expires_at } }
  return { ok: true, result: { standing: "licensed_current", packetId: named.id, version: named.version ?? null, providerFormVersion: named.provider_form_version ?? null } }
}
