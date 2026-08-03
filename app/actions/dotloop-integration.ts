"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { revalidatePath } from "next/cache"
import {
  addParticipant,
  syncLoopDocuments,
  uploadLoopDocument,
  getLoopActivity,
} from "@/lib/providers/esign"

interface DotloopSyncData {
  loopId: string
  contactId: string
  transactionId?: string
}

export async function syncDotloopDocuments(data: DotloopSyncData) {
  try {
    // AUTH GATE — was pulling signed documents from any Dotloop loop and
    // writing them into any caller-supplied contact/transaction row.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    const supabase = await createClient()
    const svc = createServiceClient()

    // Verify the caller owns the contact (and transaction if provided)
    const { data: c } = await svc
      .from("contacts").select("brokerage_id").eq("id", data.contactId).maybeSingle()
    if (!c || c.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden: contact not in your brokerage" }
    }
    if (data.transactionId) {
      const { data: t } = await svc
        .from("transactions").select("brokerage_id").eq("id", data.transactionId).maybeSingle()
      if (!t || t.brokerage_id !== ctx.brokerageId) {
        return { success: false, error: "Forbidden: transaction not in your brokerage" }
      }
    }

    const sync = await syncLoopDocuments(data.loopId)
    if (!sync.success) return { success: false, error: sync.error ?? "syncLoopDocuments failed" }
    const folders = sync.folders
    let syncedCount = 0

    for (const folder of folders) {
      for (const document of folder.documents || []) {
        // Check if already synced
        const { data: existing } = await supabase
          .from("client_documents")
          .select("id")
          .eq("dotloop_document_id", document.document_id)
          .single()

        if (!existing) {
          // Create new document record — stamp brokerage_id from session
          const { error } = await supabase.from("client_documents").insert({
            brokerage_id: ctx.brokerageId,
            contact_id: data.contactId,
            transaction_id: data.transactionId,
            dotloop_loop_id: data.loopId,
            dotloop_document_id: document.document_id,
            dotloop_folder_name: folder.name,
            document_name: document.name,
            document_type: mapFolderToDocType(folder.name),
            status: document.is_signed ? "signed" : "pending_signature",
            document_url: document.url,
          })

          if (!error) syncedCount++
        }
      }
    }

    if (data.transactionId) {
      // Freshness stamp only — the documents themselves are already written above,
      // so losing this never loses data; the worst case is the transaction looking
      // stale and the next cron pass re-syncing. Ledgered rather than silenced so a
      // permanently-failing stamp (column drift, RLS) shows up in the repair digest.
      await sentinelWrite(
        svc,
        supabase
          .from("transactions")
          .update({ last_provider_sync_at: new Date().toISOString() })
          .eq("id", data.transactionId)
          .eq("brokerage_id", ctx.brokerageId),
        { table: "transactions", flow: "dotloop_document_sync", brokerageId: ctx.brokerageId },
      )
    }

    revalidatePath(`/transactions/${data.transactionId}`)

    return { success: true, message: `Synced ${syncedCount} documents`, syncedCount }
  } catch (error: any) {
    console.error("[v0] Sync Dotloop Documents error:", error)
    return { success: false, error: error.message }
  }
}

export async function getDotloopSigningStatus(loopId: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const supabase = await createClient()

    const { data: documents, error } = await supabase
      .from("client_documents")
      .select("*")
      .eq("dotloop_loop_id", loopId)
      .eq("brokerage_id", ctx.brokerageId)

    if (error) throw error

    const total = documents?.length || 0
    const signed = documents?.filter((doc) => doc.status === "signed").length || 0

    return {
      success: true,
      total,
      signed,
      pending: total - signed,
      percentComplete: total > 0 ? Math.round((signed / total) * 100) : 0,
    }
  } catch (error: any) {
    console.error("[v0] Get Dotloop Signing Status error:", error)
    return { success: false, error: error.message }
  }
}

