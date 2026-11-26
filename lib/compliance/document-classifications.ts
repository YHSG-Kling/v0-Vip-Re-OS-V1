/**
 * lib/compliance/document-classifications.ts
 *
 * THE DOCUMENT VOCABULARY, CLIENT-SAFE.
 *
 * These three exports are pure data — the union, its human labels, and which
 * members belong to the seller side of a deal. They were declared inside
 * lib/compliance/required-documents.ts, which is `import "server-only"`, so a
 * client picker could not import the labels it needs to render a classification
 * choice without pulling a server module into the bundle. The audit + resolver
 * stay server-only; the vocabulary lives here and is re-exported there so every
 * existing import keeps working.
 *
 * MIRRORS the live CHECK on documents.classification AND
 * brokerage_required_documents.classification (m356). Adding a member here
 * without the migration produces a value the database refuses — and PostgREST
 * answers a refused write with a RESOLVED promise, so it would fail silently.
 */

export type DocumentClassification =
  | "pre_approval_letter" | "proof_of_funds" | "id_document"
  | "signed_contract"     | "counter_offer"  | "addendum"
  | "disclosure"          | "inspection_report" | "appraisal_report"
  | "title_report"        | "hoa_documents"  | "closing_disclosure"
  | "wire_instructions"   | "agency_disclosure" | "commission_agreement"
  | "lender_letter"       | "earnest_money_receipt"
  // ── SELLER SIDE (m356) ─────────────────────────────────────────────────
  // The vocabulary was buyer-shaped and named neither document a seller side
  // actually turns on. Owner's ruling: the LISTING AGREEMENT must be signed to
  // take on a listing, and a SELLER BROKER AGREEMENT is a DIFFERENT document —
  // they are not interchangeable and a brokerage may require either or both.
  | "listing_agreement"   | "seller_broker_agreement"
  // The preliminary HUD / settlement statement the title company or closing
  // attorney sends. It is the trigger for the agent to fill out the CDA.
  | "preliminary_closing_statement"
  // ── BUYER SIDE (m385) ──────────────────────────────────────────────────
  // The hazard / homeowner's insurance BINDER or declarations page. The lender
  // will not fund without evidence of coverage, typically 7-10 days out, so a
  // brokerage must be able to put this on its required-documents checklist and
  // block or warn on it exactly like any other required document. It is the
  // BUYER'S PROPERTY policy — not a vendor's own certificate of insurance,
  // which is a different subject on a different row
  // (vendors.compliance_credentials, m376).
  | "insurance_binder"
  | "other"

/** Human labels — the raw value is not client-readable. */
export const DOCUMENT_CLASSIFICATION_LABEL: Record<DocumentClassification, string> = {
  pre_approval_letter:           "Pre-approval letter",
  proof_of_funds:                "Proof of funds",
  id_document:                   "Photo ID",
  signed_contract:               "Signed contract",
  counter_offer:                 "Counter offer",
  addendum:                      "Addendum",
  disclosure:                    "Disclosure",
  inspection_report:             "Inspection report",
  appraisal_report:              "Appraisal report",
  title_report:                  "Title report",
  hoa_documents:                 "HOA documents",
  closing_disclosure:            "Closing disclosure",
  wire_instructions:             "Wire instructions",
  agency_disclosure:             "Agency disclosure",
  commission_agreement:          "Commission agreement",
  lender_letter:                 "Lender letter",
  earnest_money_receipt:         "Earnest money receipt",
  listing_agreement:             "Listing agreement",
  seller_broker_agreement:       "Seller broker agreement",
  preliminary_closing_statement: "Preliminary closing statement (HUD)",
  insurance_binder:              "Insurance binder / declarations page",
  other:                         "Other",
}

/** Classifications that belong to the SELLER side of a deal. */
export const SELLER_SIDE_CLASSIFICATIONS: DocumentClassification[] = [
  "listing_agreement",
  "seller_broker_agreement",
  "disclosure",
  "title_report",
  "hoa_documents",
  "preliminary_closing_statement",
]

/**
 * Classifications that CARRY BINDING EXECUTION MARKS — a signature block, and
 * (the owner calls it out separately, so it is tracked separately) initials on
 * the pages that require them. A required document of one of these kinds is not
 * complete when it is merely PRESENT: the transaction-creation gate additionally
 * demands `documents.signature_completeness` show every required party signed
 * AND initialed (lib/compliance/signature-completeness.ts:evaluateExecution).
 *
 * Everything NOT in this set is an evidence document — a pre-approval letter, a
 * proof of funds, an inspection or appraisal report, a title report, HOA docs, a
 * photo ID. Those are complete when present; demanding a buyer's signature on a
 * lender's letter would refuse deals for a mark that document never carries.
 *
 * NOT THE SAME SET as CONTRACT_TYPES/DISCLOSURE_TYPES in
 * lib/kernel/document-compliance-audit.ts, and deliberately so: those key off
 * `client_documents.document_type` (a different table and a different, looser
 * vocabulary that includes non-classification names such as
 * 'purchase_agreement'), while this keys off `documents.classification`, whose
 * members are pinned by the live CHECK above.
 */
export const SIGNATURE_BEARING_CLASSIFICATIONS: DocumentClassification[] = [
  "signed_contract",
  "counter_offer",
  "addendum",
  "disclosure",
  "agency_disclosure",
  "commission_agreement",
  "closing_disclosure",
  "listing_agreement",
  "seller_broker_agreement",
]

/** Does this classification carry signature + initial blocks? Tolerant of a raw value. */
export function classificationCarriesSignatures(value: string | null | undefined): boolean {
  if (!value) return false
  return (SIGNATURE_BEARING_CLASSIFICATIONS as string[]).includes(value)
}

/** Every member of the union, ordered for a picker. */
export const ALL_DOCUMENT_CLASSIFICATIONS =
  Object.keys(DOCUMENT_CLASSIFICATION_LABEL) as DocumentClassification[]

/** Label a raw column value without trusting it to be in the union. */
export function documentClassificationLabel(value: string | null | undefined): string {
  if (!value) return "Unclassified"
  return DOCUMENT_CLASSIFICATION_LABEL[value as DocumentClassification] ?? value
}
