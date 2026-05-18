"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { requireVendorActor } from "@/lib/kernel/portal-auth"
import { stripe } from "@/lib/stripe"

// ─── Auth helpers ─────────────────────────────────────────────────────────────
//
// Previously this file auth-gated callers but then BLINDLY trusted
// caller-supplied vendorId / invoiceId / earningId across every payment
// path. Concrete impacts:
//   - markInvoicePaid: any caller could mark ANY tenant's invoice paid
//     AND create vendor_earnings rows, then immediately call
//     initiateVendorPayout to wire money into their own Stripe Connect
//     account. Cross-tenant financial exfiltration.
//   - initiateVendorPayout: stripe.transfers.create() with destination =
//     caller-controlled vendor's stripe_account_id. Any caller could
//     drain another brokerage's available earnings by passing the right
//     vendorId.
//   - initiateStripeConnectOnboarding: could create or repoint Stripe
//     Connect accounts on arbitrary vendors.
//   - createVendorInvoice: could draft invoices under any brokerage
//     against any vendor.
//
// verifyVendorInCallerBrokerage() resolves the vendor's brokerage from
// vendor_marketplace_profiles and confirms it matches the caller's
// session brokerage. Brokerage-side payment ops MUST go through this.
async function verifyVendorInCallerBrokerage(
  vendorId: string,
  callerBrokerageId: string,
): Promise<boolean> {
  if (!vendorId) return false
  const svc = createServiceClient()
  const { data } = await svc
    .from("vendor_marketplace_profiles")
    .select("brokerage_id")
    .eq("id", vendorId)
    .maybeSingle()
  return !!data && data.brokerage_id === callerBrokerageId
}

async function verifyInvoiceInCallerBrokerage(
  invoiceId: string,
  callerBrokerageId: string,
): Promise<{ ok: true; vendor_id: string; total_amount: number; brokerage_id: string } | { ok: false }> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("vendor_invoices")
    .select("vendor_id, total_amount, brokerage_id")
    .eq("id", invoiceId)
    .maybeSingle()
  if (!data || data.brokerage_id !== callerBrokerageId) return { ok: false }
  return { ok: true, vendor_id: data.vendor_id, total_amount: data.total_amount, brokerage_id: data.brokerage_id }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvoiceLineItem {
  description: string
  quantity: number
  unitPrice: number
  amount: number
}

export interface CreateInvoiceParams {
  vendorId: string
  bookingId?: string
  transactionId?: string
  listingId?: string
  billedTo: "brokerage" | "contact"
  contactId?: string
  invoiceNumber?: string
  invoiceDate?: string
  dueDate?: string
  lineItems: InvoiceLineItem[]
  taxRate?: number
  notes?: string
}

export interface InvoiceResult {
  success: boolean
  invoiceId?: string
  error?: string
}

export interface VendorEarningsSummary {
  grossTotal: number
  netTotal: number
  pendingAmount: number
  availableAmount: number
  paidOutAmount: number
  invoices: Array<{
    id: string
    invoiceNumber: string | null
    total: number
    status: string
    dueDate: string | null
    paidAt: string | null
    billedTo: string
  }>
  payouts: Array<{
    id: string
    amount: number
    method: string
    status: string
    initiatedAt: string
    completedAt: string | null
  }>
}

// ---------------------------------------------------------------------------
// createVendorInvoice — TC or vendor drafts an invoice
// ---------------------------------------------------------------------------

