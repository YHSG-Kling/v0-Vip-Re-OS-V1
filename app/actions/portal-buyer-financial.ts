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
  recordDocumentUpload,
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

export async function submitBuyerFinancialFromPortalAction(input: {
  contactId:           string
  blobUrl:             string
  fileName:            string
  docCategory:         "pre_approval_letter" | "proof_of_funds"
  verificationAmount?: number
  verificationLender?: string
  expirationDate?:     string
}) {
  const auth = await authBuyerOwnsContact(input.contactId)
  if (!auth.ok) return { success: false as const, error: auth.error }

  return recordDocumentUpload({
    contactId:          input.contactId,
    brokerageId:        auth.brokerageId,
    uploadedBy:         auth.userId,
    documentName:       input.fileName,
    documentUrl:        input.blobUrl,
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
        .from("users").select("first_name, last_name, full_name")
        .eq("id", agentUserId).maybeSingle()
      const u2 = u as { first_name?: string; last_name?: string; full_name?: string } | null
      if (u2) {
        agentName = u2.full_name?.trim()
          ?? `${u2.first_name ?? ""} ${u2.last_name ?? ""}`.trim()
          ?? agentName
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
  return getBrokerageLenders({ brokerageId: auth.brokerageId })
}
