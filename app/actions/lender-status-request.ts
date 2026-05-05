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
 *   2. We send the lender:
 *      • email (if email on file)            — magic link to portal
 *      • SMS  (if phone + opted-in)          — short prompt + URL
 *   3. We log an activity on the transaction so the audit trail captures
 *      who asked, when, and what was requested.
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { sendSMS, sendEmail } from "@/lib/providers/messaging"

const REQUESTABLE_ITEMS = [
  "appraisal_status",
  "underwriting_status",
  "conditions_outstanding",
  "clear_to_close_eta",
  "loan_commitment_letter",
] as const
type RequestableItem = (typeof REQUESTABLE_ITEMS)[number]

const ITEM_LABEL: Record<RequestableItem, string> = {
  appraisal_status: "appraisal status",
  underwriting_status: "underwriting status",
  conditions_outstanding: "outstanding conditions",
  clear_to_close_eta: "clear-to-close ETA",
  loan_commitment_letter: "loan commitment letter",
}

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

  const { data: txn } = await supabase
    .from("transactions")
    .select(
      `id, brokerage_id, property_address, lender_id,
       lender:lender_id (id, lender_company, lender_email, lender_phone, user_id)`,
    )
    .eq("id", input.transactionId)
    .maybeSingle()

  if (!txn || txn.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "transaction_not_found" }
  }

  const lender = (txn as any).lender as
    | { id: string; lender_company: string | null; lender_email: string | null; lender_phone: string | null }
    | null
  if (!lender) return { success: false as const, error: "no_lender_assigned" }

  const channel = input.channel ?? "email"
  const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/portal/lender/${txn.id}`
  const itemList = input.items.map((i) => `• ${ITEM_LABEL[i]}`).join("\n")
  const propertyLine = txn.property_address ? ` for ${txn.property_address}` : ""

  const subject = `Status update requested${propertyLine}`
  const body =
    `Hi ${lender.lender_company ?? "there"},\n\n` +
    `Could you update the loan file${propertyLine} on the items below?\n\n` +
    `${itemList}\n\n` +
    (input.note ? `Note: ${input.note}\n\n` : "") +
    `Update directly here: ${portalUrl}\n\n` +
    `Thanks!`

  const sent: string[] = []
  const errors: string[] = []

  if ((channel === "email" || channel === "both") && lender.lender_email) {
    try {
      const r = await sendEmail({
        to: lender.lender_email,
        subject,
        body,
        brokerageId: txn.brokerage_id,
      } as any)
      if ((r as any)?.success) sent.push("email")
      else errors.push(`email: ${(r as any)?.error ?? "send_failed"}`)
    } catch (err: any) {
      errors.push(`email: ${err?.message ?? "exception"}`)
    }
  }

  if ((channel === "sms" || channel === "both") && lender.lender_phone) {
    try {
      const r = await sendSMS({
        to: lender.lender_phone,
        body: `Quick lender update needed${propertyLine}: ${input.items
          .map((i) => ITEM_LABEL[i])
          .join(", ")}. ${portalUrl}`,
        brokerageId: txn.brokerage_id,
      } as any)
      if ((r as any)?.success) sent.push("sms")
      else errors.push(`sms: ${(r as any)?.error ?? "send_failed"}`)
    } catch (err: any) {
      errors.push(`sms: ${err?.message ?? "exception"}`)
    }
  }

  await supabase.from("activities").insert({
    brokerage_id: txn.brokerage_id,
    agent_id: auth.agentId,
    activity_type: "lender_status_requested",
    description: `Requested ${input.items.length} update(s) from ${lender.lender_company ?? "lender"}: ${input.items
      .map((i) => ITEM_LABEL[i])
      .join(", ")}`,
    metadata: { transaction_id: txn.id, items: input.items, channels_sent: sent, errors },
    occurred_at: new Date().toISOString(),
  })

  if (sent.length === 0) {
    return { success: false as const, error: "no_delivery_channel_succeeded", errors }
  }

  return { success: true as const, channelsSent: sent, errors }
}
