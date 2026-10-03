import { createClient } from "@/lib/supabase/server"
import { CONTRACT_ESIGN_AWAITING_STATUSES } from "@/lib/transactions/coordination-status"
import { clientTransactionFilter, portalDealClient, scopeToDealTenant, readClientDocumentVisibilityFlags } from "@/lib/kernel/portal"
import { clientDealDocumentFilter, isClientVisibleDealDocument, isClientVisibleClientDocument } from "@/lib/kernel/deal-document-visibility"
import { redirect } from "next/navigation"
import { DocumentsClient } from "./DocumentsClient"
import { syncAllForContact } from "@/lib/transactions/sync-from-provider"

export default async function DocumentsPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Get contact for brokerage_id
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, brokerage_id")
    .eq("id", contactId)
    .single()

  if (!contact) {
    redirect("/portal?error=contact_not_found")
  }

  // Provider sync — pull fresh document state from the brokerage's CONFIGURED transaction
  // provider (Dotloop / SkySlope / Brokermint / FormSimplicity) into transaction_documents
  // BEFORE the read below. Without this the portal only ever shows what the legacy Dotloop
  // sync wrote — brokerages on other providers saw zero documents despite their provider
  // holding the real data. Never-throws; throttled to once per 5 min via
  // transactions.last_provider_sync_at; degrades to showing DB cache on provider error.
  if (contact.brokerage_id) {
    try {
      await syncAllForContact({ brokerageId: contact.brokerage_id, contactId })
    } catch (e) {
      console.error("[portal-documents] provider sync failed:", e)
    }
  }

  // STEP 1 — Resolve transaction IDs (never use Supabase subquery in .in()). The
  // client's own session sees none of its deals, so the ids come through the kernel's
  // gate-then-service deal client (lib/kernel/portal.ts portalDealClient), scoped to
  // this contact + tenant.
  const { client: dealDb, brokerageId: dealTenant } = await portalDealClient(supabase, contactId)
  const { data: transactions, error: txError } = await scopeToDealTenant(
    dealDb
      .from("transactions")
      .select("id")
      .or(clientTransactionFilter(contactId)),
    dealTenant,
  )
  if (txError) console.error("[portal/documents] deal read refused:", txError.message)

  const transactionIds = transactions?.map(t => t.id) ?? []
  // The viewer — "the docs they uploaded" is decided against THIS user, never a parameter.
  const { data: { user: viewer } } = await supabase.auth.getUser()
  const viewerUserId = viewer?.id ?? null

  // STEP 2 — Fetch client documents (the client's own folder: contact_id = them). Same
  // gate as the deals: elevated only when requireContactAccess admitted the caller, and
  // then pinned to this contact + the gate's tenant. `notes` is never selected.
  const { data: clientDocsRaw, error: clientDocsError } = await scopeToDealTenant(
    dealDb
      .from("client_documents")
      .select(`id, document_name, document_url, document_type, doc_category,
             is_financial_verification, verification_amount, verification_lender,
             expiration_date, verified_by, verified_at, uploaded_by, created_at`)
      .eq("contact_id", contactId),
    dealTenant,
  ).order("created_at", { ascending: false })
  if (clientDocsError) console.error("[portal/documents] client documents read refused:", clientDocsError.message)
  // Wave 100 (lane 100C): the client's own folder follows THE deal-document rule — staff-shown
  // (client_documents.client_visible, m695, the Document Center switch) or self-uploaded, and never a
  // denied type (asked of document_type AND doc_category). Flags read apart so a refusal fails closed
  // without hiding what the client uploaded (lib/kernel/portal.ts readClientDocumentVisibilityFlags).
  const clientDocFlags = await readClientDocumentVisibilityFlags(dealDb, (clientDocsRaw ?? []).map((d: { id: string }) => d.id))
  const clientDocs = (clientDocsRaw ?? []).filter((d: { id: string; uploaded_by?: string | null; document_type?: string | null; doc_category?: string | null }) =>
    isClientVisibleClientDocument({ ...d, client_visible: clientDocFlags.get(d.id) === true }, viewerUserId))

  // STEP 3 — Deal documents the CLIENT may see (wave 98 owner ruling): staff-marked
  // client_visible (m690) or uploaded by this viewer — never the CDA / disbursement /
  // internal paperwork (isClientVisibleDealDocument re-checks every row after the
  // narrowing .or()), and never the internal `notes` column. Before m690 is applied the
  // read is REFUSED (42703) and the client sees no deal documents: fail closed.
  const { data: txDocsRaw, error: txDocsError } = transactionIds.length > 0
    ? await scopeToDealTenant(
        dealDb
          .from("transaction_documents")
          .select(`id, transaction_id, doc_type, doc_label, status, storage_url,
                   uploaded_at, extracted_data, classification_confidence,
                   rejection_reason, client_visible, uploaded_by`)
          .in("transaction_id", transactionIds)
          .or(clientDealDocumentFilter(viewerUserId)),
        dealTenant,
      ).order("uploaded_at", { ascending: false })
    : { data: [], error: null }
  if (txDocsError) console.error("[portal/documents] deal documents read refused:", txDocsError.message)
  const txDocs = ((txDocsRaw ?? []) as Array<{ id: string; client_visible?: boolean | null; uploaded_by?: string | null; doc_type?: string | null; [k: string]: unknown }>)
    .filter((d) => isClientVisibleDealDocument(d, viewerUserId))
    .map((d) => ({ ...d, notes: null }))

  // STEP 4 — Fetch extraction log for the VISIBLE transaction docs only (ids from the
  // filtered list above, so the elevated read cannot reach a hidden document's analysis)
  const txDocIds = txDocs.map(d => d.id as string)
  const { data: extractionLogs } = txDocIds.length > 0
    ? await dealDb
        .from("document_extraction_log")
        .select(`id, transaction_doc_id, extraction_method, extracted_fields,
                 confidence_score, processing_status, processed_at, error_message`)
        .in("transaction_doc_id", txDocIds)
        // FAILED extractions belong on this list too. This filter was
        // `.eq("processing_status", "completed")` while the select asks for
        // `error_message` — a completed extraction has no error by definition,
        // so the column could not have been non-null on a single row this query
        // returns. (It was doubly dead until now: neither writer of this table
        // logged a failure at all — see the catch block at
        // app/actions/ai-transaction-documents.ts, which now does.) A client
        // whose document could not be read was shown nothing, which reads as
        // "still processing" forever.
        .in("processing_status", ["completed", "failed"])
        .order("processed_at", { ascending: false })
    : { data: [] }

  // STEP 5 — Fetch document checklist
  const { data: checklist } = transactionIds.length > 0
    ? await supabase
        .from("document_checklist")
        .select(`id, transaction_id, required_documents, verified_count,
                 total_count, status`)
        .in("transaction_id", transactionIds)
    : { data: [] }

  // STEP 6 — Fetch document classifications for routing metadata
  const { data: classifications } = await supabase
    .from("document_classifications")
    .select("doc_type, filing_folder, requires_review, auto_route")
    .eq("brokerage_id", contact.brokerage_id)

  // STEP 6b — Fetch pending e-sign envelopes the contact needs to sign
  // (contract_signatures are scoped by brokerage_id; contact match via agent ownership is handled by RLS)
  const { data: pendingSignatures } = await supabase
    .from("contract_signatures")
    .select("id, contract_type, provider_name, document_url, sent_at, esign_status")
    .eq("brokerage_id", contact.brokerage_id)
    // 'out_for_signature' is not a value this ladder has, and the set omitted
    // 'viewed' and 'agent_signed' — so an envelope the contact OPENED, or one
    // their agent had already signed, dropped off their own to-sign list.
    .in("esign_status", [...CONTRACT_ESIGN_AWAITING_STATUSES])
    .order("sent_at", { ascending: false })
    .limit(20)

  // STEP 7 — Fetch state compliance requirements for doc types present
  const uniqueDocTypes = [...new Set([
    ...(txDocs.map(d => d.doc_type as string | null).filter(Boolean)),
    ...(clientDocs.map((d: { document_type?: string | null }) => d.document_type).filter(Boolean)),
  ])]

  const { data: stateRequirements } = uniqueDocTypes.length > 0
    ? await supabase
        .from("state_compliance_requirements")
        .select("state, document_type, requirement_name, description, is_mandatory, timeline_days")
        .in("document_type", uniqueDocTypes)
    : { data: [] }

  return (
    <DocumentsClient
      contactId={contactId}
      clientDocs={clientDocs}
      txDocs={txDocs as any}
      extractionLogs={extractionLogs ?? []}
      checklist={checklist ?? []}
      classifications={classifications ?? []}
      stateRequirements={stateRequirements ?? []}
      pendingSignatures={pendingSignatures ?? []}
    />
  )
}