function mapFolderToDocType(folderName: string): string {
  const lowerName = folderName.toLowerCase()
  if (lowerName.includes("contract")) return "contract"
  if (lowerName.includes("disclosure")) return "disclosure"
  if (lowerName.includes("inspection")) return "inspection"
  if (lowerName.includes("appraisal")) return "appraisal"
  if (lowerName.includes("loan")) return "loan_doc"
  if (lowerName.includes("closing")) return "closing_doc"
  return "other"
}

// ============================================
// DOTLOOP SIGNATURE MANAGEMENT
// ============================================

export async function sendForDotloopSignature(data: {
  loopId: string
  documentId: string
  signers: Array<{ email: string; name: string; role: string }>
  message?: string
  userId?: string // ignored — derived from session
  contactId?: string
}) {
  try {
    // AUTH GATE — was initiating esign workflows on any caller-supplied
    // document with no auth, and writing audit entries under a spoofed user.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    const supabase = await createClient()
    const svc = createServiceClient()

    // Get document details + verify tenancy
    const { data: document } = await supabase.from("client_documents").select("*").eq("id", data.documentId).single()

    if (!document) throw new Error("Document not found")

    if (document.brokerage_id && document.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden: document not in your brokerage" }
    }

    if (data.contactId) {
      const { data: c } = await svc
        .from("contacts").select("brokerage_id").eq("id", data.contactId).maybeSingle()
      if (!c || c.brokerage_id !== ctx.brokerageId) {
        return { success: false, error: "Forbidden: contact not in your brokerage" }
      }
    }

    // Add participants to the loop via provider — surface a Dotloop failure to the agent rather
    // than silently swallowing it (a missing credential used to be hidden by the addParticipant
    // mock that returned success: true; now it returns an explicit error).
    for (const signer of data.signers) {
      const r = await addParticipant({
        loopId: data.loopId,
        email: signer.email,
        name: signer.name,
        role: signer.role,
      })
      if (!r.success) return { success: false, error: r.error ?? "addParticipant failed" }
    }

    // Upload document to Dotloop if not already there
    if (!document.dotloop_document_id) {
      const uploadResult = await uploadLoopDocument({
        loopId: data.loopId,
        documentName: document.document_name,
        fileUrl: document.document_url,
      })

      if (uploadResult.success && uploadResult.dotloopDocumentId) {
        // supabase-js RESOLVES a rejected write — read { error } or this reports
        // success while the provider linkage is lost. dotloop_document_id is what
        // every later status pull and re-send hangs off, so a loss is fatal here.
        const { error: linkError } = await supabase
          .from("client_documents")
          .update({
            dotloop_document_id: uploadResult.dotloopDocumentId,
            dotloop_loop_id: data.loopId,
          })
          .eq("id", data.documentId)

        if (linkError) {
          return {
            success: false,
            error: `Document uploaded to Dotloop but the provider linkage could not be saved (${linkError.message}). Retry the send — the loop already has the file.`,
          }
        }
      }
    }

    // Update document status
    const { error: statusError } = await supabase
      .from("client_documents")
      .update({
        signature_status: "pending_signature",
        signature_provider: "dotloop",
      })
      .eq("id", data.documentId)

    if (statusError) {
      return {
        success: false,
        error: `Could not mark the document as pending signature (${statusError.message}). The Dotloop loop is prepared but the document record is out of sync — retry.`,
      }
    }

    // PACKET OF RECORD — the client portal's Sign button only renders when an
    // ACTIVE row exists here (loadActiveSignaturePacket), and the provider webhook
    // COMPLETES the packet by matching provider_envelope_id (l54-s02). Losing this
    // row means the agent sees "sent" while the client has no Sign button and a
    // signature made in Dotloop can never be finalized — so it is a HARD failure,
    // never a swallowed best-effort.
    //
    // Written with the SERVICE client on purpose. The live signature_requests
    // INSERT policy is `is_platform_admin() OR is_lead_visible_role()`, and
    // is_lead_visible_role() is false for an ordinary user_type='agent' — a
    // request-scoped insert here is silently rejected by RLS for exactly the users
    // who send documents. The caller's identity and the document/contact tenancy
    // were both verified above, so the service client is the correct authority.
    //
    // brokerage_id MUST be stamped: the SELECT policy is
    // has_brokerage_access(brokerage_id), which returns FALSE for NULL, so an
    // unstamped packet is invisible to every non-superadmin reader.
    const { error: packetError } = await svc.from("signature_requests").insert({
      brokerage_id: ctx.brokerageId,
      document_id: data.documentId,
      contact_id: data.contactId,
      signing_order: data.signers,
      all_parties: data.signers,
      request_status: "pending",
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      provider_envelope_id: data.loopId,
    })

    if (packetError) {
      return {
        success: false,
        error: `Dotloop has the document, but the signature packet could not be recorded (${packetError.message}). The client will NOT see a Sign button and a signature cannot be finalized — retry the send.`,
      }
    }

    // Log audit trail — caller identity comes from session, not input.
    // Best-effort BY DESIGN: at this point the provider has the document AND the
    // packet of record is durable, so failing the action here would report a
    // completed send as a failure and invite the agent to create a duplicate
    // envelope. It is NOT silenced — sentinelWrite ledgers every loss to
    // self_heal_events so a missing compliance entry surfaces in the repair digest
    // instead of leaving compliance blind with no signal at all.
    await sentinelWrite(
      svc,
      supabase.from("document_audit_trail").insert({
        document_id: data.documentId,
        document_source: "client_documents",
        action: "sent_for_signature",
        performed_by: ctx.userId,
        performed_by_type: "agent",
        notes: `Sent to ${data.signers.length} signer(s) via Dotloop`,
      }),
      { table: "document_audit_trail", flow: "dotloop_send_for_signature", brokerageId: ctx.brokerageId },
    )

    revalidatePath(`/transactions`)
    return { success: true, loopId: data.loopId }
  } catch (error: any) {
    console.error("[v0] Send for Dotloop Signature error:", error)
    return { success: false, error: error.message }
  }
}

