"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { isSignableDocType } from "@/lib/documents/signable-doc-types"
import { KernelEvent } from "@/lib/kernel/events"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface DocumentSignatureStatus {
  id: string
  contract_type: string
  provider_name: string | null
  provider_envelope_id: string | null
  esign_status: string
  sent_at: string | null
  agent_signed_at: string | null
  fully_signed_at: string | null
  document_url: string | null
  created_at: string
}

// ─── SEND DOCUMENT FOR SIGNATURE ─────────────────────────────────────────────
// Resolves the brokerage's esign provider (via provider_overrides cascade),
// creates a contract_signatures record, and marks the transaction_document
// as pending_signature. Contacts (buyer/seller) have no provider — this
// is entirely a brokerage/agent-owned configuration.

export async function sendDocumentForSignature(params: {
  transactionId: string
  documentId: string
  docType: string
  docLabel: string | null
  signers: Array<{ name: string; email: string; role: string }>
  userId: string
  brokerageId: string
}): Promise<{ success: boolean; signatureId?: string; error?: string; blockedReason?: string }> {
  const { transactionId, documentId, docType, docLabel, signers, userId, brokerageId } = params

  if (!isValidUUID(transactionId) || !isValidUUID(brokerageId)) {
    return { success: false, error: "Invalid IDs" }
  }
  if (!signers.length) {
    return { success: false, error: "At least one signer is required" }
  }

  const supabase = createServiceClient()

  // ── Verify the transaction document exists and belongs to this transaction ─
  const { data: doc, error: docErr } = await supabase
    .from("transaction_documents")
    .select("id, doc_type, doc_label, status, storage_url")
    .eq("id", documentId)
    .eq("transaction_id", transactionId)
    .single()

  if (docErr || !doc) {
    return { success: false, error: "Document not found" }
  }

  // ── Resolve the brokerage's esign provider from platform_credentials ────
  // Providers are owned by the brokerage/team/agent — NOT by the contact.
  const { data: credential } = await supabase
    .from("platform_credentials")
    .select("platform")
    .eq("brokerage_id", brokerageId)
    .in("platform", ["dotloop", "docusign", "skyslope", "authentisign"])
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!credential) {
    return {
      success: false,
      blockedReason: "no_provider",
      error: "No e-sign provider configured. Connect one in Settings > Integrations.",
    }
  }

  const providerKey = credential.platform

  // ── Insert contract_signatures record ─────────────────────────────────────
  const { data: sig, error: sigErr } = await supabase
    .from("contract_signatures")
    .insert({
      brokerage_id:       brokerageId,
      agent_id:           userId,
      contract_type:      docType,
      provider_name:      providerKey,
      esign_status:       "sent",
      sent_at:            new Date().toISOString(),
      document_url:       doc.storage_url ?? null,
    })
    .select("id")
    .single()

  if (sigErr || !sig) {
    return { success: false, error: "Failed to create signature record" }
  }

  // ── Mark the transaction document as pending_signature ────────────────────
  await supabase
    .from("transaction_documents")
    .update({ status: "pending_signature", updated_at: new Date().toISOString() })
    .eq("id", documentId)

  // ── Emit kernel event for audit ───────────────────────────────────────────
  await supabase.from("lifecycle_events").insert({
    brokerage_id:  brokerageId,
    entity_type:   "transaction_document",
    entity_id:     documentId,
    event_type:    KernelEvent.DOCUMENT_SENT_FOR_SIGNATURE ?? "document.signature.requested",
    actor_user_id: userId,
    metadata: {
      transaction_id:  transactionId,
      signature_id:    sig.id,
      provider:        providerKey,
      doc_type:        docType,
      signer_count:    signers.length,
    },
  })
  .catch(() => {}) // fire-and-forget: silent fail on audit log errors

  revalidatePath(`/dashboard/transactions/${transactionId}`)
  return { success: true, signatureId: sig.id }
}

// ─── RESEND DOCUMENT FOR SIGNATURE ───────────────────────────────────────────

export async function resendDocumentForSignature(params: {
  signatureId: string
  userId: string
  brokerageId: string
  transactionId: string
}): Promise<{ success: boolean; error?: string }> {
  const { signatureId, userId, brokerageId, transactionId } = params

  if (!isValidUUID(signatureId)) return { success: false, error: "Invalid signature ID" }

  const supabase = createServiceClient()

  await supabase
    .from("contract_signatures")
    .update({ sent_at: new Date().toISOString(), esign_status: "sent", updated_at: new Date().toISOString() })
    .eq("id", signatureId)
    .eq("brokerage_id", brokerageId)

  revalidatePath(`/dashboard/transactions/${transactionId}`)
  return { success: true }
}

// ─── GET SIGNATURE STATUS FOR TRANSACTION ────────────────────────────────────

export async function getTransactionSignatureStatuses(
  transactionId: string,
  brokerageId: string
): Promise<DocumentSignatureStatus[]> {
  if (!isValidUUID(transactionId)) return []

  // contract_signatures is brokerage-scoped; filter by brokerage for safety
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("contract_signatures")
    .select("id, contract_type, provider_name, provider_envelope_id, esign_status, sent_at, agent_signed_at, fully_signed_at, document_url, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  // contract_signatures has no transaction_id FK — we filter by those inserted
  // during this transaction's documents workflow (they share brokerage_id + agent context).
  // Return all for the brokerage; the caller filters by transaction doc types.
  return data ?? []
}

// ─── GET UNSIGNED DOCUMENT BLOCKERS ─────────────────────────────────────────
// Returns signable documents that are NOT fully_signed — used for readiness blockers.

export async function getUnsignedDocumentBlockers(
  transactionId: string,
  brokerageId: string
): Promise<Array<{ docId: string; docLabel: string; docType: string; signatureId: string | null; esignStatus: string | null }>> {
  if (!isValidUUID(transactionId)) return []

  const supabase = createServiceClient()

  // Get transaction documents that are signable
  const { data: docs } = await supabase
    .from("transaction_documents")
    .select("id, doc_type, doc_label, status")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)

  if (!docs?.length) return []

  const signable = docs.filter(d => isSignableDocType(d.doc_type))
  if (!signable.length) return []

  // Get latest signature records per contract_type for this brokerage
  const { data: sigs } = await supabase
    .from("contract_signatures")
    .select("id, contract_type, esign_status, fully_signed_at")
    .eq("brokerage_id", brokerageId)
    .in("contract_type", signable.map(d => d.doc_type))
    .order("created_at", { ascending: false })

  const sigByType = (sigs ?? []).reduce((acc, s) => {
    if (!acc[s.contract_type]) acc[s.contract_type] = s
    return acc
  }, {} as Record<string, typeof sigs[0]>)

  return signable
    .filter(d => {
      const sig = sigByType[d.doc_type!]
      // Blocker if: no signature record yet, or esign_status != fully_signed
      return !sig || sig.esign_status !== "fully_signed"
    })
    .map(d => {
      const sig = sigByType[d.doc_type!]
      return {
        docId:        d.id,
        docLabel:     d.doc_label ?? d.doc_type ?? "Document",
        docType:      d.doc_type ?? "",
        signatureId:  sig?.id ?? null,
        esignStatus:  sig?.esign_status ?? null,
      }
    })
}
