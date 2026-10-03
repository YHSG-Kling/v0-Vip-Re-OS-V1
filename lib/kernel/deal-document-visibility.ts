/**
 * lib/kernel/deal-document-visibility.ts — PURE (no imports; client-safe).
 *
 * The ONE rule for which deal documents (transaction_documents) a portal CLIENT sees —
 * wave 98 owner ruling. Read through lib/kernel/portal.ts portalDealClient (the gate),
 * filtered here. Consumers: app/portal/[contactId]/documents/page.tsx,
 * app/actions/portal-seller.ts getSellerDocuments, app/actions/documents.ts
 * getDocumentWithAnalysis, the staff toggle (lib/application/transactions.ts
 * setDocumentClientVisibility + app/dashboard/transactions/[id]/transaction-detail-client.tsx).
 */

// ─── CLIENT-VISIBLE DEAL DOCUMENTS (wave 98, owner: "yes and the docs they uploaded") ──────────
//
// A portal client sees a deal document (transaction_documents) ONLY when (a) staff marked it
// client_visible (m690; the staff toggle is app/actions/transactions.ts setDocumentClientVisibility)
// or (b) the client uploaded it themselves (uploaded_by = their own auth user). Deny by default.
// The commission disbursement form, CDA copies and internal paperwork are NEVER shown — the type
// deny-list below wins over the flag, so a mis-click cannot publish one. Every portal reader of
// transaction_documents (the documents page, getSellerDocuments, getDocumentWithAnalysis) reads
// through portalDealClient and filters with these two functions; `notes` (internal) is never selected.

/** Named deal-document types a client never sees, whatever the flag says. */
const CLIENT_HIDDEN_DEAL_DOC_TYPES: ReadonlySet<string> = new Set([
  "cda",
  "cda_check_copy",
  "commission_disbursement_authorization",
  "commission_disbursement",
  "commission_split",
  "internal",
  "internal_note",
  "internal_notes",
])
/** …and any spelling that carries one of these words as a segment (cda_signed, broker_internal_memo …).
 *  NOT "commission" on its own: `commission_agreement` is the classification of the Buyer Broker
 *  Agreement the CLIENT signs (lib/compliance/required-doc-presets.ts) — their document, not the
 *  brokerage's books. */
const CLIENT_HIDDEN_DOC_SEGMENT = /(^|[_\-\s])(cda|disbursement|internal)([_\-\s]|$)/i

/** The deny-list test (the staff toggle hides its switch on it; the readers apply it via isClientVisibleDealDocument). */
export function isClientHiddenDealDocType(docType: string | null | undefined): boolean {
  const t = String(docType ?? "").trim().toLowerCase()
  return CLIENT_HIDDEN_DEAL_DOC_TYPES.has(t) || CLIENT_HIDDEN_DOC_SEGMENT.test(t)
}

/**
 * The visibility RULE for one deal document and one viewer. Pure. A denied type is hidden even
 * when marked visible or self-uploaded; otherwise visible when marked, or when the viewer uploaded it.
 */
export function isClientVisibleDealDocument(
  doc: { client_visible?: boolean | null; uploaded_by?: string | null; doc_type?: string | null },
  viewerUserId: string | null,
): boolean {
  if (isClientHiddenDealDocType(doc.doc_type)) return false
  if (doc.client_visible === true) return true
  return !!viewerUserId && !!doc.uploaded_by && doc.uploaded_by === viewerUserId
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The PostgREST `.or()` half of the rule (narrows the read; isClientVisibleDealDocument still runs after). */
export function clientDealDocumentFilter(viewerUserId: string | null): string {
  return viewerUserId && UUID_SHAPE.test(viewerUserId)
    ? `client_visible.eq.true,uploaded_by.eq.${viewerUserId}`
    : "client_visible.eq.true"
}

