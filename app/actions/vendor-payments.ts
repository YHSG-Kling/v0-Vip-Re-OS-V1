"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { resolveActingContext, resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { requireVendorActor } from "@/lib/kernel/portal-auth"
// ── WHICH STRIPE ACCOUNT THIS FILE USES, AND WHY IT IS TWO IMPORTS ──────────
//
// OWNER RULING (verbatim): "no sites should move tenant money on the platform key."
//
// `stripe` (the PLATFORM seam) survives here for exactly three CONNECT-PLATFORM
// ADMIN calls — `accounts.create`, `accountLinks.create`, `accounts.retrieve`. An
// `acct_…` is minted and onboarded ON the Connect platform that will own it, this
// product has exactly one, and none of those three moves a cent. That is the same
// reasoning lib/providers/payment/index.ts :: createConnectedAccount states for
// itself.
//
// Every call in this file that MOVES MONEY goes through lib/providers/payment,
// which resolves the account per call scope and refuses when the tenant has none:
//
//   initiateVendorPayout        → createTransfer      { side: "tenant", brokerageId }
//   startVendorInvoiceCheckout  → createCheckoutSession       ditto
//   confirmVendorInvoiceCheckout→ retrieveCheckoutSession     ditto (same account
//                                 as the session's creator, or the read 404s)
//
// The brokerage in every one of those comes from the SESSION (CLAUDE.md §4) — from
// `resolveWriteContext()` on the staff side, and from the session-verified contact
// row on the portal side. Never from a parameter: a body-supplied brokerage id here
// would select whose bank account the money leaves.
//
// scripts/stripe-account-scope-simulator.ts (C8/C9) holds both halves of that.
import { stripe } from "@/lib/stripe"
import { createTransfer, createCheckoutSession, retrieveCheckoutSession } from "@/lib/providers/payment"
import {
  readVendorStripeConnect,
  upsertVendorStripeAccount,
  setVendorStripeOnboarding,
} from "@/lib/connections/vendor-stripe"
import { assertVendorChargeableForPlatformUse } from "@/lib/vendors/vendor-platform-identity"

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
    /** Manual Cash App transaction reference — how the vendor matches the row
     *  to the payment that reached them. Null for Stripe/other methods. */
    cashAppReference: string | null
    /** The brokerage's free-text note on this payout, written at creation
     *  (`params.note`) and, until now, read by nobody — so a payout that
     *  covered an unusual adjustment arrived with the explanation stranded in
     *  the row. This is the payee's side of a money record; it belongs to them. */
    note: string | null
    /** How many vendor_earnings rows this payout settled. The ids themselves are
     *  the brokerage's bookkeeping, but a lump transfer the vendor cannot tie to
     *  a number of jobs is a number they cannot reconcile — and this is the only
     *  place the count exists (vendor_earnings.status flips to 'paid_out' with
     *  no back-reference to the payout that did it). */
    coveredEarningsCount: number
  }>
}

// ---------------------------------------------------------------------------
// createVendorInvoice — TC or vendor drafts an invoice
// ---------------------------------------------------------------------------