export async function createVendorInvoice(
  params: CreateInvoiceParams
): Promise<InvoiceResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  // Verify vendor + every referenced row belongs to caller's brokerage
  if (!await verifyVendorInCallerBrokerage(params.vendorId, ctx.brokerageId)) {
    return { success: false, error: "Forbidden: vendor not in your brokerage" }
  }

  const svc = createServiceClient()

  if (params.transactionId) {
    const { data: tx } = await svc
      .from("transactions").select("brokerage_id").eq("id", params.transactionId).maybeSingle()
    if (!tx || tx.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden: transaction not in your brokerage" }
    }
  }
  if (params.listingId) {
    const { data: lst } = await svc
      .from("listings").select("brokerage_id").eq("id", params.listingId).maybeSingle()
    if (!lst || lst.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden: listing not in your brokerage" }
    }
  }
  if (params.contactId) {
    const { data: ct } = await svc
      .from("contacts").select("brokerage_id").eq("id", params.contactId).maybeSingle()
    if (!ct || ct.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden: contact not in your brokerage" }
    }
  }
  if (params.bookingId) {
    const { data: bk } = await svc
      .from("vendor_bookings").select("brokerage_id").eq("id", params.bookingId).maybeSingle()
    if (!bk || bk.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden: booking not in your brokerage" }
    }
  }

  const subtotal = params.lineItems.reduce((s, l) => s + l.amount, 0)
  const taxRate = params.taxRate ?? 0
  const taxAmount = parseFloat((subtotal * taxRate).toFixed(2))
  const totalAmount = parseFloat((subtotal + taxAmount).toFixed(2))

  const { data, error } = await svc
    .from("vendor_invoices")
    .insert({
      brokerage_id: ctx.brokerageId,
      vendor_id: params.vendorId,
      booking_id: params.bookingId ?? null,
      transaction_id: params.transactionId ?? null,
      listing_id: params.listingId ?? null,
      billed_to: params.billedTo,
      contact_id: params.contactId ?? null,
      invoice_number: params.invoiceNumber ?? null,
      invoice_date: params.invoiceDate ?? new Date().toISOString().slice(0, 10),
      due_date: params.dueDate ?? null,
      line_items: params.lineItems,
      subtotal,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      status: "draft",
      notes: params.notes ?? null,
    })
    .select("id")
    .single()

  if (error || !data) {
    return { success: false, error: error?.message ?? "Failed to create invoice" }
  }

  return { success: true, invoiceId: data.id }
}

// ---------------------------------------------------------------------------
// submitVendorInvoice — mark submitted (moves draft → submitted)
// ---------------------------------------------------------------------------

export async function submitVendorInvoice(invoiceId: string): Promise<InvoiceResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const verify = await verifyInvoiceInCallerBrokerage(invoiceId, ctx.brokerageId)
  if (!verify.ok) return { success: false, error: "Forbidden" }

  const svc = createServiceClient()
  const { error } = await svc
    .from("vendor_invoices")
    .update({ status: "submitted" })
    .eq("id", invoiceId)
    .eq("brokerage_id", ctx.brokerageId)

  if (error) return { success: false, error: error.message }
  return { success: true, invoiceId }
}

// ---------------------------------------------------------------------------
// markInvoicePaid — brokerage marks an invoice as paid
// ---------------------------------------------------------------------------

export async function markInvoicePaid(params: {
  invoiceId: string
  paymentMethod?: string
  stripePaymentIntentId?: string
}): Promise<InvoiceResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  // CRITICAL: verify invoice belongs to caller's brokerage before
  // marking paid + creating vendor_earnings. Without this, any caller
  // could mark any tenant's invoice paid, generate available earnings,
  // and pair it with initiateVendorPayout to wire funds out.
  const verify = await verifyInvoiceInCallerBrokerage(params.invoiceId, ctx.brokerageId)
  if (!verify.ok) return { success: false, error: "Forbidden" }

  const svc = createServiceClient()

  const { error: updateErr } = await svc
    .from("vendor_invoices")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      payment_method: params.paymentMethod ?? "manual",
      stripe_payment_intent_id: params.stripePaymentIntentId ?? null,
    })
    .eq("id", params.invoiceId)
    .eq("brokerage_id", ctx.brokerageId)

  if (updateErr) return { success: false, error: updateErr.message }

  // Create earnings record so vendor sees the payment.
  // Use verified vendor_id + brokerage_id from the ownership check above.
  const { data: profile } = await svc
    .from("vendor_marketplace_profiles")
    .select("revenue_share_percent")
    .eq("id", verify.vendor_id)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  const revenueSharePct = (profile?.revenue_share_percent ?? 0) / 100
  const gross = verify.total_amount ?? 0
  const platformFee = parseFloat((gross * revenueSharePct).toFixed(2))
  const net = parseFloat((gross - platformFee).toFixed(2))

  await svc.from("vendor_earnings").insert({
    vendor_id: verify.vendor_id,
    brokerage_id: ctx.brokerageId,
    invoice_id: params.invoiceId,
    gross_amount: gross,
    platform_fee: platformFee,
    net_amount: net,
    status: "available",
  })

  return { success: true, invoiceId: params.invoiceId }
}

// ---------------------------------------------------------------------------
// initiateStripeConnectOnboarding — generates a Stripe Connect onboarding URL
// ---------------------------------------------------------------------------

