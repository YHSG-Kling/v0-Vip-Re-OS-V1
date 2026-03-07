"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { getTransactionProvider } from "@/lib/integrations"

export async function syncOfferDocumentsFromProvider(offerId: string, userId: string) {
  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Get offer
  const { data: offer } = await supabase
    .from("offers")
    .select("id, external_provider, external_provider_id, transaction_id")
    .eq("id", offerId)
    .single()

  if (!offer?.external_provider || !offer.external_provider_id) {
    return { success: false, error: "Offer not linked to provider" }
  }

  try {
    // Get provider instance
    const provider = await getTransactionProvider(offer.external_provider)

    // Fetch documents from provider
    const documents = await provider.getDocuments(offer.external_provider_id)

    // Sync to client_documents table
    for (const doc of documents) {
      const { error: insertError } = await supabase
        .from("client_documents")
        .upsert({
          transaction_id: offer.transaction_id,
          document_name: doc.name,
          document_type: doc.type,
          external_url: doc.url,
          external_provider: offer.external_provider,
          external_provider_id: doc.id,
          status: doc.signed ? "signed" : "pending",
          uploaded_by: userId
        }, {
          onConflict: "external_provider_id"
        })

      if (insertError) {
        console.error("[v0] Failed to sync document:", doc.name, insertError)
      }
    }

    // Emit sync event
    await supabase.from("activities").insert({
      activity_type: "buyer.offer.documents.synced",
      user_id: userId,
      metadata: {
        offer_id: offerId,
        provider: offer.external_provider,
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