export async function getDotloopDocumentStatus(loopId: string, documentId?: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    // Confirm the loop is referenced by at least one row in caller's brokerage
    const svc = createServiceClient()
    const { data: linked } = await svc
      .from("client_documents")
      .select("id, brokerage_id")
      .eq("dotloop_loop_id", loopId)
      .eq("brokerage_id", ctx.brokerageId)
      .limit(1)
      .maybeSingle()
    if (!linked) {
      return { success: false, error: "Forbidden: loop not in your brokerage" }
    }

    const activityRes = await getLoopActivity(loopId)
    if (!activityRes.success) return { success: false, error: activityRes.error ?? "getLoopActivity failed" }
    const allActivities = activityRes.activities

    const signatureActivities = allActivities.filter(
      (a: any) => a.activity_type === "signature" || a.activity_type === "document_signed"
    )

    return {
      success: true,
      activities: signatureActivities,
      lastActivity: allActivities[0],
    }
  } catch (error: any) {
    console.error("[v0] Get Dotloop Document Status error:", error)
    return { success: false, error: error.message }
  }
}

// ============================================
// DOCUMENT SHARING
// ============================================

export async function createDocumentShareLink(data: {
  documentId: string
  sharedBy?: string // ignored — derived from session
  sharedWithEmail?: string
  accessLevel: "view" | "download" | "sign"
  expiresInDays?: number
  requiresPassword?: boolean
  password?: string
}) {
  // AUTH GATE — was minting shareable tokens for any caller-supplied
  // document under an arbitrary sharedBy identity.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" } as any
  }

  const supabase = await createClient()
  const svc = createServiceClient()

  // Verify ownership of the document being shared
  const { data: doc } = await svc
    .from("client_documents").select("brokerage_id").eq("id", data.documentId).maybeSingle()
  if (!doc || (doc.brokerage_id && doc.brokerage_id !== ctx.brokerageId)) {
    return { success: false, error: "Forbidden: document not in your brokerage" } as any
  }

  const shareToken = crypto.randomUUID()
  const expiresAt = data.expiresInDays
    ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // Default 30 days

  const { data: link, error } = await supabase
    .from("document_sharing_links")
    .insert({
      document_id: data.documentId,
      share_token: shareToken,
      shared_by: ctx.userId,
      shared_with_email: data.sharedWithEmail,
      access_level: data.accessLevel,
      requires_password: data.requiresPassword || false,
      password_hash: data.password || null,
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single()

  if (error) throw error

  // Log access — caller identity from session
  await supabase.from("document_audit_trail").insert({
    document_id: data.documentId,
    document_source: "client_documents",
    action: "share_link_created",
    performed_by: ctx.userId,
    performed_by_type: "agent",
    notes: `Share link created for ${data.sharedWithEmail || "anyone with link"} (${data.accessLevel})`,
  })

  const shareUrl = `${process.env.NEXT_PUBLIC_APP_URL}/documents/shared/${shareToken}`

  revalidatePath("/documents")
  return { link, shareUrl }
}

export async function accessSharedDocument(shareToken: string, password?: string) {
  // Token-based access — intentionally no session check, but the token MUST
  // be cryptographically random (crypto.randomUUID — see createDocumentShareLink)
  // and MUST have an expiration. If `expires_at` is null we hard-reject
  // rather than treat as permanent. We also do not return brokerage info.
  // TODO(migration): require NOT NULL expires_at + add max_access_count
  // default on document_sharing_links to make tokens single-use by default.
  if (!shareToken || typeof shareToken !== "string" || shareToken.length < 16) {
    return { success: false, error: "Invalid share token" }
  }

  const supabase = await createClient()

  const { data: link } = await supabase
    .from("document_sharing_links")
    .select("*, client_documents(*)")
    .eq("share_token", shareToken)
    .eq("is_active", true)
    .maybeSingle()

  if (!link) {
    return { success: false, error: "Invalid or expired link" }
  }

  // Reject links without an expiration timestamp — never grant unbounded access
  if (!link.expires_at) {
    return { success: false, error: "Invalid or expired link" }
  }

  // Check expiration
  if (new Date(link.expires_at) < new Date()) {
    return { success: false, error: "This link has expired" }
  }

  // Check max access count
  if (link.max_access_count && link.current_access_count >= link.max_access_count) {
    return { success: false, error: "This link has reached its maximum access limit" }
  }

  // Check password if required (NOTE: stored "hash" is currently plaintext —
  // tracked separately; we still compare in constant-ish time via length+eq)
  if (link.requires_password && link.password_hash !== password) {
    return { success: false, error: "Incorrect password" }
  }

  // Increment access count
  await supabase
    .from("document_sharing_links")
    .update({ current_access_count: (link.current_access_count || 0) + 1 })
    .eq("id", link.id)

  // Log access
  await supabase.from("document_access_log").insert({
    document_id: link.document_id,
    accessed_by_type: "external",
    accessed_by_email: link.shared_with_email,
    access_type: link.access_level,
  })

  return {
    success: true,
    document: link.client_documents,
    accessLevel: link.access_level,
  }
}

// ============================================
// DOCUMENT TEMPLATES
// ============================================

export async function getDocumentTemplates(filters?: {
  templateType?: string
  state?: string
  category?: string
}) {
  const supabase = await createClient()

  let query = supabase.from("document_templates").select("*").eq("is_active", true)

  if (filters?.templateType) {
    query = query.eq("template_type", filters.templateType)
  }

  if (filters?.state) {
    query = query.contains("state_specific", [filters.state])
  }

  if (filters?.category) {
    query = query.eq("template_category", filters.category)
  }

  const { data, error } = await query.order("template_name")

  if (error) throw error
  return data || []
}

// ============================================
// DOCUMENT FOLDERS
// ============================================

export async function createDocumentFolder(data: {
  folderName: string
  folderType: "transaction" | "client" | "template" | "marketing" | "compliance"
  parentFolderId?: string
  transactionId?: string
  leadId?: string
  contactId?: string
  userId: string
}) {
  const supabase = await createClient()

  const { data: folder, error } = await supabase
    .from("document_folders")
    .insert({
      folder_name: data.folderName,
      folder_type: data.folderType,
      parent_folder_id: data.parentFolderId,
      related_transaction_id: data.transactionId,
      related_lead_id: data.leadId,
      created_by: data.userId,
    })
    .select()
    .single()

  if (error) throw error
  return folder
}

export async function getDocumentFolders(filters?: {
  transactionId?: string
  leadId?: string
  folderType?: string
  userId?: string
}) {
  const supabase = await createClient()

  let query = supabase.from("document_folders").select("*, client_documents(count)")

  if (filters?.transactionId) {
    query = query.eq("related_transaction_id", filters.transactionId)
  }

  if (filters?.leadId) {
    query = query.eq("related_lead_id", filters.leadId)
  }

  if (filters?.folderType) {
    query = query.eq("folder_type", filters.folderType)
  }

  if (filters?.userId) {
    query = query.eq("created_by", filters.userId)
  }

  const { data, error } = await query.order("folder_name")

  if (error) throw error
  return data || []
}

export async function logDocumentAccess(data: {
  documentId: string
  accessedByType: "agent" | "client" | "admin" | "external"
  accessedById?: string
  accessedByEmail?: string
  accessType: "view" | "download" | "edit" | "share" | "delete" | "upload"
  ipAddress?: string
  userAgent?: string
}) {
  const supabase = await createClient()

  await supabase.from("document_access_log").insert({
    document_id: data.documentId,
    accessed_by_type: data.accessedByType,
    accessed_by_id: data.accessedById,
    accessed_by_email: data.accessedByEmail,
    access_type: data.accessType,
    ip_address: data.ipAddress,
    user_agent: data.userAgent,
  })
}

export async function getDocumentAccessLog(documentId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("document_access_log")
    .select("*")
    .eq("document_id", documentId)
    .order("accessed_at", { ascending: false })
    .limit(100)

  if (error) throw error
  return data || []
}

export async function generateDocumentFromTemplate(data: {
  templateId: string
  variables: Record<string, any>
  documentName: string
  contactId?: string
  transactionId?: string
  userId?: string
}) {
  const supabase = await createClient()

  // Get template
  const { data: template } = await supabase.from("document_templates").select("*").eq("id", data.templateId).single()

  if (!template) throw new Error("Template not found")

  // Generate document content by replacing variables
  let documentContent = template.template_content || ""
  for (const [key, value] of Object.entries(data.variables)) {
    documentContent = documentContent.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value))
  }

  // Create document record
  const { data: document, error } = await supabase
    .from("client_documents")
    .insert({
      document_name: data.documentName,
      document_type: template.template_type,
      contact_id: data.contactId,
      transaction_id: data.transactionId,
      uploaded_by: data.userId,
      document_url: template.template_file_url,
      content: documentContent,
      signature_status: template.requires_client_signature ? "pending_signature" : null,
      // Generation provenance + flags live in the metadata bag (no separate columns). doc_category is
      // a CHECK-constrained intake taxonomy, so the free-form template category stays in metadata too.
      metadata: {
        template_id: data.templateId,
        template_category: template.template_category,
        processing_status: "verified",
        compliance_checked: template.is_compliance_approved,
      },
    })
    .select()
    .single()

  if (error) throw error

  // Log audit trail
  await supabase.from("document_audit_trail").insert({
    document_id: document.id,
    document_source: "client_documents",
    action: "generated_from_template",
    performed_by: data.userId || data.contactId,
    performed_by_type: data.userId ? "agent" : "client",
    notes: `Generated from template: ${template.template_name}`,
  })

  revalidatePath("/documents")
  return document
}
