"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { requireVendorActor } from "@/lib/kernel/portal-auth"
import { stripe } from "@/lib/stripe"
import {
  readVendorStripeConnect,
  upsertVendorStripeAccount,
  setVendorStripeOnboarding,
} from "@/lib/connections/vendor-stripe"

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
// the `vendors` table (the FK target for vendor_invoices.vendor_id,
// vendor_bookings.vendor_id, etc.). vendor_marketplace_profiles is a
// GLOBAL catalog with no brokerage_id — it cannot be used for tenant
// scoping. Brokerage-side payment ops MUST go through this helper.
async function verifyVendorInCallerBrokerage(
  vendorId: string,
  callerBrokerageId: string,
): Promise<boolean> {
  if (!vendorId) return false
  const svc = createServiceClient()
  const { data } = await svc
    .from("vendors")
    .select("brokerage_id")
    .eq("id", vendorId)
    .maybeSingle()
  return !!data && data.brokerage_id === callerBrokerageId
}

async function verifyInvoiceInCallerBrokerage(
  invoiceId: string,
  callerBrokerageId: string,
): Promise<{ ok: true; vendor_id: string; total_amount: number; brokerage_id: string; billed_to: string; status: string } | { ok: false }> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("vendor_invoices")
    .select("vendor_id, total_amount, brokerage_id, billed_to, status")
    .eq("id", invoiceId)
    .maybeSingle()
  if (!data || data.brokerage_id !== callerBrokerageId) return { ok: false }
  return {
    ok: true,
    vendor_id: data.vendor_id,
    total_amount: data.total_amount,
    brokerage_id: data.brokerage_id,
    billed_to: data.billed_to,
    status: data.status,
  }
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
  /**
   * Who receives the invoice:
   *   'brokerage' — vendor bills the tenant (the original lane)
   *   'contact'   — vendor bills the buyer/seller directly (portal + pay-online lane)
   *   'vendor'    — the TENANT bills the vendor (general tenant→vendor charge).
   *                 Requires migration 1104 (billed_to CHECK loosened to include 'vendor').
   */
  billedTo: "brokerage" | "contact" | "vendor"
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
    // Pre-migration honesty: billed_to='vendor' needs the CHECK loosened (migration 1104).
    if (params.billedTo === "vendor" && /billed_to/i.test(error?.message ?? "")) {
      return {
        success: false,
        error: "Charging a vendor requires database migration 1104 (vendor_invoices.billed_to 'vendor') — ask your administrator to apply it.",
      }
    }
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

  // A tenant→vendor CHARGE (billed_to='vendor') is money flowing vendor→brokerage —
  // marking it paid must NOT mint vendor earnings (that would offer the vendor a payout
  // of funds they OWED the brokerage).
  if (verify.billed_to === "vendor") {
    return { success: true, invoiceId: params.invoiceId }
  }

  // Create earnings record so the vendor sees the payment. The platform does NOT take a cut of a
  // vendor's client invoice — vendors are billed separately for platform use — so the vendor keeps the
  // full amount (platform_fee 0, net = gross).
  const gross = verify.total_amount ?? 0

  await svc.from("vendor_earnings").insert({
    vendor_id: verify.vendor_id,
    brokerage_id: ctx.brokerageId,
    invoice_id: params.invoiceId,
    gross_amount: gross,
    platform_fee: 0,
    net_amount: gross,
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

  // The vendor's Connect account lives on the unified owner model
  // (platform_credentials, owner_type="vendor") — the same record the
  // Connection Center writes, so onboarding via either surface is one account.
  const connect = await readVendorStripeConnect(svc, vendorId)

  let accountId: string

  if (connect.accountId) {
    accountId = connect.accountId
  } else {
    // Create a Stripe Express account
    const account = await stripe.accounts.create({ type: "express" })
    accountId = account.id

    const { error } = await upsertVendorStripeAccount(svc, {
      vendorId,
      brokerageId: actor.brokerageId,
      accountId,
    })
    if (error) return { success: false, error }
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
    // Vendor Connect account on the unified owner model — tenant scope was
    // already enforced by verifyVendorInCallerBrokerage above.
    const connect = await readVendorStripeConnect(svc, params.vendorId)

    if (!connect.accountId || !connect.onboardingComplete) {
      return { success: false, error: "Vendor Stripe account not set up" }
    }

    const transfer = await stripe.transfers.create({
      amount: Math.round(params.amount * 100), // cents
      currency: "usd",
      destination: connect.accountId,
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

  // Connect account on the unified owner model; tenant scope enforced via
  // requireVendorActor() above.
  const connect = await readVendorStripeConnect(svc, vendorId)

  if (!connect.accountId) {
    return { success: false, error: "No Stripe account found" }
  }

  // Verify the account is actually onboarded in Stripe
  const account = await stripe.accounts.retrieve(connect.accountId)
  const complete = Boolean(account.details_submitted && account.charges_enabled)

  await setVendorStripeOnboarding(svc, vendorId, complete)

  return { success: complete, error: complete ? undefined : "Onboarding not yet complete in Stripe" }
}

// ═══════════════════════════════════════════════════════════════════════════
// VENDOR → BUYER/SELLER INVOICING (the client-billing lane)
//
// MIGRATION NOTE (1104 — write the SQL, do not apply here):
//   ALTER TABLE vendor_invoices DROP CONSTRAINT IF EXISTS vendor_invoices_billed_to_check;
//   ALTER TABLE vendor_invoices ADD CONSTRAINT vendor_invoices_billed_to_check
//     CHECK (billed_to IN ('brokerage', 'contact', 'vendor'));
//   ALTER TABLE vendor_invoices
//     ADD COLUMN IF NOT EXISTS quickbooks_invoice_id TEXT,
//     ADD COLUMN IF NOT EXISTS quickbooks_synced_at TIMESTAMPTZ;
// billed_to='contact' + the contact-billing lane below work WITHOUT the migration;
// only billed_to='vendor' (tenant→vendor charges) and QBO sync recording need it.
// ═══════════════════════════════════════════════════════════════════════════

/** Direct-collection settlement: the money went straight to the vendor (Stripe
 *  destination charge on their connected account, or off-platform collection they
 *  asserted) — record earnings as ALREADY paid out so the payout lane never offers
 *  to transfer funds the platform does not hold. */
async function recordDirectCollectionEarnings(args: {
  vendorId: string
  brokerageId: string
  invoiceId: string
  gross: number
}): Promise<void> {
  const svc = createServiceClient()
  await svc.from("vendor_earnings").insert({
    vendor_id: args.vendorId,
    brokerage_id: args.brokerageId,
    invoice_id: args.invoiceId,
    gross_amount: args.gross,
    platform_fee: 0,
    net_amount: args.gross,
    status: "paid_out",
  })
}

/** Best-effort push of a paid/issued invoice into the VENDOR's QuickBooks. Never
 *  blocks the calling flow; "not connected" is a silent no-op (honest not-synced). */
async function tryVendorQuickBooksSync(vendorId: string, invoiceId: string): Promise<void> {
  try {
    const { pushVendorInvoiceToQuickBooks } = await import("@/lib/connections/vendor-quickbooks")
    await pushVendorInvoiceToQuickBooks(createServiceClient(), { vendorId, invoiceId })
  } catch (err) {
    console.error("[vendor-payments] QuickBooks sync failed (non-blocking):", err)
  }
}

export interface VendorClientInvoiceParams {
  vendorId: string
  bookingId?: string
  transactionId?: string
  listingId?: string
  billedTo: "brokerage" | "contact"
  contactId?: string
  invoiceNumber?: string
  dueDate?: string
  lineItems: InvoiceLineItem[]
  taxRate?: number
  notes?: string
}

export interface VendorClientInvoiceResult {
  success: boolean
  invoiceId?: string
  /** True only when the notification email was ACCEPTED by the provider. The invoice
   *  is visible in the client's portal regardless — this reports the email honestly. */
  emailSent?: boolean
  emailError?: string
  error?: string
}

/**
 * createAndSendVendorClientInvoice — the VENDOR (portal actor) raises an invoice from an
 * accepted/completed job and ISSUES it (status 'submitted' = issued & awaiting payment,
 * the same vocabulary the premium-placement lane uses). When billed to a contact, the
 * buyer/seller is notified through the governed dispatchEmail as TRANSACTIONAL — the
 * recipient initiated this business relationship by booking the vendor — with a link to
 * their portal invoice surface, where they can pay online (vendor Stripe Connect) or see
 * direct-payment instructions.
 */
export async function createAndSendVendorClientInvoice(
  params: VendorClientInvoiceParams
): Promise<VendorClientInvoiceResult> {
  // Vendor portal gate — the caller must BE this vendor (user_role_assignments).
  let actor
  try {
    actor = await requireVendorActor(params.vendorId)
  } catch {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()

  // Every referenced row must live in the vendor's brokerage (tenant anchor).
  if (params.bookingId) {
    const { data: bk } = await svc
      .from("vendor_bookings")
      .select("brokerage_id, vendor_id")
      .eq("id", params.bookingId)
      .maybeSingle()
    if (!bk || bk.brokerage_id !== actor.brokerageId || bk.vendor_id !== actor.vendorId) {
      return { success: false, error: "Booking is not yours" }
    }
  }
  if (params.transactionId) {
    const { data: tx } = await svc
      .from("transactions").select("brokerage_id").eq("id", params.transactionId).maybeSingle()
    if (!tx || tx.brokerage_id !== actor.brokerageId) {
      return { success: false, error: "Transaction not in your brokerage" }
    }
  }
  if (params.listingId) {
    const { data: lst } = await svc
      .from("listings").select("brokerage_id").eq("id", params.listingId).maybeSingle()
    if (!lst || lst.brokerage_id !== actor.brokerageId) {
      return { success: false, error: "Listing not in your brokerage" }
    }
  }

  let contact: { id: string; first_name: string | null; last_name: string | null; email: string | null } | null = null
  if (params.billedTo === "contact") {
    if (!params.contactId) return { success: false, error: "Select the buyer or seller to bill" }
    const { data: ct } = await svc
      .from("contacts")
      .select("id, brokerage_id, first_name, last_name, email")
      .eq("id", params.contactId)
      .maybeSingle()
    if (!ct || ct.brokerage_id !== actor.brokerageId) {
      return { success: false, error: "Contact not in your brokerage" }
    }
    contact = ct
  }

  const subtotal = params.lineItems.reduce((s, l) => s + l.amount, 0)
  if (!(subtotal > 0)) return { success: false, error: "Add at least one line item with a price" }
  const taxRate = params.taxRate ?? 0
  const taxAmount = parseFloat((subtotal * taxRate).toFixed(2))
  const totalAmount = parseFloat((subtotal + taxAmount).toFixed(2))
  const invoiceNumber =
    params.invoiceNumber ?? `INV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

  const { data: invoice, error } = await svc
    .from("vendor_invoices")
    .insert({
      brokerage_id: actor.brokerageId,
      vendor_id: actor.vendorId,
      booking_id: params.bookingId ?? null,
      transaction_id: params.transactionId ?? null,
      listing_id: params.listingId ?? null,
      billed_to: params.billedTo,
      contact_id: params.billedTo === "contact" ? params.contactId : null,
      invoice_number: invoiceNumber,
      invoice_date: new Date().toISOString().slice(0, 10),
      due_date: params.dueDate ?? null,
      line_items: params.lineItems,
      subtotal,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      // 'submitted' = issued & awaiting payment (live CHECK vocabulary — no 'sent'/'pending').
      status: "submitted",
      notes: params.notes ?? null,
    })
    .select("id")
    .single()

  if (error || !invoice) {
    return { success: false, error: error?.message ?? "Failed to create invoice" }
  }

  // ── Client notification — governed dispatchEmail, TRANSACTIONAL purpose ──────
  let emailSent = false
  let emailError: string | undefined
  if (params.billedTo === "contact" && contact) {
    if (!contact.email) {
      emailError = "Contact has no email on file — the invoice is visible in their portal, but no notification was sent."
    } else {
      try {
        const { dispatchEmail } = await import("@/lib/providers/dispatch")
        const { DEFAULT_PRODUCT_BRAND } = await import("@/lib/platform/product-brand")
        const { data: vendorRow } = await svc
          .from("vendors").select("name").eq("id", actor.vendorId).maybeSingle()
        const vendorName = vendorRow?.name ?? "Your service provider"
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
        const portalLink = `${appUrl}/portal/${contact.id}/invoices`
        const esc = (s: string) => s.replace(/</g, "&lt;")
        const linesHtml = params.lineItems
          .map(
            (l) =>
              `<tr><td style="padding:6px 0">${esc(l.description || "Service")}</td><td style="padding:6px 0;text-align:right">$${l.amount.toFixed(2)}</td></tr>`
          )
          .join("")
        const fromEmail = process.env.SENDGRID_FROM_EMAIL ?? "noreply@vip-re.com"
        const result = await dispatchEmail({
          brokerageId: actor.brokerageId,
          userId: actor.userId,
          contactId: contact.id,
          systemSource: "vendor_client_invoice",
          channelPurpose: "transactional",
          from: `${DEFAULT_PRODUCT_BRAND.name} <${fromEmail}>`,
          to: contact.email,
          subject: `Invoice ${invoiceNumber} from ${vendorName} — $${totalAmount.toFixed(2)}`,
          html: `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#f9fafb;padding:32px 0">
            <table width="560" style="margin:0 auto;background:#fff;border-radius:8px;overflow:hidden">
              <tr><td style="padding:20px;background:#1f2937;color:#fff">
                <h2 style="margin:0">Invoice from ${esc(vendorName)}</h2>
                <p style="margin:4px 0 0;opacity:.85;font-size:13px">Hi ${esc(contact.first_name ?? "there")},</p>
              </td></tr>
              <tr><td style="padding:20px">
                <p style="margin:0 0 12px;font-size:14px">${esc(vendorName)} sent you invoice <strong>${esc(invoiceNumber)}</strong> for services on your transaction.</p>
                <table style="width:100%;font-size:13px">${linesHtml}
                  <tr><td style="padding:8px 0;border-top:1px solid #e5e7eb"><strong>Total</strong></td><td style="padding:8px 0;border-top:1px solid #e5e7eb;text-align:right"><strong>$${totalAmount.toFixed(2)}</strong></td></tr>
                </table>
                ${params.dueDate ? `<p style="margin:8px 0 0;font-size:13px;color:#6b7280">Due ${esc(params.dueDate)}</p>` : ""}
                <p style="margin:16px 0 0;font-size:14px"><a href="${portalLink}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">View &amp; pay in your portal</a></p>
              </td></tr>
            </table></body></html>`,
          metadata: { vendor_invoice_id: invoice.id, vendor_id: actor.vendorId },
        })
        emailSent = result.success
        if (!result.success) emailError = result.error
      } catch (err) {
        emailError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  return { success: true, invoiceId: invoice.id, emailSent, emailError }
}

// ---------------------------------------------------------------------------
// markClientInvoiceCollected — the vendor's ASSERTION of off-platform collection
// (the premium-placement idiom: nothing is simulated; this documents that the
// vendor collected check / cash / card outside the platform).
// ---------------------------------------------------------------------------

export async function markClientInvoiceCollected(params: {
  vendorId: string
  invoiceId: string
  paymentMethod?: string
}): Promise<InvoiceResult> {
  let actor
  try {
    actor = await requireVendorActor(params.vendorId)
  } catch {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()
  const { data: invoice } = await svc
    .from("vendor_invoices")
    .select("id, vendor_id, brokerage_id, billed_to, status, total_amount")
    .eq("id", params.invoiceId)
    .eq("vendor_id", actor.vendorId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()

  if (!invoice) return { success: false, error: "Invoice not found in your scope" }
  if (invoice.status === "paid") return { success: false, error: "Invoice already marked paid" }
  if (invoice.status === "cancelled") return { success: false, error: "Invoice was cancelled" }

  const { error } = await svc
    .from("vendor_invoices")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      // Assertion of off-platform collection — kept distinct from 'stripe' so the
      // ledger never claims a provider-verified payment it didn't have.
      payment_method: params.paymentMethod || "off_platform",
    })
    .eq("id", params.invoiceId)
    .eq("vendor_id", actor.vendorId)
    .neq("status", "paid")

  if (error) return { success: false, error: error.message }

  await recordDirectCollectionEarnings({
    vendorId: actor.vendorId,
    brokerageId: actor.brokerageId,
    invoiceId: params.invoiceId,
    gross: invoice.total_amount ?? 0,
  })
  void tryVendorQuickBooksSync(actor.vendorId, params.invoiceId)

  return { success: true, invoiceId: params.invoiceId }
}

// ---------------------------------------------------------------------------
// Contact pay-online lane — Stripe Checkout DESTINATION CHARGE on the vendor's
// connected account. The platform key creates the session; funds settle on the
// VENDOR's Stripe account (transfer_data.destination). 'paid' is only recorded
// after Stripe confirms payment_status='paid' on the session (real provider
// acceptance — never on redirect alone).
// ---------------------------------------------------------------------------

async function verifyContactCaller(
  contactId: string,
  opts?: { allowStaff?: boolean },
): Promise<
  | { ok: true; contact: { id: string; brokerage_id: string; first_name: string | null; email: string | null } }
  | { ok: false; error: string }
> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("id, brokerage_id, first_name, email, contact_user_id")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact) return { ok: false, error: "Contact not found" }

  const isSelf =
    contact.contact_user_id === user.id ||
    (!!contact.email && !!user.email && contact.email.toLowerCase() === user.email.toLowerCase())

  if (isSelf) return { ok: true, contact }

  if (opts?.allowStaff) {
    const { data: caller } = await svc
      .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
    if (caller?.brokerage_id && caller.brokerage_id === contact.brokerage_id) {
      return { ok: true, contact }
    }
  }
  return { ok: false, error: "Forbidden" }
}

const PAYABLE_STATUSES = new Set(["submitted", "viewed", "overdue"])

export async function startVendorInvoiceCheckout(params: {
  contactId: string
  invoiceId: string
}): Promise<{ success: boolean; url?: string; error?: string }> {
  // Only the contact themselves initiates their own payment.
  const gate = await verifyContactCaller(params.contactId)
  if (!gate.ok) return { success: false, error: gate.error }

  const svc = createServiceClient()
  const { data: invoice } = await svc
    .from("vendor_invoices")
    .select("id, vendor_id, brokerage_id, contact_id, billed_to, status, total_amount, invoice_number")
    .eq("id", params.invoiceId)
    .eq("contact_id", params.contactId)
    .eq("billed_to", "contact")
    .maybeSingle()

  if (!invoice) return { success: false, error: "Invoice not found" }
  if (invoice.status === "paid") return { success: false, error: "Invoice is already paid" }
  if (!PAYABLE_STATUSES.has(invoice.status)) {
    return { success: false, error: `Invoice is not payable (status: ${invoice.status})` }
  }

  // The vendor must have completed Stripe Connect onboarding — otherwise the portal
  // shows honest pay-the-vendor-directly instructions instead of this button.
  const connect = await readVendorStripeConnect(svc, invoice.vendor_id)
  if (!connect.accountId || !connect.onboardingComplete) {
    return { success: false, error: "This vendor does not accept online payments yet — pay them directly." }
  }

  const amountCents = Math.round(Number(invoice.total_amount ?? 0) * 100)
  if (!(amountCents > 0)) return { success: false, error: "Invoice total is zero" }

  const { data: vendorRow } = await svc
    .from("vendors").select("name").eq("id", invoice.vendor_id).maybeSingle()
  const vendorName = vendorRow?.name ?? "Vendor"

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  const invoiceLabel = invoice.invoice_number ?? `INV-${invoice.id.slice(0, 8).toUpperCase()}`

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: { name: `Invoice ${invoiceLabel} — ${vendorName}` },
          },
        },
      ],
      // DESTINATION CHARGE: funds settle on the vendor's connected account.
      payment_intent_data: {
        transfer_data: { destination: connect.accountId },
        metadata: {
          vendor_invoice_id: invoice.id,
          vendor_id: invoice.vendor_id,
          brokerage_id: invoice.brokerage_id ?? "",
        },
      },
      metadata: { vendor_invoice_id: invoice.id, contact_id: params.contactId },
      customer_email: gate.contact.email ?? undefined,
      success_url: `${appUrl}/portal/${params.contactId}/invoices?checkout=success&invoice=${invoice.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/portal/${params.contactId}/invoices?checkout=cancelled&invoice=${invoice.id}`,
    })
    if (!session.url) return { success: false, error: "Stripe did not return a checkout URL" }
    return { success: true, url: session.url }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function confirmVendorInvoiceCheckout(params: {
  contactId: string
  invoiceId: string
  sessionId: string
}): Promise<{ success: boolean; alreadyPaid?: boolean; error?: string }> {
  // Contact-self or same-brokerage staff (staff may land on the portal preview).
  const gate = await verifyContactCaller(params.contactId, { allowStaff: true })
  if (!gate.ok) return { success: false, error: gate.error }

  const svc = createServiceClient()
  const { data: invoice } = await svc
    .from("vendor_invoices")
    .select("id, vendor_id, brokerage_id, contact_id, status, total_amount")
    .eq("id", params.invoiceId)
    .eq("contact_id", params.contactId)
    .eq("billed_to", "contact")
    .maybeSingle()

  if (!invoice) return { success: false, error: "Invoice not found" }
  if (invoice.status === "paid") return { success: true, alreadyPaid: true }

  // REAL provider acceptance: retrieve the session and require payment_status='paid'
  // for THIS invoice. A redirect with an unpaid/foreign session changes nothing.
  let session
  try {
    session = await stripe.checkout.sessions.retrieve(params.sessionId)
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (session.metadata?.vendor_invoice_id !== params.invoiceId) {
    return { success: false, error: "Checkout session does not match this invoice" }
  }
  if (session.payment_status !== "paid") {
    return { success: false, error: "Payment not completed" }
  }

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null

  const { error } = await svc
    .from("vendor_invoices")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      payment_method: "stripe",
      stripe_payment_intent_id: paymentIntentId,
    })
    .eq("id", params.invoiceId)
    .neq("status", "paid") // double-confirm guard

  if (error) return { success: false, error: error.message }

  // Funds settled directly on the vendor's connected account — earnings are paid_out.
  await recordDirectCollectionEarnings({
    vendorId: invoice.vendor_id,
    brokerageId: invoice.brokerage_id,
    invoiceId: params.invoiceId,
    gross: invoice.total_amount ?? 0,
  })
  void tryVendorQuickBooksSync(invoice.vendor_id, params.invoiceId)

  return { success: true }
}

// ---------------------------------------------------------------------------
// syncVendorInvoiceToQuickBooksAction — vendor-initiated push of ONE invoice
// into THEIR OWN QuickBooks company (owner-scoped credential, oauth route).
// ---------------------------------------------------------------------------

export async function syncVendorInvoiceToQuickBooksAction(params: {
  vendorId: string
  invoiceId: string
}): Promise<{ success: boolean; externalId?: string; error?: string }> {
  let actor
  try {
    actor = await requireVendorActor(params.vendorId)
  } catch {
    return { success: false, error: "Unauthorized" }
  }

  const { pushVendorInvoiceToQuickBooks } = await import("@/lib/connections/vendor-quickbooks")
  const outcome = await pushVendorInvoiceToQuickBooks(createServiceClient(), {
    vendorId: actor.vendorId,
    invoiceId: params.invoiceId,
  })
  if (!outcome.attempted && !outcome.error) {
    return { success: false, error: "QuickBooks is not connected — connect it in your vendor settings first." }
  }
  return { success: outcome.success, externalId: outcome.externalId, error: outcome.error }
}

// ═══════════════════════════════════════════════════════════════════════════
// TENANT → VENDOR CHARGING (general charge beyond premium placement)
// ═══════════════════════════════════════════════════════════════════════════

const VENDOR_CHARGE_ADMIN_ROLES = new Set([
  "broker", "broker_owner", "broker_admin", "admin", "superadmin", "team_lead",
])

/**
 * issueVendorCharge — brokerage leadership bills a vendor (billed_to='vendor',
 * status 'submitted' = issued & awaiting payment). Collection is off-platform
 * (check / ACH / an externally-sent Stripe invoice) exactly like premium
 * placement; markVendorChargePaid below is the tenant's assertion of collection.
 * Requires migration 1104 (billed_to CHECK includes 'vendor') — a pre-migration
 * attempt fails with an honest migration message, never a silent fallback.
 */
export async function issueVendorCharge(params: {
  vendorId: string
  lineItems: InvoiceLineItem[]
  dueDate?: string
  notes?: string
}): Promise<{ success: boolean; invoiceId?: string; invoiceNumber?: string; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!VENDOR_CHARGE_ADMIN_ROLES.has(ctx.userType)) {
    return { success: false, error: "Forbidden: broker, admin, or team lead only" }
  }
  if (!await verifyVendorInCallerBrokerage(params.vendorId, ctx.brokerageId)) {
    return { success: false, error: "Forbidden: vendor not in your brokerage" }
  }

  const invoiceNumber = `VC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  const created = await createVendorInvoice({
    vendorId: params.vendorId,
    billedTo: "vendor",
    invoiceNumber,
    dueDate: params.dueDate,
    lineItems: params.lineItems,
    notes: params.notes,
  })
  if (!created.success || !created.invoiceId) return { success: false, error: created.error }

  // createVendorInvoice writes 'draft' — issue it (same transition submitVendorInvoice makes).
  const svc = createServiceClient()
  const { error: issueErr } = await svc
    .from("vendor_invoices")
    .update({ status: "submitted" })
    .eq("id", created.invoiceId)
    .eq("brokerage_id", ctx.brokerageId)
  if (issueErr) return { success: false, error: issueErr.message }

  // Best-effort B2B transactional notification to the vendor.
  try {
    const { data: vendorRow } = await svc
      .from("vendors").select("name, email").eq("id", params.vendorId).maybeSingle()
    if (vendorRow?.email) {
      const { dispatchEmail } = await import("@/lib/providers/dispatch")
      const { DEFAULT_PRODUCT_BRAND } = await import("@/lib/platform/product-brand")
      const total = params.lineItems.reduce((s, l) => s + l.amount, 0)
      const esc = (s: string) => s.replace(/</g, "&lt;")
      const fromEmail = process.env.SENDGRID_FROM_EMAIL ?? "noreply@vip-re.com"
      await dispatchEmail({
        brokerageId: ctx.brokerageId,
        userId: ctx.userId,
        systemSource: "vendor_charge",
        channelPurpose: "transactional",
        from: `${DEFAULT_PRODUCT_BRAND.name} <${fromEmail}>`,
        to: vendorRow.email,
        subject: `Invoice ${invoiceNumber} from your brokerage partner — $${total.toFixed(2)}`,
        html: `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#f9fafb;padding:32px 0">
          <table width="560" style="margin:0 auto;background:#fff;border-radius:8px;overflow:hidden">
            <tr><td style="padding:20px;background:#1f2937;color:#fff"><h2 style="margin:0">New invoice</h2></td></tr>
            <tr><td style="padding:20px;font-size:14px">
              <p style="margin:0 0 12px">Hi ${esc(vendorRow.name ?? "there")},</p>
              <p style="margin:0 0 12px">Your brokerage partner issued invoice <strong>${esc(invoiceNumber)}</strong> for <strong>$${total.toFixed(2)}</strong>${params.dueDate ? `, due ${esc(params.dueDate)}` : ""}.</p>
              ${params.notes ? `<p style="margin:0 0 12px;color:#6b7280">${esc(params.notes)}</p>` : ""}
              <p style="margin:0">You can view your invoices in your vendor portal under Invoices.</p>
            </td></tr>
          </table></body></html>`,
        metadata: { vendor_invoice_id: created.invoiceId, vendor_id: params.vendorId },
      })
    }
  } catch (err) {
    console.error("[issueVendorCharge] vendor notification failed (non-blocking):", err)
  }

  return { success: true, invoiceId: created.invoiceId, invoiceNumber }
}

/**
 * markVendorChargePaid — the tenant's assertion that a vendor charge was collected
 * off-platform (premium-placement idiom). Never mints vendor_earnings: the money
 * flowed vendor → brokerage.
 */
export async function markVendorChargePaid(params: {
  invoiceId: string
  paymentMethod?: string
}): Promise<InvoiceResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!VENDOR_CHARGE_ADMIN_ROLES.has(ctx.userType)) {
    return { success: false, error: "Forbidden: broker, admin, or team lead only" }
  }

  const verify = await verifyInvoiceInCallerBrokerage(params.invoiceId, ctx.brokerageId)
  if (!verify.ok) return { success: false, error: "Forbidden" }
  if (verify.billed_to !== "vendor") return { success: false, error: "Not a vendor charge" }
  if (verify.status === "paid") return { success: false, error: "Invoice already marked paid" }
  if (verify.status === "cancelled") return { success: false, error: "Invoice was cancelled" }

  const svc = createServiceClient()
  const { error } = await svc
    .from("vendor_invoices")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      payment_method: params.paymentMethod || "off_platform",
    })
    .eq("id", params.invoiceId)
    .eq("brokerage_id", ctx.brokerageId)
    .neq("status", "paid")

  if (error) return { success: false, error: error.message }
  return { success: true, invoiceId: params.invoiceId }
}
