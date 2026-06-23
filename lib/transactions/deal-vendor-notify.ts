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
        await supabase.from("activities").insert({
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
      }
    } catch {
      // best-effort — a vendor send failure never breaks the huddle
    }
  }

  return { notified }
}
