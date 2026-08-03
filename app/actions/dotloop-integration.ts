"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { hashSharePassword, verifySharePassword } from "@/lib/security/share-password"
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
    // brokerage_id MUST be stamped. Every RLS verb on this table now keys on
    // has_brokerage_access(brokerage_id), and that returns FALSE for NULL — so an
    // unstamped packet is both refused on write and invisible on read.
    //
    // HISTORY, because the shape of this call still reflects it: the INSERT policy
    // used to be `is_platform_admin() OR is_lead_visible_role()`, which excludes
    // an ordinary user_type='agent' — the very person who sends documents. Every
    // agent's packet was silently rejected by RLS, and the unchecked write hid it;
    // the table had zero rows. m363 replaced that predicate with
    // has_brokerage_access(brokerage_id) so an agent can create a packet for their
    // own brokerage and no other.
    //
    // The service client is kept because this write is a system-of-record step the
    // caller has already been authorised for (identity and document/contact tenancy
    // are both verified above) and it must not depend on policy nuance to land.
    // RLS is now correct either way; this is belt and braces, not a workaround.
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

/**
 * The in-app path a share token resolves to. Kept as one constant so the route
 * (app/documents/shared/[token]/page.tsx) and the minted URL cannot drift — the
 * previous version minted `/documents/shared/{token}` against a route that had
 * never existed, so every link it ever produced 404'd.
 */
function sharePathFor(token: string): string {
  return `/documents/shared/${token}`
}

export interface DocumentShareLinkResult {
  success: boolean
  error?: string
  /** Relative in-app path — use this for <Link>. */
  sharePath?: string
  /** Absolute URL for pasting into an email/DM. Falls back to the path when NEXT_PUBLIC_APP_URL is unset. */
  shareUrl?: string
  link?: {
    id: string
    shareToken: string
    accessLevel: string
    expiresAt: string
    requiresPassword: boolean
    maxAccessCount: number | null
  }
}

/**
 * Mints a TEAM share link for a document.
 *
 * OWNER RULING: "the share document is so the whole team has access." So the
 * token is a convenient handle for people who are ALREADY inside the brokerage —
 * it is not a bearer credential for the open internet. The reader
 * (accessSharedDocument) requires a session and a matching brokerage; this
 * function stamps the brokerage that will be checked.
 */
export async function createDocumentShareLink(data: {
  documentId: string
  sharedBy?: string // ignored — derived from session
  sharedWithEmail?: string
  accessLevel: "view" | "download" | "sign"
  expiresInDays?: number
  requiresPassword?: boolean
  password?: string
  /** Hard cap on total opens. Omit/null for unlimited. */
  maxAccessCount?: number | null
}): Promise<DocumentShareLinkResult> {
  // AUTH GATE — was minting shareable tokens for any caller-supplied
  // document under an arbitrary sharedBy identity.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()
  const svc = createServiceClient()

  // Verify ownership of the document being shared
  const { data: doc } = await svc
    .from("client_documents").select("brokerage_id").eq("id", data.documentId).maybeSingle()
  if (!doc || (doc.brokerage_id && doc.brokerage_id !== ctx.brokerageId)) {
    return { success: false, error: "Forbidden: document not in your brokerage" }
  }

  // The tenant that will be allowed to open the link. Taken from the document
  // when it is stamped, otherwise from the session — an unstamped document is
  // shared into the sharer's own brokerage and no other.
  const linkBrokerageId: string = (doc.brokerage_id as string | null) ?? ctx.brokerageId

  if (data.requiresPassword && !data.password) {
    return { success: false, error: "A password is required when password protection is enabled" }
  }

  if (
    data.maxAccessCount != null &&
    (!Number.isInteger(data.maxAccessCount) || data.maxAccessCount < 1)
  ) {
    return { success: false, error: "Open limit must be a whole number of 1 or more" }
  }

  if (data.expiresInDays != null && (!Number.isFinite(data.expiresInDays) || data.expiresInDays < 1)) {
    return { success: false, error: "Expiry must be at least 1 day" }
  }

  const shareToken = crypto.randomUUID()
  const expiresAt = data.expiresInDays
    ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // Default 30 days

  // HASHED, not stored raw. `password_hash: data.password` used to put the
  // plaintext in a column named "hash"; m356 now also refuses anything without
  // the scrypt envelope, so this is enforced at the database as well as here.
  const passwordHash = data.requiresPassword ? hashSharePassword(data.password) : null
  if (data.requiresPassword && !passwordHash) {
    return { success: false, error: "Could not secure the share password" }
  }

  const { data: link, error } = await supabase
    .from("document_sharing_links")
    .insert({
      document_id: data.documentId,
      brokerage_id: linkBrokerageId,
      share_token: shareToken,
      shared_by: ctx.userId,
      shared_with_email: data.sharedWithEmail,
      access_level: data.accessLevel,
      requires_password: data.requiresPassword || false,
      password_hash: passwordHash,
      expires_at: expiresAt.toISOString(),
      max_access_count: data.maxAccessCount ?? null,
    })
    .select("id, share_token, access_level, expires_at, requires_password, max_access_count")
    .single()

  // Surfaced, not thrown — the caller is a UI control and needs a message, and a
  // throw here used to become an opaque server-action rejection.
  if (error || !link) {
    return { success: false, error: error?.message ?? "Could not create the share link" }
  }

  // Audit entry. Best-effort BY DESIGN — the link already exists and refusing the
  // action now would invite the agent to mint a second one — but ledgered via
  // sentinelWrite so a lost compliance entry surfaces in the repair digest rather
  // than vanishing the way the old unchecked insert did.
  await sentinelWrite(
    svc,
    supabase.from("document_audit_trail").insert({
      document_id: data.documentId,
      document_source: "client_documents",
      action: "share_link_created",
      performed_by: ctx.userId,
      performed_by_type: "agent",
      notes: `Team share link created for ${data.sharedWithEmail || "the brokerage team"} (${data.accessLevel}${
        data.maxAccessCount ? `, max ${data.maxAccessCount} open${data.maxAccessCount > 1 ? "s" : ""}` : ""
      })`,
    }),
    { table: "document_audit_trail", flow: "document_share_link_created", brokerageId: ctx.brokerageId },
  )

  const sharePath = sharePathFor(shareToken)
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "")

  revalidatePath("/dashboard/documents")
  return {
    success: true,
    sharePath,
    shareUrl: base ? `${base}${sharePath}` : sharePath,
    link: {
      id: link.id,
      shareToken: link.share_token,
      accessLevel: link.access_level,
      expiresAt: link.expires_at,
      requiresPassword: link.requires_password,
      maxAccessCount: link.max_access_count ?? null,
    },
  }
}

