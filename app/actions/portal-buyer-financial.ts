"use server"

/**
 * Portal-side wrappers for the buyer financial verification flow.
 * Auth-gates the existing service-role actions in
 * app/actions/buyer-financial.ts so a buyer logged into their portal
 * (contacts.contact_user_id = auth.uid) can submit their own
 * pre-approval / POF and request a lender assignment.
 *
 * No new tables. No duplicate logic. Pure thin wrappers.
 */

import { createClient } from "@/lib/supabase/server"
import {
  uploadFinancialVerificationDocument,
  connectBuyerToLender,
  loadFinancialProfile,
  getBrokerageLenders,
} from "@/app/actions/buyer-financial"

// Verify the caller is the buyer who owns this contact (or an authorized
// portal user — agents/TCs/etc. should use the agent-side action paths).
async function authBuyerOwnsContact(contactId: string): Promise<
  | { ok: true; userId: string; brokerageId: string; contactName: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "unauthenticated" }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, contact_user_id, brokerage_id, first_name, last_name")
    .eq("id", contactId)
    .maybeSingle()

  if (!contact) return { ok: false, error: "contact_not_found" }
  if (contact.contact_user_id !== user.id) {
    return { ok: false, error: "not_authorized_for_this_contact" }
  }

  return {
    ok: true,
    userId:      user.id,
    brokerageId: contact.brokerage_id,
    contactName: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Buyer",
  }
}

// ─── Portal-side: buyer uploads their own pre-approval / POF ──────────────
//
// TOMBSTONE — `submitBuyerFinancialFromPortalAction` lived here. It took a
// caller-supplied `blobUrl` and wrote it straight onto the client_documents row,
// which is what let the portal card upload the buyer's financial paperwork to a
// permanent PUBLIC Vercel Blob URL. Its survivor is
// `uploadBuyerFinancialFromPortalAction` below (this file), which takes the
// BYTES and mints the URL itself, so no caller can hand in a public one. In a
// "use server" file every export is a public HTTP endpoint (CLAUDE.md §4) —
// leaving the URL-accepting one standing would have left the public path open
// even with no UI calling it.

// ─── Portal-side: buyer uploads the BYTES, not a public URL ───────────────
//
// The portal card used to call @vercel/blob's client `upload()` with
// access:"public" and then hand the resulting URL to the action above. A buyer's
// pre-approval letter and proof of funds are their financial paperwork, and that
// put every one of them at a permanent, unauthenticated, never-expiring URL —
// then PERSISTED that URL onto the client_documents row, so the leak outlived
// the upload. The bytes now come to the server, land in the PRIVATE
// `client-documents` bucket, and the row records a TIME-LIMITED signed URL from
// the ONE issuer (lib/storage/document-buckets.ts#issueBucketObjectUrl).
//
// FAIL CLOSED: if the URL cannot be signed the upload is undone and the buyer is
// told it failed. There is no public fallback.
//
// Still a PURE THIN WRAPPER, exactly as the header promises: the portal gate
// runs first, then it delegates to the ONE byte-accepting action shared with the
// agent CRM panel (app/actions/buyer-financial.ts#uploadFinancialVerificationDocument).
// One spelling of "how a financial document is stored" (CLAUDE.md §6).
//
// base64 over a server action, matching the existing in-tree pattern
// (app/actions/cda-storage.ts, app/actions/admin/commission-agreement.ts);
// next.config.ts sets serverActions.bodySizeLimit to 8mb.

export async function uploadBuyerFinancialFromPortalAction(input: {
  contactId:           string
  fileName:            string
  contentType:         string
  base64:              string
  docCategory:         "pre_approval_letter" | "proof_of_funds"
  verificationAmount?: number
  verificationLender?: string
  expirationDate?:     string
}) {
  const auth = await authBuyerOwnsContact(input.contactId)
  if (!auth.ok) return { success: false as const, error: auth.error }

  return uploadFinancialVerificationDocument({
    contactId:          input.contactId,
    fileName:           input.fileName,
    contentType:        input.contentType,
    base64:             input.base64,
    docCategory:        input.docCategory,
    verificationAmount: input.verificationAmount,
    verificationLender: input.verificationLender,
    expirationDate:     input.expirationDate,
  })
}

// ─── Portal-side: buyer requests connection to a brokerage lender ────────

export async function connectBuyerToLenderFromPortalAction(input: {
  contactId:    string
  partnerId:    string
  partnerName:  string
}) {
  const auth = await authBuyerOwnsContact(input.contactId)
  if (!auth.ok) return { success: false as const, error: auth.error }

  // Resolve the agent assigned to this contact so connectBuyerToLender
  // can record the introduction. Best-effort — fall back to the contact
  // owner from contacts.agent_id.
  const supabase = await createClient()
  const { data: contact } = await supabase
    .from("contacts").select("agent_id").eq("id", input.contactId).maybeSingle()

  let agentUserId = ""
  let agentName   = "Your agent"
  if (contact?.agent_id) {
    const { data: agentRow } = await supabase
      .from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    if (agentRow?.user_id) {
      agentUserId = agentRow.user_id
      const { data: u } = await supabase
        .from("users").select("first_name, last_name")
        .eq("id", agentUserId).maybeSingle()
      const u2 = u as { first_name?: string; last_name?: string } | null
      if (u2) {
        agentName = `${u2.first_name ?? ""} ${u2.last_name ?? ""}`.trim() || agentName
      }
    }
  }

  return connectBuyerToLender({
    contactId:    input.contactId,
    brokerageId:  auth.brokerageId,
    agentUserId,
    agentName,
    buyerName:    auth.contactName,
    partnerId:    input.partnerId,
    partnerName:  input.partnerName,
  })
}

// ─── Portal-side reads ────────────────────────────────────────────────────

export async function loadFinancialProfileFromPortalAction(input: { contactId: string }) {
  const auth = await authBuyerOwnsContact(input.contactId)
  if (!auth.ok) return { success: false as const, error: auth.error }
  return loadFinancialProfile({ contactId: input.contactId })
}

export async function getBrokerageLendersFromPortalAction(input: { contactId: string }) {
  const auth = await authBuyerOwnsContact(input.contactId)
  if (!auth.ok) return { success: false as const, error: auth.error }
  // The tenant is the SESSION's, resolved inside getBrokerageLenders — this used to
  // hand it `auth.brokerageId` into a parameter that was documented as ignored.
  return getBrokerageLenders()
}
