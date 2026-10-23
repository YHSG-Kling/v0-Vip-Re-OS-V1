"use server"

import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { isSignableDocType } from "@/lib/documents/signable-doc-types"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"

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
  userId?: string  // ignored — derived from session
  brokerageId?: string  // ignored — derived from session
}): Promise<{
  success: boolean
  signatureId?: string
  error?: string
  blockedReason?: string
  /** Lane 88C — the in-window step (DocuSign sender view / Google Drive eSignature), when any. */
  handoff?: { mode: "iframe" | "popup"; urls: Array<{ label: string; url: string }>; instructions: string } | null
  dispatchStatus?: "sent" | "awaiting_agent_send"
}> {
  const { transactionId, documentId, docType, docLabel, signers } = params

  if (!isValidUUID(transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }
  if (!signers.length) {
    return { success: false, error: "At least one signer is required" }
  }

  // Auth gate — previously trusted caller-supplied userId + brokerageId,
  // letting any signed-in user send legal documents under any brokerage.
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { success: false, error: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id, team_id")
    .eq("id", authUser.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }
  const userId = authUser.id
  const brokerageId = callerRow.brokerage_id

  const supabase = createServiceClient()

  // Signers must carry an email — the panel's fallback row ("Primary Signer", no email)
  // used to be recorded as a sent request to nobody.
  const addressed = signers.filter((s) => s.email?.trim())
  if (addressed.length === 0) {
    return { success: false, blockedReason: "missing_signer_email", error: "Add the signer's email on the transaction's contact before sending for signature." }
  }

  // ── AGENT READINESS HARD GATE ───────────────────────────────────────────────
  // A license/CE/ethics-blocked agent cannot put a legal document out for signature (regulatory
  // exposure). Canonical evaluator — same verdict as the offer-time gate + the autonomous sweep.
  const { checkAgentTransactable } = await import("@/lib/compliance/agent-readiness-gate")
  const readiness = await checkAgentTransactable(supabase, userId)
  if (!readiness.transactable) {
    return { success: false, error: readiness.message ?? "Agent not clear to transact", blockedReason: readiness.blockers.join("; ") }
  }

  // ── Verify the transaction document exists and belongs to this transaction ─
  // TENANT (lane 88C): the document read now carries the SESSION's brokerage. It matched
  // on (id, transaction_id) alone, so a caller naming another tenant's transaction +
  // document could flip that document to pending_signature from their own account.
  const { data: doc, error: docErr } = await supabase
    .from("transaction_documents")
    .select("id, doc_type, doc_label, status, storage_url")
    .eq("id", documentId)
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (docErr) return { success: false, error: `Could not read the document: ${docErr.message}` }
  if (!doc) return { success: false, error: "Document not found" }
  if (!doc.storage_url) {
    return { success: false, blockedReason: "no_file", error: "This document has no uploaded file yet — upload it before sending for signature." }
  }

  const { data: txn, error: txnErr } = await supabase
    .from("transactions")
    .select("property_address, contact_id")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (txnErr) return { success: false, error: `Could not read the transaction: ${txnErr.message}` }

  // ── ACTUALLY SEND IT (lane 88C) ─────────────────────────────────────────────
  // This action used to pick "the brokerage's newest e-sign credential", write a
  // contract_signatures row saying 'sent' and flip the document to
  // pending_signature — and never call the provider. Nothing left the building; the
  // panel said "Sent". It now goes through the ONE dispatch core (Google eSignature
  // by default, else the agent's/team's/brokerage's API provider) with the
  // document's own file attached, and records the envelope id that the provider
  // webhooks' finalizeVoiceCockpitPacket matches contract_signatures on.
  const { dispatchEsignPacket } = await import("@/lib/esign/dispatch-packet")
  const dispatch = await dispatchEsignPacket(supabase as any, {
    brokerageId,
    userId,
    teamId:          (callerRow.team_id as string | null) ?? null,
    transactionType: "purchase",
    propertyAddress: (txn?.property_address as string | null) ?? docLabel ?? "Transaction document",
    contactId:       (txn?.contact_id as string | null) ?? null,
    signers:         addressed,
    documents:       [{ name: docLabel ?? doc.doc_label ?? docType, url: doc.storage_url as string }],
    recordId:        documentId,
  })
  if (!dispatch.ok) {
    return {
      success: false,
      blockedReason: dispatch.needsReconnect ? "esign_reconnect_required" : "esign_dispatch_failed",
      error: dispatch.error ?? "The signature request could not be sent.",
    }
  }
  const providerKey = dispatch.providerName ?? "unknown"

  // ── Insert contract_signatures record ─────────────────────────────────────
  const { data: sig, error: sigErr } = await supabase
    .from("contract_signatures")
    .insert({
      brokerage_id:         brokerageId,
      agent_id:             await resolveAgentId(supabase as any, userId),
      contract_type:        docType,
      provider_name:        providerKey,
      // A packet staged for the agent to send in the provider window is pending, not sent.
      esign_status:         dispatch.status === "sent" ? "sent" : "pending",
      sent_at:              new Date().toISOString(),
      document_url:         doc.storage_url ?? null,
      provider_envelope_id: dispatch.envelopeId ?? null,
      signing_url:          dispatch.kind === "google" ? (dispatch.handoff?.urls[0]?.url ?? null) : null,
    })
    .select("id")
    .single()

  if (sigErr || !sig) {
    // The request DID go out (dispatch succeeded above) — say so, with the envelope, so
    // the agent does not resend and cut a second envelope.
    return {
      success: false,
      error: `Sent via ${providerKey}${dispatch.envelopeId ? ` (envelope ${dispatch.envelopeId})` : ""}, but the signature record could not be saved${sigErr ? `: ${sigErr.message}` : ""} — do not resend; the signed copy may need to be filed by hand.`,
      handoff: dispatch.handoff ?? null,
    }
  }

  // ── Mark the transaction document as pending_signature ────────────────────
  const { error: pendingSigErr } = await supabase
    .from("transaction_documents")
    .update({ status: "pending_signature", updated_at: new Date().toISOString() })
    .eq("id", documentId)
  if (pendingSigErr) return { success: false, error: `Could not mark the document pending signature: ${pendingSigErr.message}` }

  // ── Emit kernel event — audit row + reactor ───────────────────────────────
  // (was a bare insert with a `?? "document.signature.requested"` fallback that
  // could never fire — the enum member is always defined — and a swallowed outcome.)
  await emitKernelEvent({
    brokerageId,
    entityType:    "transaction_document",
    entityId:      documentId,
    event:         KernelEvent.CONTRACT_SENT_FOR_SIGNATURE,
    transactionId,
    actorUserId:   userId,
    metadata: {
      transaction_id:  transactionId,
      signature_id:    sig.id,
      provider:        providerKey,
      doc_type:        docType,
      signer_count:    signers.length,
    },
  })
  .then(() => {}, () => {}) // fire-and-forget: the send already succeeded

  revalidatePath(`/dashboard/transactions/${transactionId}`)
  return { success: true, signatureId: sig.id, handoff: dispatch.handoff ?? null, dispatchStatus: dispatch.status }
}

// ─── RESEND DOCUMENT FOR SIGNATURE ───────────────────────────────────────────

export async function resendDocumentForSignature(params: {
  signatureId: string
  userId?: string  // ignored — derived from session
  brokerageId?: string  // ignored — derived from session
  transactionId: string
}): Promise<{ success: boolean; error?: string }> {
  const { signatureId, transactionId } = params

  if (!isValidUUID(signatureId)) return { success: false, error: "Invalid signature ID" }

  // Auth gate — previously trusted caller-supplied userId/brokerageId
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { success: false, error: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id")
    .eq("id", authUser.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }

  const supabase = createServiceClient()

  // Verify signature row belongs to caller's brokerage before mutating
  const { data: sig } = await supabase
    .from("contract_signatures")
    .select("brokerage_id")
    .eq("id", signatureId)
    .maybeSingle()
  if (!sig) return { success: false, error: "Signature not found" }
  if (sig.brokerage_id !== callerRow.brokerage_id) return { success: false, error: "Forbidden" }

  const { data: sigSentRows, error: sigSentErr } = await supabase
    .from("contract_signatures")
    .update({ sent_at: new Date().toISOString(), esign_status: "sent", updated_at: new Date().toISOString() })
    .eq("id", signatureId)
    .eq("brokerage_id", callerRow.brokerage_id).select("id")
  if (sigSentErr) return { success: false, error: `Could not mark the signature request sent: ${sigSentErr.message}` }
  if ((sigSentRows ?? []).length === 0) return { success: false, error: `Could not mark the signature request sent: no row matched (not permitted from your account)` }

  revalidatePath(`/dashboard/transactions/${transactionId}`)
  return { success: true }
}

// ─── GET SIGNATURE STATUS FOR TRANSACTION ────────────────────────────────────

export async function getTransactionSignatureStatuses(
  transactionId: string,
  _brokerageId?: string  // ignored — derived from session
): Promise<DocumentSignatureStatus[]> {
  if (!isValidUUID(transactionId)) return []

  // Auth gate — previously accepted any brokerageId, leaking other brokerages' sigs
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return []
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id")
    .eq("id", authUser.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return []

  const supabase = createServiceClient()

  // 🐛 THE transactionId ARGUMENT WAS IGNORED ENTIRELY. This returned EVERY
  // contract_signatures row in the brokerage — every other deal's signatures —
  // from a function named "for transaction". Any surface that trusted the name
  // would have shown one deal's page the signature state of all the others.
  //
  // Verified live: `contract_signatures` carries brokerage_id, agent_id,
  // contract_type and form_id, and NO transaction_id / listing_id. So the
  // transaction link genuinely does not exist on the row and cannot simply be
  // filtered on. What DOES exist is the same resolution the sibling
  // `getUnsignedDocumentBlockers` already uses correctly: `transaction_documents`
  // IS transaction-scoped, so the transaction's own signable doc_types are the
  // bridge, and signatures are narrowed to those contract_types.
  //
  // RESIDUAL LIMIT, stated rather than hidden: two open deals in one brokerage
  // that need the same doc_type still share these rows, because the row has no
  // column that could tell them apart. Closing that needs a `transaction_id` (or
  // `transaction_document_id`) column on `contract_signatures` and a backfill —
  // a migration, deliberately not invented here. Until then this is scoped to the
  // doc types this transaction actually has instead of to nothing at all.
  const { data: docs } = await supabase
    .from("transaction_documents")
    .select("doc_type")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", callerRow.brokerage_id)

  const signableTypes = Array.from(
    new Set((docs ?? []).map((d) => d.doc_type).filter((t): t is string => !!t && isSignableDocType(t))),
  )
  if (signableTypes.length === 0) return []

  const { data } = await supabase
    .from("contract_signatures")
    .select("id, contract_type, provider_name, provider_envelope_id, esign_status, sent_at, agent_signed_at, fully_signed_at, document_url, created_at")
    .eq("brokerage_id", callerRow.brokerage_id)
    .in("contract_type", signableTypes)
    .order("created_at", { ascending: false })

  return data ?? []
}

// ─── GET UNSIGNED DOCUMENT BLOCKERS ─────────────────────────────────────────
// Returns signable documents that are NOT fully_signed — used for readiness blockers.

export async function getUnsignedDocumentBlockers(
  transactionId: string,
  _brokerageId?: string  // ignored — derived from session
): Promise<Array<{ docId: string; docLabel: string; docType: string; signatureId: string | null; esignStatus: string | null }>> {
  if (!isValidUUID(transactionId)) return []

  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return []
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id")
    .eq("id", authUser.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return []
  const brokerageId = callerRow.brokerage_id

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
  }, {} as Record<string, NonNullable<typeof sigs>[0]>)

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
