// lib/transactions/deal-vendor-notify.ts
//
// DEAL-VENDOR NOTIFICATION — the B2B leg of the Deal-Save Huddle. When a deal hits trouble and a
// LENDER or TITLE/ESCROW company is on the file, the people who can actually move that item get a
// factual, transactional heads-up: the loan officer hears about a financing item, the title/escrow
// officer hears about a title or earnest-money item. This is B2B-transactional egress (a business
// counterparty already on the deal, not consumer marketing) — the same class as the agent-initiated
// lender-status-request, reviewed onto the egress-send-guard allowlist. Deduped per (deal, vendor)
// within a short window so a flapping deal never spams a vendor; every send is audited on activities.

import { sendEmail } from "@/lib/providers/messaging"
import { createServiceClient } from "@/lib/supabase/service"
import { vendorTargets, VENDOR_NOTIFY_DEDUPE_DAYS, type DealVendorRole } from "./deal-vendor-targets"

export { vendorTargets, VENDOR_NOTIFY_DEDUPE_DAYS, type DealVendorRole }

type Svc = ReturnType<typeof createServiceClient>

interface VendorContact { role: DealVendorRole; name: string | null; email: string | null }

/**
 * Notify the deal's lender / title / escrow of the relevant issue. B2B-transactional, deduped,
 * audited, best-effort (never throws). Returns the roles actually notified.
 */
export async function notifyDealVendorsOfIssue(
  supabase: Svc,
  params: { transactionId: string; brokerageId: string; dealName?: string | null; categories: string[]; issues?: string[] },
): Promise<{ notified: DealVendorRole[] }> {
  const roles = vendorTargets(params.categories)
  if (roles.length === 0) return { notified: [] }

  const [{ data: lender }, { data: title }, { data: txn }] = await Promise.all([
    supabase.from("transaction_lenders").select("loan_officer_name, loan_officer_email").eq("transaction_id", params.transactionId).maybeSingle(),
    supabase.from("transaction_title_escrow").select("title_officer_name, title_officer_email, title_company_email, escrow_officer_name, escrow_officer_email").eq("transaction_id", params.transactionId).maybeSingle(),
    supabase.from("transactions").select("property_address").eq("id", params.transactionId).maybeSingle(),
  ])

  const l = lender as Record<string, string | null> | null
  const t = title as Record<string, string | null> | null
  const contacts: Record<DealVendorRole, VendorContact> = {
    lender: { role: "lender", name: l?.loan_officer_name ?? null, email: l?.loan_officer_email ?? null },
    title: { role: "title", name: t?.title_officer_name ?? null, email: t?.title_officer_email ?? t?.title_company_email ?? null },
    escrow: { role: "escrow", name: t?.escrow_officer_name ?? t?.title_officer_name ?? null, email: t?.escrow_officer_email ?? t?.title_officer_email ?? t?.title_company_email ?? null },
  }

  const propertyLine = (txn as { property_address?: string | null } | null)?.property_address
    ? ` for ${(txn as { property_address?: string | null }).property_address}`
    : params.dealName ? ` for ${params.dealName}` : ""
  const issueLine = (params.issues ?? []).length > 0 ? `\n\nWhat we're tracking:\n${(params.issues ?? []).slice(0, 4).map((i) => `• ${i}`).join("\n")}` : ""
  const since = new Date(Date.now() - VENDOR_NOTIFY_DEDUPE_DAYS * 86_400_000).toISOString()
  const notified: DealVendorRole[] = []

  for (const role of roles) {
    const c = contacts[role]
    if (!c.email) continue

    // Dedupe — skip if we already notified this vendor on this deal in the window.
    const { data: dup } = await supabase.from("activities").select("id")
      .eq("transaction_id", params.transactionId).eq("activity_type", "deal_vendor_issue_notified")
      .ilike("notes", `%"role":"${role}"%`).gte("created_at", since).limit(1).maybeSingle()
    if (dup) continue

    const noun = role === "lender" ? "financing" : role === "escrow" ? "earnest-money / escrow" : "title"
    const subject = `Time-sensitive: ${noun} item${propertyLine}`
    const body =
      `Hi ${c.name ?? "there"},\n\n` +
      `We're coordinating the closing${propertyLine} and want to confirm status on a ${noun} item that needs attention to keep the date on track.${issueLine}\n\n` +
      `Could you reply with a quick status update? Thank you for partnering with us on this one.`

    try {
      const r = await sendEmail({ to: c.email, subject, body, brokerageId: params.brokerageId } as never)
      const ok = (r as { success?: boolean } | null)?.success
      if (ok) {
        notified.push(role)
        // The record that a B2B status request actually went to this vendor.
        // The catch below cannot see a REFUSED row, only a thrown one.
        const { error: vendorNotifyActivityError } = await supabase.from("activities").insert({
          brokerage_id: params.brokerageId,
          transaction_id: params.transactionId,
          entity_type: "transaction",
          activity_type: "deal_vendor_issue_notified",
          title: `Notified ${role} of a ${noun} issue`,
          description: `Deal-Save Huddle sent a B2B status request to the ${role}${propertyLine}.`,
          notes: JSON.stringify({ role, email: c.email, categories: params.categories }),
          status: "completed",
          completed_at: new Date().toISOString(),
          channel: "email",
        })
        if (vendorNotifyActivityError) {
          console.error(`[deal-vendor-notify] ${role} notification activity REJECTED — the email went out but the transaction has no record of it:`, vendorNotifyActivityError.message)
        }
      }
    } catch {
      // best-effort — a vendor send failure never breaks the huddle
    }
  }

  return { notified }
}

/** The disbursement figures a CDA authorizes. One shape, so the two surfaces that
 *  state them to a closing agent cannot state them differently. */
