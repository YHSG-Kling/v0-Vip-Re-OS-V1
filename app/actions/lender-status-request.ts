"use server"

/**
 * app/actions/lender-status-request.ts
 *
 * Adds an agent-side push that asks the lender to log into the existing
 * lender portal and update the loan status. The lender portal itself is
 * already built (app/portal/lender/* and app/actions/lender-portal-actions.ts) —
 * this is the missing "I need an update NOW" trigger from the agent side.
 *
 * Flow:
 *   1. Agent on the transaction detail clicks "Request status update"
 *   2. We PERSIST the ask — one `document_requests` row per item (lane 78D,
 *      blind spot 4: lane 77A recorded that these requests were email/SMS-only
 *      and "there is no reader for 'what has the agent asked me for' on the
 *      lender seat"). `document_requests` (scripts/schema-snapshot.ts:
 *      brokerage_id, contact_id, document_name, document_type, due_date,
 *      fulfilled_at, fulfillment_url, metadata, requested_by, status,
 *      transaction_id) was the live table with NO writer and NO reader in the
 *      tree — the exact survivor for this fact (§1.2: build the missing halves,
 *      never a second table). Status vocabulary is the live CHECK
 *      (scripts/check-vocabularies.ts document_requests.status: pending →
 *      submitted when the lender answers through the portal; see
 *      app/actions/lender-portal-actions.ts updateLenderLoanStatus).
 *      Reader: lib/ai-isa/user-type-tools.ts list_transaction_documents
 *      (`outstandingRequests`) on the lender seat.
 *   3. We send the lender:
 *      • email (if email on file)            — magic link to portal
 *      • SMS  (if phone + opted-in)          — short prompt + URL
 *      through the ONE governed egress (lib/providers/dispatch.ts — was a
 *      direct lib/providers/messaging importer; egress-send-guard debt −1).
 *   4. We log an activity on the transaction so the audit trail captures
 *      who asked, when, and what was requested.
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { dispatchEmail, dispatchSms } from "@/lib/providers/dispatch"
import { ITEM_LABEL, type RequestableItem } from "@/lib/lenders/status-request-items"

export async function requestLenderStatusUpdateAction(input: {
  transactionId: string
  items: RequestableItem[]
  note?: string
  channel?: "email" | "sms" | "both"
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  if (!input.items?.length) return { success: false as const, error: "no_items" }

  // Lenders are vendors. The lender company is the assigned Lender vendor's name
  // (resolveLenderVendorForTransaction) with transaction_lenders.lender_name as a
  // fallback; loan-officer contact lives on transaction_lenders.loan_officer_*.
  const { data: txn } = await supabase
    .from("transactions")
    .select("id, brokerage_id, property_address, contact_id")
    .eq("id", input.transactionId)
    .maybeSingle()

  if (!txn || txn.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "transaction_not_found" }
  }

  const { resolveLenderVendorForTransaction } = await import("@/lib/kernel/lender-linkage")
  const [lenderVendor, { data: txnLender }] = await Promise.all([
    resolveLenderVendorForTransaction(supabase, input.transactionId),
    supabase
      .from("transaction_lenders")
      .select("lender_name, loan_officer_name, loan_officer_email, loan_officer_phone")
      .eq("transaction_id", input.transactionId)
      .maybeSingle(),
  ])

  const companyName = lenderVendor?.name ?? txnLender?.lender_name ?? null
  const recipientEmail = txnLender?.loan_officer_email ?? null
  const recipientPhone = txnLender?.loan_officer_phone ?? null

  if (!companyName && !recipientEmail && !recipientPhone) {
    return { success: false as const, error: "no_lender_contact_on_file" }
  }

  const channel = input.channel ?? "email"
  const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/portal/lender/${txn.id}`
  const itemList = input.items.map((i) => `• ${ITEM_LABEL[i]}`).join("\n")
  const propertyLine = txn.property_address ? ` for ${txn.property_address}` : ""

  const subject = `Status update requested${propertyLine}`
  const body =
    `Hi ${txnLender?.loan_officer_name ?? companyName ?? "there"},\n\n` +
    `Could you update the loan file${propertyLine} on the items below?\n\n` +
    `${itemList}\n\n` +
    (input.note ? `Note: ${input.note}\n\n` : "") +
    `Update directly here: ${portalUrl}\n\n` +
    `Thanks!`

  const sent: string[] = []
  const errors: string[] = []

  if ((channel === "email" || channel === "both") && recipientEmail) {
    try {
      const r = await dispatchEmail({
        to: recipientEmail,
        subject,
        html: body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br/>"),
        text: body,
        brokerageId: txn.brokerage_id,
        userId: auth.userId,
        systemSource: "lender_status_request",
        channelPurpose: "transactional",
      })
      if (r.success) sent.push("email")
      else errors.push(`email: ${r.error ?? "send_failed"}`)
    } catch (err: any) {
      errors.push(`email: ${err?.message ?? "exception"}`)
    }
  }

  if ((channel === "sms" || channel === "both") && recipientPhone) {
    try {
      const r = await dispatchSms({
        to: recipientPhone,
        message: `Quick lender update needed${propertyLine}: ${input.items
          .map((i) => ITEM_LABEL[i])
          .join(", ")}. ${portalUrl}`,
        brokerageId: txn.brokerage_id,
        userId: auth.userId,
        systemSource: "lender_status_request",
        // The loan officer is a working party on a deal they are assigned to —
        // a request for their own file's status, not marketing.
        transactional: true,
      })
      if (r.success) sent.push("sms")
      else errors.push(`sms: ${r.error ?? "send_failed"}`)
    } catch (err: any) {
      errors.push(`sms: ${err?.message ?? "exception"}`)
    }
  }

  // THE ASK, PERSISTED — one row per item, so the lender seat can read what is
  // outstanding and the portal can mark it answered. Idempotent per open item:
  // a second click for an item still `pending` on this deal does not pile a
  // second row on it (the resend is still logged on the activity below).
  const { data: openRows, error: openErr } = await supabase
    .from("document_requests")
    .select("document_type")
    .eq("brokerage_id", txn.brokerage_id)
    .eq("transaction_id", txn.id)
    .eq("status", "pending")
    .in("document_type", input.items)
  if (openErr) {
    console.error("[lenderStatusRequest] open document_requests read REFUSED — the ask will be re-filed rather than deduped:", openErr.message)
  }
  const alreadyOpen = new Set(((openRows ?? []) as Array<{ document_type: string }>).map((r) => r.document_type))
  const toFile = input.items.filter((i) => !alreadyOpen.has(i))
  let requestsFiled = 0
  if (toFile.length > 0) {
    const { data: filed, error: fileErr } = await supabase
      .from("document_requests")
      .insert(toFile.map((item) => ({
        brokerage_id: txn.brokerage_id,
        transaction_id: txn.id,
        contact_id: txn.contact_id ?? null,
        requested_by: auth.userId,
        document_type: item,
        document_name: ITEM_LABEL[item],
        status: "pending",
        metadata: {
          source: "lender_status_request",
          lender_vendor_id: lenderVendor?.vendorId ?? null,
          lender_company: companyName,
          channels_sent: sent,
          note: input.note ?? null,
        },
      })))
      .select("id")
    if (fileErr) {
      // A refused persist is REPORTED, not laundered: the sends may have gone
      // out, but the lender seat will not see these asks as outstanding.
      console.error("[lenderStatusRequest] document_requests insert REFUSED — the ask was sent but is not on record for the lender seat:", fileErr.message)
      errors.push(`persist: ${fileErr.message}`)
    } else {
      requestsFiled = (filed ?? []).length
    }
  }

  // This row carries `channels_sent` and `errors` — it is the ONLY record of
  // which channels the request actually went out on. Losing it loses that.
  const { error: lenderRequestActivityError } = await supabase.from("activities").insert({
    brokerage_id: txn.brokerage_id,
    agent_id: auth.agentId,
    transaction_id: txn.id,
    entity_type: "transaction",
    activity_type: "lender_status_requested",
    title: "Lender status update requested",
    description: `Requested ${input.items.length} update(s) from ${companyName ?? "lender"}: ${input.items
      .map((i) => ITEM_LABEL[i])
      .join(", ")}`,
    notes: JSON.stringify({ items: input.items, channels_sent: sent, errors, requests_filed: requestsFiled, already_open: [...alreadyOpen] }),
    completed_at: new Date().toISOString(),
    status: "completed",
    channel: sent[0] ?? "email",
  })
  if (lenderRequestActivityError) {
    console.error("[lenderStatusRequest] lender_status_requested activity REJECTED — the request was sent but which channels carried it is now unrecorded:", lenderRequestActivityError.message)
  }

  if (sent.length === 0) {
    return { success: false as const, error: "no_delivery_channel_succeeded", errors, requestsFiled }
  }

  return { success: true as const, channelsSent: sent, errors, requestsFiled, alreadyOpen: [...alreadyOpen] }
}