export interface SharedDocumentResult {
  success: boolean
  error?: string
  /** True when the link is real and in-tenant but a password is still needed. */
  passwordRequired?: boolean
  document?: {
    id: string
    documentName: string
    documentType: string | null
    documentUrl: string | null
    status: string | null
    createdAt: string | null
  }
  accessLevel?: string
  sharedByEmail?: string | null
  expiresAt?: string
  /** Remaining opens after this one; null when the link is uncapped. */
  accessesRemaining?: number | null
}

/**
 * Opens a shared document. AUTHENTICATED AND BROKERAGE-SCOPED.
 *
 * WHAT CHANGED AND WHY (each of these was verified against the live schema):
 *
 *  - SESSION REQUIRED. The owner's ruling is that a share is for the team. A
 *    bearer token that anyone on the internet could redeem is a different, more
 *    dangerous feature than the one that was asked for.
 *
 *  - BROKERAGE MATCH. The viewer's brokerage must equal the link's. A viewer
 *    outside it gets the same refusal as a bad token and never the document.
 *
 *  - THE EMBED WAS DEAD. The old query was
 *    `.select("*, client_documents(*)")`, but there is NO foreign key from
 *    document_sharing_links.document_id to client_documents — PostgREST cannot
 *    infer that relationship, so the request errored, `data` came back null with
 *    the error undestructured, and EVERY call returned "Invalid or expired
 *    link". The document is now fetched with an explicit second query.
 *
 *  - THE CAP IS NOW AUTHORITATIVE. `max_access_count` did not exist as a column,
 *    so the old guard compared against `undefined` and never fired; and the
 *    increment was an unchecked `.update()` that RLS refused for anyone but the
 *    sharer (supabase-js resolves a rejected write, so it looked fine). The slot
 *    is now consumed by consume_document_share_access(), which increments only
 *    while under the cap and returns whether it succeeded. Access is refused on
 *    FALSE — so the count, not the read, is what stops the caller.
 *
 *  - PASSWORD IS VERIFIED AGAINST A HASH, in constant time, and BEFORE the slot
 *    is consumed so a wrong guess cannot burn the quota.
 */