export interface CdaDisbursementFigures {
  grossCommission: number
  agentNet: number
  brokerageNet: number
  tcNet?: number | null
}

/** PURE: format one CDA money figure. Kept beside the lines so a caller cannot
 *  round or symbol it differently on one surface than the other. */
export function formatCdaMoney(n: number): string {
  return `$${(Math.round(n * 100) / 100).toLocaleString()}`
}

/**
 * PURE: the disbursement instruction lines, in the order a closing agent reads them.
 *
 * ─── ONE COMPOSER, TWO SURFACES (§6, wave 26) ────────────────────────────────
 * Extracted so `deliverCdaToClosingAgent` below and
 * app/actions/cda-portal.ts:sendCdaToTitleAction — the WIRED send — state the
 * same split. Before this, the wired action emailed an "Approved Commission
 * Disbursement Authorization" whose entire body was "The approved CDA for this
 * transaction is ready for the closing": a disbursement authorization carrying
 * no disbursement. The figures lived only here, on the surface nothing called.
 *
 * The TC line is omitted (not zeroed) when there is no TC take — an honest
 * absence rather than a "$0" the closing agent has to interpret.
 */
export function composeCdaDisbursementLines(f: CdaDisbursementFigures): string[] {
  const lines = [
    `Gross commission to our brokerage's side: ${formatCdaMoney(f.grossCommission)}`,
    `Agent net: ${formatCdaMoney(f.agentNet)}`,
    `Brokerage net: ${formatCdaMoney(f.brokerageNet)}`,
  ]
  if (f.tcNet && f.tcNet > 0) lines.push(`Transaction coordinator: ${formatCdaMoney(f.tcNet)}`)
  return lines
}

/**
 * Deliver an APPROVED Closing Disclosure Agreement to the closing agent (the title company /
 * escrow officer / closing attorney) — the disbursement authorization that tells them how to split
 * the funds among agent / brokerage / TC (Model B). B2B-transactional (a counterparty on the deal),
 * deduded by the CDA's own sent_to_title_at, audited. Returns the recipient email when sent.
 *
 * KEEP-ONE NOTE (wave 26): the WIRED send is
 * app/actions/cda-portal.ts:sendCdaToTitleAction, which owns the broker-signature
 * gate, the sent_to_title_* columns and the cda_delivered milestone. The three
 * things THIS function held that it lacked — the disbursement figures, reading
 * the send result before recording a delivery, and the cda_delivered_to_title
 * activity — have been merged onto it. This function is NOT deleted: it is
 * imported and CALLED by scripts/cda-flow-simulator.ts:71, and
 * scripts/cda-process-chain-simulator.ts:171 asserts approveCdaAction does not
 * reach it. Deleting it would break a live proof, so the figures are shared
 * through composeCdaDisbursementLines above instead of copied.
 */
export async function deliverCdaToClosingAgent(
  supabase: Svc,
  params: { transactionId: string; brokerageId: string; grossCommission: number; agentNet: number; brokerageNet: number; tcNet?: number | null; dealName?: string | null },
): Promise<{ delivered: boolean; recipient: string | null }> {
  const { data: title } = await supabase
    .from("transaction_title_escrow")
    .select("title_officer_name, title_officer_email, title_company_email, escrow_officer_name, escrow_officer_email")
    .eq("transaction_id", params.transactionId)
    .maybeSingle()
  const t = title as Record<string, string | null> | null
  const recipient = t?.escrow_officer_email ?? t?.title_officer_email ?? t?.title_company_email ?? null
  const name = t?.escrow_officer_name ?? t?.title_officer_name ?? "Closing team"
  if (!recipient) return { delivered: false, recipient: null }

  const { data: txn } = await supabase.from("transactions").select("property_address").eq("id", params.transactionId).maybeSingle()
  const propertyLine = (txn as { property_address?: string | null } | null)?.property_address
    ? ` for ${(txn as { property_address?: string | null }).property_address}`
    : params.dealName ? ` for ${params.dealName}` : ""
  // ONE composer, shared with the wired send (see composeCdaDisbursementLines).
  const disbursementLines = composeCdaDisbursementLines(params)

  const subject = `Approved Commission Disbursement Authorization${propertyLine}`
  const body =
    `Hi ${name},\n\n` +
    `Our brokerage's compliance review of the commission disbursement${propertyLine} is complete and APPROVED. ` +
    `Please disburse at closing as follows:\n\n` +
    disbursementLines.map((l) => `• ${l}`).join("\n") +
    `\n\nReply to confirm receipt. Thank you for closing this one with us.`

  try {
    const r = await sendEmail({ to: recipient, subject, body, brokerageId: params.brokerageId } as never)
    const ok = (r as { success?: boolean } | null)?.success
    if (ok) {
      // The record that an approved disbursement authorization was DELIVERED —
      // a compliance artifact, not a log line.
      const { error: cdaDeliveredActivityError } = await supabase.from("activities").insert({
        brokerage_id: params.brokerageId, transaction_id: params.transactionId, entity_type: "transaction",
        activity_type: "cda_delivered_to_title", title: "CDA delivered to the closing agent",
        description: `Approved disbursement authorization sent to the title/escrow officer${propertyLine}.`,
        notes: JSON.stringify({ recipient, grossCommission: params.grossCommission }),
        status: "completed", completed_at: new Date().toISOString(), channel: "email",
      })
      if (cdaDeliveredActivityError) {
        console.error("[deal-vendor-notify] cda_delivered_to_title activity REJECTED — the CDA was emailed to title but the delivery is unrecorded:", cdaDeliveredActivityError.message)
      }
      return { delivered: true, recipient }
    }
  } catch { /* best-effort */ }
  return { delivered: false, recipient }
}