export async function createVendorInvoice(
  params: CreateInvoiceParams
): Promise<InvoiceResult> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  // Verify vendor + every referenced row belongs to caller's brokerage
  if (!await verifyVendorInCallerBrokerage(params.vendorId, ctx.brokerageId)) {
    return { success: false, error: "Forbidden: vendor not in your brokerage" }
  }

  const svc = createServiceClient()

  // ── NO DOUBLE CHARGE FOR PLATFORM USE ──────────────────────────────────────
  // billed_to='vendor' is the ONE tenant→vendor ledger, and every charge on it is
  // a PLATFORM-USE charge (VENDOR_PACKAGE.isPlatformUse) — the tenant billing the
  // vendor for access and placement in the tenant's marketplace. The owner ruling
  // forbids raising one against a vendor already paying for platform use, whether
  // they pay the platform directly or another brokerage.
  //
  // The gate sits HERE rather than only in issueVendorCharge because this is a
  // "use server" file: createVendorInvoice is itself a public HTTP endpoint, and a
  // caller that skipped issueVendorCharge would otherwise write the identical
  // billed_to='vendor' row with none of its checks. billed_to='brokerage' (the
  // vendor billing US for a job) and 'contact' are untouched — a vendor that pays
  // for platform use must still be paid for the work it does.
  if (params.billedTo === "vendor") {
    const platformUse = await assertVendorChargeableForPlatformUse(svc, {
      vendorId: params.vendorId,
      brokerageId: ctx.brokerageId,
    })
    if (!platformUse.chargeable) return { success: false, error: platformUse.reason }
  }

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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const verify = await verifyInvoiceInCallerBrokerage(invoiceId, ctx.brokerageId)
  if (!verify.ok) return { success: false, error: "Forbidden" }

  const svc = createServiceClient()
  // `.select("id")` — same rule as markInvoicePaid below: a zero-row UPDATE resolves
  // with no error, so without counting the rows this returned success for an invoice
  // that is still a draft (moved tenant, or cancelled, between the verify and here).
  const { data: submitted, error } = await svc
    .from("vendor_invoices")
    .update({ status: "submitted" })
    .eq("id", invoiceId)
    .eq("brokerage_id", ctx.brokerageId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!submitted || submitted.length === 0) {
    return { success: false, error: "Nothing was submitted — that invoice is no longer one of your brokerage's invoices." }
  }
  return { success: true, invoiceId }
}

// ---------------------------------------------------------------------------
// markInvoicePaid — brokerage marks an invoice it OWES A VENDOR as paid
// ---------------------------------------------------------------------------

/**
 * WIRED (w4s1) — `app/dashboard/vendors/vendor-bills-panel.tsx` (the "Vendor Bills"
 * card on the brokerage vendor directory).
 *
 * This closes the marketplace's core money loop, which had a live producer and no
 * consumer. `app/actions/multi-persona.ts:submitVendorInvoice` (wired to the
 * dashboard vendor-bookings panel) creates `billed_to='brokerage'` invoices with
 * status 'submitted' — a vendor billing the brokerage for booked work. NOTHING on
 * the platform could then mark one paid, so `vendor_earnings` was never minted from
 * that lane, the vendor earnings page showed nothing, and `initiateVendorPayout`
 * had nothing to pay out. Vendors did work, invoiced for it, and could never be
 * paid through the product.
 *
 * NOT a duplicate of `markVendorChargePaid` — that one explicitly refuses
 * `billed_to !== 'vendor'` (it settles money flowing vendor→brokerage and mints no
 * earnings). This is the opposite direction. It is also not
 * `markClientInvoiceCollected` (billed_to='contact', vendor-collected).
 */
