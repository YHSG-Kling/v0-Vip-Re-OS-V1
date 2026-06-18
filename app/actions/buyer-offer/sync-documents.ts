"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { getTransactionProvider } from "@/lib/integrations"

const DOCUMENT_TYPE_MAP: Record<string, string> = {
  purchase_agreement: "purchase_agreement",
  purchase_contract: "purchase_agreement",
  contract: "purchase_agreement",
  loan_documents: "financial_docs",
  financial: "financial_docs",
  financing: "financial_docs",
  title_report: "title_docs",
  title: "title_docs",
  inspection: "inspection_docs",
  inspection_report: "inspection_docs",
  disclosure: "disclosure_docs",
  disclosures: "disclosure_docs",
  closing: "closing_docs",
  closing_documents: "closing_docs",
}

function normalizeDocumentType(folderName: string): string {
  const key = folderName.toLowerCase().replace(/[\s-]+/g, "_")
  return DOCUMENT_TYPE_MAP[key] ?? "other"
}

export async function syncOfferDocumentsFromProvider(offerId: string, userId: string) {
  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Get offer — esign_provider + provider_envelope_id are the real link columns
  // (offer-bridge maps them to transactions.external_provider_source/_transaction_id).
  const { data: offer } = await supabase
    .from("offers")
    .select("id, brokerage_id, contact_id, esign_provider, provider_envelope_id, transaction_id")
    .eq("id", offerId)
    .single()

  if (!offer?.esign_provider || !offer.provider_envelope_id) {
    return { success: false, error: "Offer not linked to provider" }
  }

  // Provider-synced documents are transaction artifacts; transaction_documents requires a
  // transaction. Without one we cannot file them (client_documents intentionally carries no
  // external-provider linkage, to avoid duplicating it).
  if (!offer.transaction_id) {
    return { success: false, error: "Offer not linked to a transaction; cannot file documents" }
  }

  try {
    // Get provider instance (resolved from the brokerage's configured provider)
    const provider = await getTransactionProvider(offer.brokerage_id)

    // Fetch documents from provider
    const syncResult = await provider.syncDocuments({
      externalTransactionId: offer.provider_envelope_id,
      contactId: offer.contact_id ?? "",
      transactionId: offer.transaction_id,
    })

    if (!syncResult.success) {
      return { success: false, error: syncResult.error ?? "Provider sync failed" }
    }

    const documents = syncResult.documents ?? []

    // Sync provider documents to transaction_documents — the canonical store for transaction
    // artifacts synced from an esign provider (external_document_id + provider_source are its
    // native linkage). client_documents has no external-provider columns by design, so these live
    // here with zero duplication. Upsert keys the partial unique index
    // (transaction_id, provider_source, external_document_id) for idempotent re-sync.
    for (const doc of documents) {
      const { error: insertError } = await supabase
        .from("transaction_documents")
        .upsert({
          transaction_id: offer.transaction_id,
          brokerage_id: offer.brokerage_id,
          doc_label: doc.documentName ?? "Document",
          doc_type: normalizeDocumentType(doc.folderName),
          storage_url: doc.url,
          provider_source: offer.esign_provider,
          external_document_id: doc.externalDocumentId,
          // transaction_documents.status lifecycle (check-constrained): a signed esign doc is final
          // → 'approved'; an unsigned synced doc is present but not finalized → 'uploaded'.
          status: doc.isSigned ? "approved" : "uploaded",
          uploaded_by: userId
        }, {
          onConflict: "transaction_id,provider_source,external_document_id"
        })

      if (insertError) {
        console.error("[v0] Failed to sync document:", doc.documentName, insertError)
      }
    }

    // Emit sync event
    await supabase.from("activities").insert({
      activity_type: "buyer.offer.documents.synced",
      agent_user_id: userId,
      metadata: {
        offer_id: offerId,
        provider: offer.esign_provider,
        document_count: documents.length
      }
    })

    return {
      success: true,
      documentCount: documents.length
    }
  } catch (error) {
    console.error("[v0] Document sync failed:", error)
    return {
      success: false,
      error: "Failed to sync documents from provider"
    }
  }
}
