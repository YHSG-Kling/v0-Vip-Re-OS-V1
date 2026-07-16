"use server"

// app/actions/partner-orders.ts
// ─────────────────────────────────────────────────────────────────────────────
// PARTNER-ORDER WRITERS (burn-down round 5, owner spec). Two partner-OS tables
// were read by live panels but had no writer:
//   · lender_applications — "the lender's application LINK": the lender (or the
//     agent working with them) records an application with the lender's own
//     application URL; the lender pipeline panels track it through the live
//     CHECK lifecycle (pending → docs_needed/pre_approval/… → approved/closed).
//   · title_orders — "their search results from the title search": the title
//     partner records an order and attaches the TITLE SEARCH RESULT (l72_s12
//     jsonb); a clean search lands status 'clear', a problem lands 'issue' —
//     the /title portal's pipeline and command strip read exactly these.
// Identity: lender_id / vendor_id are vendors(id) (live FKs); tenant-anchored
// on the caller's brokerage in every write.

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { revalidatePath } from "next/cache"

const LENDER_APP_STATUSES = ["pending","docs_needed","pre_approval","pre_approved","processing","underwriting","approved","active","denied","closed","cancelled"] as const
const TITLE_ORDER_STATUSES = ["pending","ordered","in_progress","clear","issue","exception","completed","cancelled"] as const

export async function createLenderApplication(input: {
  applicationUrl: string
  lenderVendorId?: string | null
  contactId?: string | null
  transactionId?: string | null
  loanAmount?: number | null
}): Promise<{ success: boolean; applicationId?: string; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!input.applicationUrl?.trim() || !/^https?:\/\//.test(input.applicationUrl.trim())) {
    return { success: false, error: "application_url_invalid" }
  }
  const svc = createServiceClient()
  if (input.lenderVendorId) {
    const { data: v } = await svc.from("vendors").select("brokerage_id").eq("id", input.lenderVendorId).maybeSingle()
    if (!v || ((v.brokerage_id as string | null) && (v.brokerage_id as string) !== ctx.brokerageId)) {
      return { success: false, error: "lender_not_in_brokerage" }
    }
  }
  const { data, error } = await svc.from("lender_applications").insert({
    brokerage_id: ctx.brokerageId,
    lender_id: input.lenderVendorId ?? null,
    contact_id: input.contactId ?? null,
    transaction_id: input.transactionId ?? null,
    status: "pending",
    loan_amount: input.loanAmount ?? null,
    application_url: input.applicationUrl.trim(), // the lender's own application link (l72_s12)
  }).select("id").single()
  if (error) return { success: false, error: error.message }
  revalidatePath("/lender")
  revalidatePath("/dashboard/partners")
  return { success: true, applicationId: data.id as string }
}

export async function updateLenderApplicationStatus(
  applicationId: string,
  status: (typeof LENDER_APP_STATUSES)[number],
): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!LENDER_APP_STATUSES.includes(status)) return { success: false, error: "invalid_status" }
  const svc = createServiceClient()
  const { error } = await svc.from("lender_applications")
    .update({
      status,
      updated_at: new Date().toISOString(),
      ...(status === "approved" ? { approved_at: new Date().toISOString() } : {}),
    })
    .eq("id", applicationId)
    .eq("brokerage_id", ctx.brokerageId)
  if (error) return { success: false, error: error.message }
  revalidatePath("/lender")
  return { success: true }
}

export async function createTitleOrder(input: {
  propertyAddress: string
  transactionId?: string | null
  titleVendorId?: string | null
  closingDate?: string | null
  /** The title search RESULT (owner spec) — findings, liens, exceptions, notes. */
  searchResult?: Record<string, unknown> | null
  /** A clean search is 'clear'; a found problem is 'issue'; not-yet-run is 'ordered'. */
  status?: (typeof TITLE_ORDER_STATUSES)[number]
}): Promise<{ success: boolean; orderId?: string; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!input.propertyAddress?.trim()) return { success: false, error: "property_address_required" }
  const status = input.status ?? "ordered"
  if (!TITLE_ORDER_STATUSES.includes(status)) return { success: false, error: "invalid_status" }
  const svc = createServiceClient()
  const { data, error } = await svc.from("title_orders").insert({
    brokerage_id: ctx.brokerageId,
    vendor_id: input.titleVendorId ?? null,
    transaction_id: input.transactionId ?? null,
    property_address: input.propertyAddress.trim(),
    closing_date: input.closingDate ?? null,
    status,
    search_result: input.searchResult ?? null, // the title-search findings (l72_s12)
  }).select("id").single()
  if (error) return { success: false, error: error.message }
  revalidatePath("/title/orders")
  revalidatePath("/dashboard/partners")
  return { success: true, orderId: data.id as string }
}

export async function updateTitleOrderStatus(
  orderId: string,
  status: (typeof TITLE_ORDER_STATUSES)[number],
  searchResult?: Record<string, unknown> | null,
): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!TITLE_ORDER_STATUSES.includes(status)) return { success: false, error: "invalid_status" }
  const svc = createServiceClient()
  const { error } = await svc.from("title_orders")
    .update({
      status,
      updated_at: new Date().toISOString(),
      ...(status === "completed" ? { completed_at: new Date().toISOString() } : {}),
      ...(searchResult !== undefined ? { search_result: searchResult } : {}),
    })
    .eq("id", orderId)
    .eq("brokerage_id", ctx.brokerageId)
  if (error) return { success: false, error: error.message }
  revalidatePath("/title/orders")
  return { success: true }
}
