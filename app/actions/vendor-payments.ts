"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { stripe } from "@/lib/stripe"

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
  if (!ctx.isAuthenticated) return { success: false, error: "Unauthorized" }

  const svc = createServiceClient()

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
  if (!ctx.isAuthenticated) return { success: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { error } = await svc
    .from("vendor_invoices")
    .update({ status: "submitted" })
    .eq("id", invoiceId)

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
  if (!ctx.isAuthenticated) return { success: false, error: "Unauthorized" }

  const svc = createServiceClient()

  // Fetch invoice to compute earnings
  const { data: invoice } = await svc
    .from("vendor_invoices")
    .select("vendor_id, brokerage_id, total_amount")
    .eq("id", params.invoiceId)
    .single()

  const { error: updateErr } = await svc
    .from("vendor_invoices")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      payment_method: params.paymentMethod ?? "manual",
      stripe_payment_intent_id: params.stripePaymentIntentId ?? null,
    })
    .eq("id", params.invoiceId)

  if (updateErr) return { success: false, error: updateErr.message }

  // Create earnings record so vendor sees the payment
  if (invoice) {
    // Brokerage revenue share defaults to 0 if not configured
    const { data: profile } = await svc
      .from("vendor_marketplace_profiles")
      .select("revenue_share_percent")
      .eq("id", invoice.vendor_id)
      .maybeSingle()

    const revenueSharePct = (profile?.revenue_share_percent ?? 0) / 100
    const gross = invoice.total_amount ?? 0
    const platformFee = parseFloat((gross * revenueSharePct).toFixed(2))
    const net = parseFloat((gross - platformFee).toFixed(2))

    await svc.from("vendor_earnings").insert({
      vendor_id: invoice.vendor_id,
      brokerage_id: invoice.brokerage_id,
      invoice_id: params.invoiceId,
      gross_amount: gross,
      platform_fee: platformFee,
      net_amount: net,
      status: "available",
    })
  }

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
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Unauthorized" }

  const svc = createServiceClient()

  // Check if account already exists
  const { data: profile } = await svc
    .from("vendor_marketplace_profiles")
    .select("stripe_account_id, stripe_onboarding_complete")
    .eq("id", vendorId)
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
  if (!ctx.isAuthenticated) return { success: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const method = params.method ?? "stripe"

  let stripeTransferId: string | undefined

  if (method === "stripe") {
    const { data: profile } = await svc
      .from("vendor_marketplace_profiles")
      .select("stripe_account_id, stripe_onboarding_complete")
      .eq("id", params.vendorId)
      .maybeSingle()

    if (!profile?.stripe_account_id || !profile.stripe_onboarding_complete) {
      return { success: false, error: "Vendor Stripe account not set up" }
    }

    const transfer = await stripe.transfers.create({
      amount: Math.round(params.amount * 100), // cents
      currency: "usd",
      destination: profile.stripe_account_id,
      metadata: { vendorId: params.vendorId },
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

  // Mark covered earnings as paid_out
  if (params.earningIds?.length) {
    await svc
      .from("vendor_earnings")
      .update({ status: "paid_out" })
      .in("id", params.earningIds)
  }

  return { success: true, payoutId: payout.id }
}

// ---------------------------------------------------------------------------
// getVendorEarningsSummary — used by vendor earnings page
// ---------------------------------------------------------------------------

export async function getVendorEarningsSummary(
  vendorId: string
): Promise<VendorEarningsSummary> {
  const svc = createServiceClient()

  const [{ data: earnings }, { data: invoices }, { data: payouts }] =
    await Promise.all([
      svc
        .from("vendor_earnings")
        .select("*")
        .eq("vendor_id", vendorId),
      svc
        .from("vendor_invoices")
        .select("id, invoice_number, total_amount, status, due_date, paid_at, billed_to")
        .eq("vendor_id", vendorId)
        .order("created_at", { ascending: false }),
      svc
        .from("vendor_payouts")
        .select("id, amount, payout_method, status, initiated_at, completed_at")
        .eq("vendor_id", vendorId)
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
  const svc = createServiceClient()

  const { data: profile } = await svc
    .from("vendor_marketplace_profiles")
    .select("stripe_account_id")
    .eq("id", vendorId)
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

  return { success: complete, error: complete ? undefined : "Onboarding not yet complete in Stripe" }
}