export async function markInvoicePaid(params: {
  invoiceId: string
  paymentMethod?: string
  stripePaymentIntentId?: string
}): Promise<InvoiceResult> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  // ROLE GATE. Asserting a bill is paid MINTS a `vendor_earnings` row with status
  // 'available', which `initiateVendorPayout` wires out over Stripe Connect — this
  // is a spend authorization, not bookkeeping. It was gated on tenancy alone, so any
  // authenticated member of the brokerage could create a payable claim. Matches the
  // sibling money lane `markVendorChargePaid`, minus the 'agent' branch: an agent may
  // settle a charge THEY raised (money coming IN), but authorizing a payment OUT of
  // brokerage funds is leadership's.
  if (!VENDOR_CHARGE_ADMIN_ROLES.has(ctx.userType)) {
    return { success: false, error: "Forbidden: broker, admin, or team lead only" }
  }

  // CRITICAL: verify invoice belongs to caller's brokerage before
  // marking paid + creating vendor_earnings. Without this, any caller
  // could mark any tenant's invoice paid, generate available earnings,
  // and pair it with initiateVendorPayout to wire funds out.
  const verify = await verifyInvoiceInCallerBrokerage(params.invoiceId, ctx.brokerageId)
  if (!verify.ok) return { success: false, error: "Forbidden" }

  // 🐛 NOT IDEMPOTENT — this minted a fresh PAYOUT CLAIM on every call.
  //
  // `status` was already being selected by verifyInvoiceInCallerBrokerage and then
  // never read. It has to be read, because the insert below writes a
  // `vendor_earnings` row with status 'available', `vendor_earnings` has NO unique
  // index on invoice_id (verified live — only the pkey and two non-unique indexes),
  // and `initiateVendorPayout` pays out whatever is 'available'. So calling this
  // twice on one invoice — a double-clicked button, a retried request, or a TC
  // marking paid an invoice the client had already paid online through
  // confirmVendorInvoiceCheckout (which mints its own earnings row via
  // recordDirectCollectionEarnings) — doubled the vendor's payable balance against a
  // single collected invoice. Real money, out the door, on a duplicate row.
  //
  // Two guards, because they catch different paths: the status check catches the
  // repeat of THIS action, and the earnings-existence check catches the
  // cross-path collision with the direct-collection lane, which leaves the invoice
  // 'paid' by a route that never touched this function.
  if (verify.status === "paid") {
    return { success: true, invoiceId: params.invoiceId }
  }
  if (verify.status === "cancelled") {
    return { success: false, error: "Invoice was cancelled" }
  }

  // LANE GUARD. Three billing lanes share this table and each has its OWN
  // settlement action; only the brokerage-billed lane belongs here:
  //   billed_to='brokerage' → this action (brokerage pays the vendor; mints earnings)
  //   billed_to='vendor'    → markVendorChargePaid (vendor pays the brokerage)
  //   billed_to='contact'   → markClientInvoiceCollected / confirmVendorInvoiceCheckout
  //                           (the vendor collects DIRECTLY from the client, and
  //                            recordDirectCollectionEarnings records those earnings
  //                            as already paid_out because the platform never held
  //                            the funds)
  // Without this, a brokerage marking a CONTACT invoice paid would mint an
  // 'available' earning — a payout claim against brokerage funds for money the
  // brokerage never collected and does not owe. The billed_to='vendor' early return
  // further down is kept as the second door on the same rule.
  if (verify.billed_to === "contact") {
    return {
      success: false,
      error: "This invoice is billed to a client — the vendor collects it directly. Use the vendor's invoice center to record collection.",
    }
  }

  const svc = createServiceClient()

  const { data: updated, error: updateErr } = await svc
    .from("vendor_invoices")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      payment_method: params.paymentMethod ?? "manual",
      stripe_payment_intent_id: params.stripePaymentIntentId ?? null,
    })
    .eq("id", params.invoiceId)
    .eq("brokerage_id", ctx.brokerageId)
    .select("id")

  if (updateErr) return { success: false, error: updateErr.message }
  // Zero rows means the invoice moved out from under us between the verify and the
  // write. It must not report a payment it did not record.
  if (!updated?.length) return { success: false, error: "Invoice not found" }

  // A tenant→vendor CHARGE (billed_to='vendor') is money flowing vendor→brokerage —
  // marking it paid must NOT mint vendor earnings (that would offer the vendor a payout
  // of funds they OWED the brokerage).
  if (verify.billed_to === "vendor") {
    return { success: true, invoiceId: params.invoiceId }
  }

  // Never mint a second payout claim for an invoice that already has one.
  // `error` is destructured deliberately: supabase-js resolves a refused read, and
  // treating a refusal as "no earnings yet" here would mint the duplicate this
  // guard exists to prevent. A refused read fails CLOSED — no earnings row.
  const { data: existingEarnings, error: earningsReadErr } = await svc
    .from("vendor_earnings")
    .select("id")
    .eq("invoice_id", params.invoiceId)
    .limit(1)

  if (earningsReadErr) {
    return {
      success: false,
      error: "Invoice marked paid, but the earnings record could not be verified. Please re-check before paying out.",
    }
  }

  if (existingEarnings?.length) {
    return { success: true, invoiceId: params.invoiceId }
  }

  // Create earnings record so the vendor sees the payment. The platform does NOT take a cut of a
  // vendor's client invoice — vendors are billed separately for platform use — so the vendor keeps the
  // full amount (platform_fee 0, net = gross).
  const gross = verify.total_amount ?? 0

  const { error: earningsErr } = await svc.from("vendor_earnings").insert({
    vendor_id: verify.vendor_id,
    brokerage_id: ctx.brokerageId,
    invoice_id: params.invoiceId,
    gross_amount: gross,
    platform_fee: 0,
    net_amount: gross,
    status: "available",
  })

  // The insert result was previously discarded entirely, so a failed earnings write
  // reported a fully successful payment and the vendor was simply never credited.
  if (earningsErr) {
    return {
      success: false,
      error: `Invoice marked paid, but the vendor earnings record failed to save: ${earningsErr.message}`,
    }
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
  // Return to the surface that STARTED onboarding. These used to point at
  // /vendor/settings, which is a bare `redirect('/settings/general')` stub — it
  // drops the query string entirely, so a vendor finishing Stripe's hosted flow
  // landed on an unrelated page and nothing ever reconciled the account. The
  // Connect UI lives on /vendor/earnings (stripe-connect.tsx), and that page now
  // reads ?stripe=complete and calls completeStripeConnectOnboarding().
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${appUrl}/vendor/earnings?stripe=refresh`,
    return_url: `${appUrl}/vendor/earnings?stripe=complete`,
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
}): Promise<{ success: boolean; payoutId?: string; error?: string; w9Warning?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId) {
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

  // ── W-9 SOFT gate (owner round 43): the payout NEVER hard-blocks on a
  // missing W-9 (existing vendors have earned funds mid-flight) — it proceeds
  // and surfaces the honest warning; the governed once-per-period reminder is
  // triggered after the payout lands. Best-effort: a W-9 read failure
  // (pre-migration m275) never touches the money path.
  let w9Warning: string | undefined
  try {
    const { readVendorW9, w9SoftGateWarning } = await import("@/lib/vendors/w9")
    const w9 = await readVendorW9(svc, params.vendorId)
    w9Warning = w9SoftGateWarning(w9.status) ?? undefined
  } catch { /* soft gate stays silent on read failure */ }

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

    // ── THE BROKERAGE'S MONEY LEAVES THE BROKERAGE'S ACCOUNT ─────────────────
    //
    // `vendor_job_bill` (lib/billing/stripe-account-scope.ts): the payer is the
    // BROKERAGE and the payee is the vendor. This used to be
    // `stripe.transfers.create()` on the platform seam, so the funds left the
    // PRODUCT's balance — a payout that succeeded, returned a transfer id and
    // rendered a green badge while paying a vendor the product never hired, out of
    // a balance that owes them nothing, on a 1099 issued by the wrong entity.
    //
    // The scope is the BROKERAGE and deliberately not `ctx.userId` / the caller's
    // team: `vendor_payouts.brokerage_id` and `vendor_earnings.brokerage_id` name
    // the brokerage as the party on the hook, and the rule this repo states once is
    // that the account belongs to the PAYER/PAYEE — never to whoever clicked. An
    // agent-scoped resolution would let WHO PRESSED THE BUTTON pick the balance.
    //
    // Fail-closed: a brokerage with no Stripe credential gets the resolver's
    // sentence back as `error`, which app/vendor/earnings/payout-button.tsx renders
    // verbatim. It never falls through to the platform's account.
    const transfer = await createTransfer(
      {
        amount: params.amount,
        destinationAccountId: connect.accountId,
        description: `Vendor payout — ${params.vendorId}`,
        metadata: { vendorId: params.vendorId, brokerageId: ctx.brokerageId },
      },
      { side: "tenant", brokerageId: ctx.brokerageId },
    )
    if (!transfer.success || !transfer.transferId) {
      // No payout row is written. A `vendor_payouts` row with no transfer would
      // read as a pending payout nobody is going to make, and the earnings it
      // covers would be marked paid_out against money that never moved.
      return { success: false, error: transfer.error ?? "The payout could not be sent.", w9Warning }
    }
    stripeTransferId = transfer.transferId
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

  // THE CHASE: payout activity with no W-9 on file → governed b2b transactional
  // reminder, deduped once per period inside maybeSendVendorW9Reminder.
  // Best-effort — never blocks or fails the payout.
  if (w9Warning) {
    try {
      const { maybeSendVendorW9Reminder } = await import("@/lib/vendors/w9")
      await maybeSendVendorW9Reminder(svc, {
        vendorId: params.vendorId,
        brokerageId: ctx.brokerageId,
        userId: ctx.userId,
        trigger: "payout",
      })
    } catch (err) {
      console.error("[initiateVendorPayout] W-9 reminder failed (non-blocking):", err)
    }
  }

  return { success: true, payoutId: payout.id, w9Warning }
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
    const ctx = await resolveActingContext()
    if (ctx.ok && ctx.brokerageId &&
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
        // cash_app_reference is the manual-payout transaction ref written at
        // payout creation and read by nobody — without it a vendor could not
        // match a "cash_app" payout row to the payment that actually reached them.
        // `note` and `earnings_ids` were the same shape of orphan write: the
        // brokerage's explanation of the payout, and the set of earnings it
        // settled. Both are written by initiateVendorPayout above and neither had
        // a reader, so a vendor saw an amount with no account of what it covered.
        .select("id, amount, payout_method, status, initiated_at, completed_at, cash_app_reference, note, earnings_ids")
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
      cashAppReference: p.cash_app_reference ?? null,
      note: p.note ?? null,
      // The column is a uuid[] with DEFAULT '{}'. A non-array (legacy null) must
      // read as 0 covered earnings, never as a crash on .length.
      coveredEarningsCount: Array.isArray(p.earnings_ids) ? p.earnings_ids.length : 0,
    })),
  }
}

// ---------------------------------------------------------------------------
// completeStripeConnectOnboarding — called from the return URL to mark complete
// ---------------------------------------------------------------------------

/**
 * WIRED (w4s1) — `app/vendor/earnings/page.tsx` calls this when Stripe redirects
 * the vendor back with `?stripe=complete`. It is also the only implementation that
 * can turn `stripe_onboarding_complete` back OFF.
 *
 * Survivor for the "flip the flag on" half: `app/api/billing/webhook/route.ts`,
 * the `account.updated` branch → `lib/connections/vendor-stripe.ts:
 * setStripeOnboardingByAccount`. That path is wired and works, so this is not the
 * only writer and cannot simply be "wired" as the missing one.
 *
 * But it is NOT redundant, because the webhook branch is
 *     if (details_submitted && charges_enabled) setStripeOnboardingByAccount(..., true)
 * — it only ever sets TRUE. This function computes the same boolean and passes it
 * through, so it also DEMOTES. That matters on a money path: when Stripe later
 * restricts a connected account (expired documents, failed verification,
 * `charges_enabled` goes false), the webhook leaves the flag true forever, and
 * `initiateVendorPayout` hard-gates on exactly that flag before calling
 * `stripe.transfers.create()`. So the payout lane keeps transferring to a
 * destination that can no longer receive, on a stale flag.
 *
 * It is also the synchronous confirmation for a vendor returning from Stripe's
 * hosted flow — webhooks are eventually consistent, and Connect events have to be
 * separately enabled on the endpoint for that branch to ever fire.
 *
 * Correctly gated (`requireVendorActor(vendorId)` — the caller must BE this vendor),
 * so the vendorId passed in must be a `vendors.id` (the canonical linkage is
 * `user_role_assignments.vendor_id`; `vendors` has no user_id).
 *
 * DONE (was a handoff): the survivor's promote-only hole is fixed — the webhook's
 * `account.updated` branch now passes the computed boolean instead of gating on it.
 * DONE (was a handoff): `initiateStripeConnectOnboarding` now returns the vendor to
 * `/vendor/earnings?stripe=complete` (it pointed at `/vendor/settings`, a bare
 * `redirect('/settings/general')` stub that drops the query string), and that page
 * calls this on the param.
 */
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
  /** W-9 SOFT gate (round 43): issuance is never blocked, but a missing/expired
   *  W-9 surfaces this honest warning to the vendor. */
  w9Warning?: string
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

  // ── W-9 SOFT gate (owner round 43): invoice issuance is NEVER blocked on a
  // missing W-9 — the invoice went out; the vendor sees the honest warning and
  // the governed once-per-period reminder fires. Best-effort throughout.
  let w9Warning: string | undefined
  try {
    const { readVendorW9, w9SoftGateWarning, maybeSendVendorW9Reminder } = await import("@/lib/vendors/w9")
    const w9 = await readVendorW9(svc, actor.vendorId)
    w9Warning = w9SoftGateWarning(w9.status) ?? undefined
    if (w9Warning) {
      await maybeSendVendorW9Reminder(svc, {
        vendorId: actor.vendorId,
        brokerageId: actor.brokerageId,
        userId: actor.userId,
        trigger: "invoice",
      })
    }
  } catch { /* soft gate never touches the invoice path */ }

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

  return { success: true, invoiceId: invoice.id, emailSent, emailError, w9Warning }
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
// connected account. The BROKERAGE's Stripe account creates the session (it is the
// merchant of record — the name on the hosted page and on the payer's statement);
// funds settle on the VENDOR's Stripe account (transfer_data.destination). 'paid'
// is only recorded after Stripe confirms payment_status='paid' on the session (real
// provider acceptance — never on redirect alone).
//
// It was the PLATFORM's key that created the session until the ruling "no sites
// should move tenant money on the platform key"; see the import header at the top
// of this file for where each half went.
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

  // THE TENANT COMES FROM THE SESSION (CLAUDE.md §4). `gate.contact` is the row
  // verifyContactCaller matched against the SIGNED-IN user; its brokerage_id is the
  // only tenant claim on this request that the caller did not supply. The invoice's
  // own brokerage_id is caller-reachable data, so it is CHECKED against the session's
  // rather than trusted — otherwise the invoice id would be selecting which
  // brokerage's Stripe account collects, which is the IDOR shape this repo keeps
  // finding, pointed at a bank account.
  const sessionBrokerageId = gate.contact.brokerage_id
  if (!sessionBrokerageId || invoice.brokerage_id !== sessionBrokerageId) {
    return { success: false, error: "Invoice not found" }
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

  // ── THE MERCHANT OF RECORD IS THE BROKERAGE, NOT THE PRODUCT ──────────────
  //
  // `client_payment` (lib/billing/stripe-account-scope.ts): a contact pays; the
  // brokerage collects. This used to be `stripe.checkout.sessions.create()` on the
  // platform seam, which made the PRODUCT the merchant on a sale it had no part in
  // — Stripe's hosted page carries the account's business name and support email,
  // and the buyer's card statement carries its descriptor, so the wrong merchant was
  // not a bookkeeping detail here but the thing the payer actually read. The refund
  // would have come out of the product's balance too.
  //
  // The DESTINATION CHARGE is unchanged in intent — funds still settle on the
  // VENDOR's connected account — but it is now made FROM the brokerage's account, so
  // the two sides of the charge finally name the same tenant. `createCheckoutSession`
  // refuses, with a sentence, when those two cannot address each other.
  const checkout = await createCheckoutSession(
    {
      amount: Number(invoice.total_amount ?? 0),
      currency: "usd",
      productName: `Invoice ${invoiceLabel} — ${vendorName}`,
      destinationAccountId: connect.accountId,
      customerEmail: gate.contact.email ?? undefined,
      metadata: { vendor_invoice_id: invoice.id, contact_id: params.contactId },
      paymentIntentMetadata: {
        vendor_invoice_id: invoice.id,
        vendor_id: invoice.vendor_id,
        brokerage_id: sessionBrokerageId,
      },
      successUrl: `${appUrl}/portal/${params.contactId}/invoices?checkout=success&invoice=${invoice.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}/portal/${params.contactId}/invoices?checkout=cancelled&invoice=${invoice.id}`,
    },
    { side: "tenant", brokerageId: sessionBrokerageId },
  )
  if (!checkout.success || !checkout.url) {
    return { success: false, error: checkout.error ?? "Could not start checkout" }
  }
  return { success: true, url: checkout.url }
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

  // Same session-derived tenant as startVendorInvoiceCheckout, and checked the same
  // way — the session lives on the BROKERAGE's Stripe account, so this read has to
  // be made on that same account or Stripe answers "no such checkout session" and a
  // genuinely paid invoice never settles.
  const sessionBrokerageId = gate.contact.brokerage_id
  if (!sessionBrokerageId || invoice.brokerage_id !== sessionBrokerageId) {
    return { success: false, error: "Invoice not found" }
  }

  // REAL provider acceptance: retrieve the session and require payment_status='paid'
  // for THIS invoice. A redirect with an unpaid/foreign session changes nothing.
  const session = await retrieveCheckoutSession(params.sessionId, {
    side: "tenant",
    brokerageId: sessionBrokerageId,
  })
  if (!session.success) {
    return { success: false, error: session.error ?? "The payment could not be verified with Stripe." }
  }
  if (session.metadata?.vendor_invoice_id !== params.invoiceId) {
    return { success: false, error: "Checkout session does not match this invoice" }
  }
  if (session.paymentStatus !== "paid") {
    return { success: false, error: "Payment not completed" }
  }

  const paymentIntentId = session.paymentIntentId

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
//
// ROUND 37 — "agents and teams can charge THEIR vendors": the SAME lane now
// serves three scopes (no forked tables, no second ledger):
//   · broker/admin/team_lead — charge ANY vendor in the brokerage (unchanged);
//   · agent — charge only vendors ATTRIBUTED to them (vendors.invited_by_user_id
//     = them, or invited_by_team_id = their team — migration 1106);
//   · every charge carries a zero-amount typed `charge_attribution` entry in
//     line_items (the premium-placement typed-line-item idiom — vendor_invoices
//     has no metadata column) recording {scope, user_id, team_id}. Totals are
//     untouched; brokerage admins see agent/team-raised charges in the same
//     brokerage-wide query (billed_to='vendor') they always used.
// ═══════════════════════════════════════════════════════════════════════════

import {
  VENDOR_CHARGE_ADMIN_ROLES,
  buildChargeAttribution,
  findChargeAttribution,
  agentMayChargeVendor,
  canManageVendorCharge,
  resolveVendorActorScope,
} from "@/lib/vendors/vendor-scope"

/**
 * issueVendorCharge — the tenant bills a vendor (billed_to='vendor', status
 * 'submitted' = issued & awaiting payment). Collection is off-platform
 * (check / ACH / an externally-sent Stripe invoice) exactly like premium
 * placement; markVendorChargePaid below is the tenant's assertion of collection.
 * Requires migration 1104 (billed_to CHECK includes 'vendor') — a pre-migration
 * attempt fails with an honest migration message, never a silent fallback.
 * Agent callers additionally require migration 1106 (vendor attribution).
 */
export async function issueVendorCharge(params: {
  vendorId: string
  lineItems: InvoiceLineItem[]
  dueDate?: string
  notes?: string
}): Promise<{ success: boolean; invoiceId?: string; invoiceNumber?: string; error?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  const isAdminCharger = VENDOR_CHARGE_ADMIN_ROLES.has(ctx.userType)
  if (!isAdminCharger && ctx.userType !== "agent") {
    return { success: false, error: "Forbidden: broker, admin, team lead, or agent only" }
  }
  if (!await verifyVendorInCallerBrokerage(params.vendorId, ctx.brokerageId)) {
    return { success: false, error: "Forbidden: vendor not in your brokerage" }
  }

  const svcScope = createServiceClient()
  const actorScope = await resolveVendorActorScope(svcScope, {
    userId: ctx.userId,
    userType: ctx.userType,
    brokerageId: ctx.brokerageId,
  })

  // AGENT gate — "THEIR vendors" only: the vendor must be attributed to the
  // caller (their invite) or to their team (migration 1106 columns).
  if (!isAdminCharger) {
    const { data: vRow, error: vErr } = await svcScope
      .from("vendors")
      .select("invited_by_user_id, invited_by_team_id")
      .eq("id", params.vendorId)
      .maybeSingle()
    if (vErr) {
      return /invited_by/i.test(vErr.message)
        ? { success: false, error: "Charging your own vendors requires database migration 1106 (vendors.invited_by_user_id / invited_by_team_id) — ask your administrator to apply it." }
        : { success: false, error: vErr.message }
    }
    const mine = agentMayChargeVendor(
      {
        invitedByUserId: (vRow?.invited_by_user_id as string | null) ?? null,
        invitedByTeamId: (vRow?.invited_by_team_id as string | null) ?? null,
      },
      { userId: ctx.userId, teamId: actorScope.teamId },
    )
    if (!mine) {
      return { success: false, error: "Forbidden: you can only charge vendors you (or your team) brought to the platform — ask your broker to charge this vendor." }
    }
  }

  const invoiceNumber = `VC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  const created = await createVendorInvoice({
    vendorId: params.vendorId,
    billedTo: "vendor",
    invoiceNumber,
    dueDate: params.dueDate,
    lineItems: [
      ...params.lineItems,
      // Zero-amount attribution entry — records which scope raised the charge
      // without touching totals (subtotal = Σ amount; this adds 0).
      buildChargeAttribution({
        scope: actorScope.scope,
        userId: ctx.userId,
        teamId: actorScope.teamId,
      }) as unknown as InvoiceLineItem,
    ],
    notes: params.notes,
  })
  if (!created.success || !created.invoiceId) return { success: false, error: created.error }

  // createVendorInvoice writes 'draft' — issue it (same transition submitVendorInvoice makes).
  //
  // `.select("id")` and the zero-row check are load-bearing: a supabase-js UPDATE
  // that matches nothing resolves with `error` null (CLAUDE.md §3), so without them
  // this reported {success:true} AND SENT THE VENDOR AN EMAIL saying an invoice had
  // been issued, while the row sat at 'draft' — a bill announced to the payer that
  // the ledger says was never raised. Charging nobody, loudly.
  const svc = createServiceClient()
  const { data: issued, error: issueErr } = await svc
    .from("vendor_invoices")
    .update({ status: "submitted" })
    .eq("id", created.invoiceId)
    .eq("brokerage_id", ctx.brokerageId)
    .select("id")
  if (issueErr) return { success: false, error: issueErr.message }
  if (!issued || issued.length === 0) {
    return { success: false, error: "The charge was drafted but could not be issued — it is still a draft, and the vendor has not been notified." }
  }

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
 * Callers: brokerage leadership for ANY charge; an AGENT only for a charge THEY
 * raised (line-item attribution user_id match — one agent can never assert
 * collection of another scope's charge).
 */
export async function markVendorChargePaid(params: {
  invoiceId: string
  paymentMethod?: string
}): Promise<InvoiceResult> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!VENDOR_CHARGE_ADMIN_ROLES.has(ctx.userType) && ctx.userType !== "agent") {
    return { success: false, error: "Forbidden: broker, admin, team lead, or agent only" }
  }

  const verify = await verifyInvoiceInCallerBrokerage(params.invoiceId, ctx.brokerageId)
  if (!verify.ok) return { success: false, error: "Forbidden" }
  if (verify.billed_to !== "vendor") return { success: false, error: "Not a vendor charge" }
  if (verify.status === "paid") return { success: false, error: "Invoice already marked paid" }
  if (verify.status === "cancelled") return { success: false, error: "Invoice was cancelled" }

  const svc = createServiceClient()

  // Agent callers: only the raiser of the charge may assert its collection.
  if (!VENDOR_CHARGE_ADMIN_ROLES.has(ctx.userType)) {
    const { data: invRow } = await svc
      .from("vendor_invoices")
      .select("line_items")
      .eq("id", params.invoiceId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    const allowed = canManageVendorCharge({
      userType: ctx.userType,
      callerUserId: ctx.userId,
      attribution: findChargeAttribution(invRow?.line_items),
    })
    if (!allowed) {
      return { success: false, error: "Forbidden: only the agent who raised this charge (or brokerage leadership) can mark it paid" }
    }
  }
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
