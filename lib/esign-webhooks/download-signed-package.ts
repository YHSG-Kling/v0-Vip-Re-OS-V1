/**
 * lib/esign-webhooks/download-signed-package.ts
 *
 * Pull every signed document from the e-sign provider after the envelope
 * completes, store each one in our `documents` table (with its storage URL),
 * fire the universal classifier, and link to the right transaction / offer /
 * contact / listing.
 *
 * Used by the webhook finalizer (lib/esign-webhooks/finalize-packet.ts) so
 * the agent ends up with the executed contract + every signed addendum +
 * counter PDF organized in the deal file, not stuck in the provider.
 *
 * The provider client's syncDocuments() method (added in
 * lib/integrations/providers/transaction-provider.interface.ts) returns
 * ProviderDocument[] with name + isSigned + url. We feed each through
 * uploadDocument so the scanner classifies them (signed_contract,
 * counter_offer, addendum, disclosure, etc.).
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

export interface DownloadParams {
  envelopeId:     string
  /** offers row already matched by the finalizer (we get the brokerage_id + linked entities from it). */
  matchedOffer: {
    id:             string
    brokerage_id:   string
    contact_id:     string | null
    agent_id:       string | null
    transaction_id: string | null
  }
  provider:        "dotloop" | "docusign" | "skyslope" | "authentisign"
}

export interface DownloadResult {
  success:           boolean
  documents_synced:  number
  documents_stored:  number
  error?:            string
}

/**
 * Resolve the brokerage's configured provider client (using the same cascade
 * the dispatch path uses), call syncDocuments(envelopeId), and stream each
 * signed file into the deal file via uploadDocument (which fires the
 * classifier).
 */
export async function downloadSignedPackage(
  supabase: SupabaseClient,
  params: DownloadParams,
): Promise<DownloadResult> {
  const { envelopeId, matchedOffer, provider } = params

  try {
    // Resolve provider client (re-uses the dispatch-time cascade). We need
    // a users.id-style actor for the resolver; the offer's agent (agents.id)
    // gives us a brokerage-scoped client, which is what we need anyway —
    // the envelope was dispatched against THIS brokerage's credentials.
    const { resolveESignProviderForActor } = await import("@/lib/integrations/resolve-esign-provider")

    let resolved: any
    try {
      // Map agents.id → users.id for the actor scope when known
      let actorUserId: string | undefined = undefined
      if (matchedOffer.agent_id) {
        const { data: agentRow } = await supabase
          .from("agents")
          .select("user_id")
          .eq("id", matchedOffer.agent_id)
          .maybeSingle()
        actorUserId = (agentRow?.user_id as string | undefined) ?? undefined
      }
      resolved = await resolveESignProviderForActor({
        brokerageId: matchedOffer.brokerage_id,
        userId:      actorUserId,
      })
    } catch (err: any) {
      return { success: false, documents_synced: 0, documents_stored: 0, error: err?.message ?? "provider unresolved" }
    }

    // The resolved provider's actual name should match what the webhook says;
    // tolerate mismatch (some brokerages have multiple creds), but log it.
    if (resolved.providerName && resolved.providerName !== provider) {
      console.warn(`[download-signed-package] webhook=${provider} resolved=${resolved.providerName} — using resolved client`)
    }

    const syncResult = await resolved.provider.syncDocuments({
      externalTransactionId: envelopeId,
      contactId:             matchedOffer.contact_id ?? "",
      transactionId:         matchedOffer.transaction_id ?? undefined,
    })
    if (!syncResult.success) {
      return { success: false, documents_synced: 0, documents_stored: 0, error: syncResult.error ?? "syncDocuments failed" }
    }

    const docs = syncResult.documents ?? []
    if (docs.length === 0) {
      return { success: true, documents_synced: 0, documents_stored: 0 }
    }

    const { uploadDocument } = await import("@/lib/documents/upload-document")
    let stored = 0
    for (const d of docs) {
      // Hint document_type so the classifier has a starting point. Signed
      // copies → 'signed_contract'; the scanner refines to counter_offer /
      // addendum / disclosure / etc. based on content.
      const hintType = d.isSigned ? "signed_contract" : "uploaded_document"
      const r = await uploadDocument({
        brokerageId:   matchedOffer.brokerage_id,
        storageUrl:    d.url ?? "",
        fileName:      d.documentName ?? `Document ${d.externalDocumentId}`,
        documentType:  hintType,
        contactId:     matchedOffer.contact_id,
        offerId:       matchedOffer.id,
        transactionId: matchedOffer.transaction_id,
        metadata: {
          envelope_id:        envelopeId,
          provider,
          external_document_id: d.externalDocumentId,
          folder_name:        d.folderName,
          provider_uploaded_at: d.uploadedAt,
          provider_last_modified: d.lastModified,
          is_signed:          !!d.isSigned,
          signers:            d.signers ?? null,
        },
      })
      if (r.success) stored++
    }

    return { success: true, documents_synced: docs.length, documents_stored: stored }
  } catch (err: any) {
    console.error("[download-signed-package] failed:", err?.message ?? err)
    return { success: false, documents_synced: 0, documents_stored: 0, error: err?.message ?? "unknown" }
  }
}