export async function initiateStripeConnectOnboarding(vendorId: string): Promise<{
  success: boolean
  url?: string
  error?: string
}> {
  // Must be the vendor themselves. requireVendorActor() verifies the
  // session user has a vendor role for THIS vendorId. Otherwise any
  // caller could create or repoint another vendor's Stripe Connect
  // account.
  let actor
  try {
    actor = await requireVendorActor(vendorId)
  } catch {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()

  // Check if account already exists — scoped by brokerage
  const { data: profile } = await svc
    .from("vendor_marketplace_profiles")
    .select("stripe_account_id, stripe_onboarding_complete")
    .eq("id", vendorId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()

  let accountId: string

  if (profile?.stripe_account_id) {
    accountId = profile.stripe_account_id
  } else {
    // Create a Stripe Express account
    const account = await stripe.accounts.create({ type: "express" })
    accountId = account.id

    await svc
      .from("vendor_marketplace_profiles")
      .update({ stripe_account_id: accountId })
      .eq("id", vendorId)
      .eq("brokerage_id", actor.brokerageId)
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${appUrl}/vendor/settings?stripe=refresh`,
    return_url: `${appUrl}/vendor/settings?stripe=complete`,
    type: "account_onboarding",
  })

  return { success: true, url: link.url }
}

// ---------------------------------------------------------------------------
// initiateVendorPayout — transfer available earnings to vendor via Stripe Connect
// ---------------------------------------------------------------------------

export async function initiateVendorPayout(params: {
  vendorId: string
  amount: number
  earningIds?: string[]
  method?: "stripe" | "cash_app" | "check" | "manual"
  cashAppReference?: string
  note?: string
}): Promise<{ success: boolean; payoutId?: string; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  // CRITICAL: caller-supplied vendorId fed straight into stripe.transfers
  // .create() destination. Without this check, any signed-in user could
  // wire money to any other tenant's vendor Stripe Connect account by
  // passing that vendor's id.
  if (!await verifyVendorInCallerBrokerage(params.vendorId, ctx.brokerageId)) {
    return { success: false, error: "Forbidden: vendor not in your brokerage" }
  }

  const svc = createServiceClient()
  const method = params.method ?? "stripe"

  // Verify caller-supplied earningIds also belong to caller's brokerage —
  // otherwise an attacker could "settle" another tenant's earnings rows
  // through this payout.
  if (params.earningIds?.length) {
    const { data: earningsRows } = await svc
      .from("vendor_earnings")
      .select("id, brokerage_id, vendor_id")
      .in("id", params.earningIds)
    const allOk =
      !!earningsRows &&
      earningsRows.length === params.earningIds.length &&
      earningsRows.every(
        (e) => e.brokerage_id === ctx.brokerageId && e.vendor_id === params.vendorId,
      )
    if (!allOk) {
      return { success: false, error: "Forbidden: earnings not in your brokerage / vendor" }
    }
  }

  let stripeTransferId: string | undefined

  if (method === "stripe") {
    const { data: profile } = await svc
      .from("vendor_marketplace_profiles")
      .select("stripe_account_id, stripe_onboarding_complete")
      .eq("id", params.vendorId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    if (!profile?.stripe_account_id || !profile.stripe_onboarding_complete) {
      return { success: false, error: "Vendor Stripe account not set up" }
    }

    const transfer = await stripe.transfers.create({
      amount: Math.round(params.amount * 100), // cents
      currency: "usd",
      destination: profile.stripe_account_id,
      metadata: { vendorId: params.vendorId, brokerageId: ctx.brokerageId },
    })
    stripeTransferId = transfer.id
  }

  const { data: payout, error } = await svc
    .from("vendor_payouts")
    .insert({
      vendor_id: params.vendorId,
      brokerage_id: ctx.brokerageId,
      amount: params.amount,
      payout_method: method,
      stripe_transfer_id: stripeTransferId ?? null,
      cash_app_reference: params.cashAppReference ?? null,
      status: stripeTransferId ? "processing" : "pending",
      earnings_ids: params.earningIds ?? [],
      note: params.note ?? null,
    })
    .select("id")
    .single()

  if (error || !payout) return { success: false, error: error?.message ?? "Failed" }

  // Mark covered earnings as paid_out — scoped
  if (params.earningIds?.length) {
    await svc
      .from("vendor_earnings")
      .update({ status: "paid_out" })
      .in("id", params.earningIds)
      .eq("brokerage_id", ctx.brokerageId)
      .eq("vendor_id", params.vendorId)
  }

  return { success: true, payoutId: payout.id }
}

// ---------------------------------------------------------------------------
// getVendorEarningsSummary — used by vendor earnings page
// ---------------------------------------------------------------------------

export async function getVendorEarningsSummary(
  vendorId: string
): Promise<VendorEarningsSummary> {
  // Allow either the vendor themselves (portal session) or a brokerage
  // admin/agent in the same brokerage as the vendor.
  let brokerageId: string | null = null
  try {
    const actor = await requireVendorActor(vendorId)
    brokerageId = actor.brokerageId
  } catch {
    const ctx = await resolveWriteContext()
    if (ctx.isAuthenticated && ctx.brokerageId &&
        await verifyVendorInCallerBrokerage(vendorId, ctx.brokerageId)) {
      brokerageId = ctx.brokerageId
    }
  }

  if (!brokerageId) {
    return {
      grossTotal: 0, netTotal: 0, pendingAmount: 0, availableAmount: 0, paidOutAmount: 0,
      invoices: [], payouts: [],
    }
  }

  const svc = createServiceClient()

  const [{ data: earnings }, { data: invoices }, { data: payouts }] =
    await Promise.all([
      svc
        .from("vendor_earnings")
        .select("*")
        .eq("vendor_id", vendorId)
        .eq("brokerage_id", brokerageId),
      svc
        .from("vendor_invoices")
        .select("id, invoice_number, total_amount, status, due_date, paid_at, billed_to")
        .eq("vendor_id", vendorId)
        .eq("brokerage_id", brokerageId)
        .order("created_at", { ascending: false }),
      svc
        .from("vendor_payouts")
        .select("id, amount, payout_method, status, initiated_at, completed_at")
        .eq("vendor_id", vendorId)
        .eq("brokerage_id", brokerageId)
        .order("initiated_at", { ascending: false }),
    ])

  const earningsData = earnings ?? []
  const grossTotal = earningsData.reduce((s: number, e: any) => s + (e.gross_amount ?? 0), 0)
  const netTotal = earningsData.reduce((s: number, e: any) => s + (e.net_amount ?? 0), 0)
  const pendingAmount = earningsData.filter((e: any) => e.status === "pending").reduce((s: number, e: any) => s + e.net_amount, 0)
  const availableAmount = earningsData.filter((e: any) => e.status === "available").reduce((s: number, e: any) => s + e.net_amount, 0)
  const paidOutAmount = earningsData.filter((e: any) => e.status === "paid_out").reduce((s: number, e: any) => s + e.net_amount, 0)

  return {
    grossTotal,
    netTotal,
    pendingAmount,
    availableAmount,
    paidOutAmount,
    invoices: (invoices ?? []).map((i: any) => ({
      id: i.id,
      invoiceNumber: i.invoice_number,
      total: i.total_amount,
      status: i.status,
      dueDate: i.due_date,
      paidAt: i.paid_at,
      billedTo: i.billed_to,
    })),
    payouts: (payouts ?? []).map((p: any) => ({
      id: p.id,
      amount: p.amount,
      method: p.payout_method,
      status: p.status,
      initiatedAt: p.initiated_at,
      completedAt: p.completed_at,
    })),
  }
}

// ---------------------------------------------------------------------------
// completeStripeConnectOnboarding — called from the return URL to mark complete
// ---------------------------------------------------------------------------

export async function completeStripeConnectOnboarding(vendorId: string): Promise<{
  success: boolean
  error?: string
}> {
  // Called from the Stripe redirect — must be the vendor themselves
  let actor
  try {
    actor = await requireVendorActor(vendorId)
  } catch {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()

  const { data: profile } = await svc
    .from("vendor_marketplace_profiles")
    .select("stripe_account_id")
    .eq("id", vendorId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()

  if (!profile?.stripe_account_id) {
    return { success: false, error: "No Stripe account found" }
  }

  // Verify the account is actually onboarded in Stripe
  const account = await stripe.accounts.retrieve(profile.stripe_account_id)
  const complete = account.details_submitted && account.charges_enabled

  await svc
    .from("vendor_marketplace_profiles")
    .update({ stripe_onboarding_complete: complete })
    .eq("id", vendorId)
    .eq("brokerage_id", actor.brokerageId)

  return { success: complete, error: complete ? undefined : "Onboarding not yet complete in Stripe" }
}