export async function accessSharedDocument(
  shareToken: string,
  password?: string,
): Promise<SharedDocumentResult> {
  if (!shareToken || typeof shareToken !== "string" || shareToken.length < 16) {
    return { success: false, error: "Invalid share token" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Sign in with your team account to open a shared document." }
  }

  // Service client: this read has to see password_hash and the tenant stamp in
  // order to CHECK them. Authorisation is performed here, explicitly, below —
  // it is not delegated to a policy that would merely hide the row.
  const svc = createServiceClient()

  const { data: link, error: linkError } = await svc
    .from("document_sharing_links")
    .select(
      "id, document_id, brokerage_id, access_level, expires_at, is_active, requires_password, password_hash, shared_with_email, current_access_count, max_access_count",
    )
    .eq("share_token", shareToken)
    .maybeSingle()

  if (linkError) {
    return { success: false, error: "Could not open this link. Try again." }
  }

  // One indistinguishable refusal for "no such token", "revoked", and "not your
  // brokerage" — so the response never confirms that someone else's token exists.
  const REFUSED = { success: false as const, error: "This link is not available to your account." }

  if (!link || !link.is_active) return REFUSED

  // Tenant boundary. A link minted before m356 has no brokerage stamp; fall back
  // to the document's own tenant rather than treating "unstamped" as "open".
  let linkBrokerageId = link.brokerage_id as string | null
  if (!linkBrokerageId) {
    const { data: owningDoc } = await svc
      .from("client_documents")
      .select("brokerage_id")
      .eq("id", link.document_id)
      .maybeSingle()
    linkBrokerageId = (owningDoc?.brokerage_id as string | null) ?? null
  }
  if (!linkBrokerageId || linkBrokerageId !== ctx.brokerageId) return REFUSED

  // Expiry — never grant unbounded access. m356 makes expires_at NOT NULL, so a
  // null here means a row older than the migration; still refused.
  if (!link.expires_at) return REFUSED
  if (new Date(link.expires_at).getTime() < Date.now()) {
    return { success: false, error: "This link has expired." }
  }

  // Cap check up front so the viewer gets an honest message; the AUTHORITATIVE
  // enforcement is the atomic consume below, which is what actually stops them.
  if (link.max_access_count != null && (link.current_access_count ?? 0) >= link.max_access_count) {
    return { success: false, error: "This link has reached its maximum number of opens." }
  }

  if (link.requires_password) {
    if (!password) {
      return { success: false, passwordRequired: true, error: "This document is password protected." }
    }
    if (!verifySharePassword(link.password_hash, password)) {
      // Not a slot consumption — a wrong guess must not burn the quota.
      return { success: false, passwordRequired: true, error: "Incorrect password." }
    }
  }

  // ATOMIC SLOT CONSUMPTION. Returns false when the link went inactive, expired,
  // or hit its cap between the checks above and now (including a concurrent
  // viewer taking the last slot). Access is refused on false.
  const { data: consumed, error: consumeError } = await svc.rpc("consume_document_share_access", {
    p_link_id: link.id,
  })

  if (consumeError) {
    return { success: false, error: "Could not open this link. Try again." }
  }
  if (consumed !== true) {
    return { success: false, error: "This link has reached its maximum number of opens." }
  }

  const { data: document, error: docError } = await svc
    .from("client_documents")
    .select("id, document_name, document_type, document_url, status, created_at, brokerage_id")
    .eq("id", link.document_id)
    .maybeSingle()

  // Defence in depth: the document's own tenant must still match the viewer,
  // even though the link said so.
  if (docError || !document || (document.brokerage_id && document.brokerage_id !== ctx.brokerageId)) {
    return REFUSED
  }

  // Access log — the viewer is a known team member now, so record WHO, not
  // "external" with the invitee's email. Ledgered, so a lost audit row surfaces.
  await sentinelWrite(
    svc,
    svc.from("document_access_log").insert({
      document_id: link.document_id,
      accessed_by_type: "agent",
      accessed_by_id: ctx.userId,
      accessed_by_email: link.shared_with_email,
      access_type: link.access_level ?? "view",
    }),
    { table: "document_access_log", flow: "shared_document_opened", brokerageId: ctx.brokerageId },
  )

  const remaining =
    link.max_access_count != null
      ? Math.max(0, link.max_access_count - ((link.current_access_count ?? 0) + 1))
      : null

  return {
    success: true,
    document: {
      id: document.id,
      documentName: document.document_name,
      documentType: document.document_type ?? null,
      documentUrl: document.document_url ?? null,
      status: document.status ?? null,
      createdAt: document.created_at ?? null,
    },
    accessLevel: link.access_level ?? "view",
    sharedByEmail: link.shared_with_email ?? null,
    expiresAt: link.expires_at,
    accessesRemaining: remaining,
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
