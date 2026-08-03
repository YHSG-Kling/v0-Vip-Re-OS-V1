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

/** Every member of the union, ordered for a picker. */
export const ALL_DOCUMENT_CLASSIFICATIONS =
  Object.keys(DOCUMENT_CLASSIFICATION_LABEL) as DocumentClassification[]

/** Label a raw column value without trusting it to be in the union. */
export function documentClassificationLabel(value: string | null | undefined): string {
  if (!value) return "Unclassified"
  return DOCUMENT_CLASSIFICATION_LABEL[value as DocumentClassification] ?? value
}
