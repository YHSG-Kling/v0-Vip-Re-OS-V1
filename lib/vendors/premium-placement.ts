// lib/vendors/premium-placement.ts
//
// PREMIUM PLACEMENT — the monetization connector between two existing halves:
//   • vendors.{preferred, display_priority, visible_in_portal} — the placement
//     flags surfaced on the Vendors page "Preferred" tab / contact portal.
//   • vendor_invoices — the existing billing ledger (migration 1000).
//
// A brokerage (the subscriber) charges a vendor for featured placement in its
// directory: offer → invoice (status 'submitted', awaiting payment) → mark paid
// → vendor row flipped preferred + display_priority → nightly expiry sweep
// un-features rows whose paid term lapsed.
//
// ONE VENDOR SYSTEM (m355). There used to be two tables here: `vendors` (the
// operational bench) and `vendor_directory` (the curated, sellable listing).
// This module was the bridge between them, and the bridge was the drift: it had
// to mint a second row per vendor and keep the two reconciled, and the invoice
// it wrote anchored on the DIRECTORY id while every other vendor_invoices writer
// anchored on the BENCH id. m355 folded the six curation columns onto `vendors`
// and dropped vendor_directory. There is one row per vendor and one id.
//
// GLOBAL VENDORS CANNOT BE SOLD PLACEMENT. vendors.brokerage_id is nullable;
// a global row is visible to every tenant, so a placement flag on it would be
// one tenant's purchase changing what every other tenant's clients see. The
// brokerage_id equality filters below exclude them, and m355's
// vendors_global_not_curated CHECK makes it unrepresentable at the storage layer
// as well.
//
// HONESTY NOTE (v1): payment collection itself is manual — the brokerage
// collects by check / ACH / an externally-sent Stripe invoice. markPlacementPaid
// is the tenant's assertion that funds were actually collected; nothing here
// simulates or fakes a Stripe payment success. Stripe-native collection can be
// layered on later via vendor_invoices.stripe_invoice_id.
//
// Ledger vocabulary (verified live):
//   status CHECK IN ('draft','submitted','viewed','paid','overdue','cancelled','disputed')
//   — there is NO 'pending' literal; 'submitted' (issued, awaiting payment) is
//   the awaiting-payment state, mirroring submitVendorInvoice(). Amount columns
//   are NUMERIC(10,2) DOLLARS (existing writers store dollars); the line item
//   keeps the exact price_cents as given.
//   billed_to CHECK IN ('brokerage','contact','vendor') — a placement charge
//   bills the VENDOR, and saying so is load-bearing, not cosmetic. See the note
//   at the insert.
//
// No new tables. Every query is anchored on brokerage_id (tenant anchor).

import { createServiceClient } from "@/lib/supabase/service"

// Priority a paid placement pins the row at (floats to the top of the
// idx_vendors_portal ordering; manual curation default is 0).
const PLACEMENT_DISPLAY_PRIORITY = 10

const PLACEMENT_DUE_DAYS = 14

export interface PremiumPlacementLineItem {
  type: "premium_placement"
  description: string
  months: number
  price_cents: number
  /** A vendors.id. Was `directory_id` before m355 collapsed the two tables. */
  vendor_id: string
  /** Set when the invoice is marked paid: paid_at + months (ISO timestamp). */
  placement_until?: string
}

// No shared invoice-number generator exists in this codebase (both existing
// vendor_invoices writers take a caller-supplied number or leave it null, and
// vendor-documents.ts falls back to INV-<id prefix> for display) — so premium
// placement uses its own PP-<timestamp36> scheme, with a short random suffix
// for same-millisecond collision safety.
function generatePlacementInvoiceNumber(): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `PP-${ts}-${rand}`
}

function findPlacementItem(
  lineItems: unknown
): PremiumPlacementLineItem | null {
  if (!Array.isArray(lineItems)) return null
  const item = lineItems.find(
    (li: any) =>
      li &&
      typeof li === "object" &&
      li.type === "premium_placement" &&
      typeof li.vendor_id === "string"
  )
  return (item as PremiumPlacementLineItem) ?? null
}

// ---------------------------------------------------------------------------
// offerPremiumPlacement — draft the charge (invoice awaiting payment)
// ---------------------------------------------------------------------------

export async function offerPremiumPlacement(input: {
  brokerageId: string
  /** A vendors.id. Was vendorDirectoryId before m355 collapsed the two tables. */
  vendorId: string
  months: number
  priceCents: number
  notes?: string
}): Promise<
  | { invoiceId: string; invoiceNumber: string; error: null }
  | { invoiceId: null; invoiceNumber: null; error: string }
> {
  const { brokerageId, vendorId, notes } = input
  const months = Math.floor(input.months)
  const priceCents = Math.round(input.priceCents)

  if (!brokerageId || !vendorId) {
    return { invoiceId: null, invoiceNumber: null, error: "Missing brokerage or vendor" }
  }
  if (!Number.isFinite(months) || months < 1 || months > 60) {
    return { invoiceId: null, invoiceNumber: null, error: "Months must be between 1 and 60" }
  }
  if (!Number.isFinite(priceCents) || priceCents < 1) {
    return { invoiceId: null, invoiceNumber: null, error: "Price must be greater than zero" }
  }

  const supabase = createServiceClient()

  // Tenant anchor: the vendor must belong to the caller's brokerage. The
  // equality (rather than `is null or eq`) also excludes GLOBAL vendors, which
  // is deliberate — see the header. A global vendor genuinely cannot be sold
  // placement, and refusing here with an honest error beats writing an invoice
  // for a flag that could never legally be set.
  const { data: vendorRow, error: vendorError } = await supabase
    .from("vendors")
    .select("id, name, brokerage_id")
    .eq("id", vendorId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (vendorError) {
    return { invoiceId: null, invoiceNumber: null, error: vendorError.message }
  }
  if (!vendorRow) {
    return { invoiceId: null, invoiceNumber: null, error: "Vendor not found in your brokerage" }
  }

  const amount = parseFloat((priceCents / 100).toFixed(2)) // ledger stores dollars
  const invoiceNumber = generatePlacementInvoiceNumber()
  const dueDate = new Date(Date.now() + PLACEMENT_DUE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  const lineItem: PremiumPlacementLineItem = {
    type: "premium_placement",
    description: `Premium placement — ${vendorRow.name ?? "vendor"} (${months} month${months === 1 ? "" : "s"})`,
    months,
    price_cents: priceCents,
    vendor_id: vendorId,
  }

  // IDENTITY. vendor_id is a vendors.id, matching every other vendor_invoices
  // writer. It used to be a vendor_directory.id, and that single line was why
  //   · the vendor charged for placement could not see the invoice in their own
  //     portal (that page filters on a vendors.id),
  //   · placement revenue silently dropped out of the superadmin console's
  //     per-tenant billed totals (the join never matched),
  //   · readVendorStripeConnect resolved nothing and the Stripe line item said
  //     the literal "Vendor".
  // m355 remapped the historical rows and added the FK that makes it impossible.
  //
  // billed_to: 'vendor' is load-bearing, not decoration. markInvoicePaid mints a
  // vendor_earnings row — a PAYOUT CLAIM against the brokerage — for any invoice
  // whose billed_to is NOT 'vendor'. Money here flows vendor → brokerage, the
  // exact opposite. Leaving the column at its 'brokerage' default meant every
  // placement invoice marked paid would have credited the vendor with money they
  // owed us. 'vendor' is in the live CHECK; nothing is widened.
  const { data: invoice, error: invError } = await supabase
    .from("vendor_invoices")
    .insert({
      brokerage_id: brokerageId,
      vendor_id: vendorId,
      billed_to: "vendor",
      invoice_number: invoiceNumber,
      invoice_date: new Date().toISOString().slice(0, 10),
      due_date: dueDate,
      line_items: [lineItem],
      subtotal: amount,
      tax_rate: 0,
      tax_amount: 0,
      total_amount: amount,
      // 'submitted' = issued & awaiting payment. The table CHECK has no
      // 'pending' literal — see vocabulary note in the file header.
      status: "submitted",
      notes: notes ?? null,
    })
    .select("id, invoice_number")
    .single()

  if (invError || !invoice) {
    return { invoiceId: null, invoiceNumber: null, error: invError?.message ?? "Failed to create placement invoice" }
  }

  return { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, error: null }
}

// ---------------------------------------------------------------------------
// markPlacementPaid — tenant asserts funds collected → feature the vendor
// ---------------------------------------------------------------------------

export async function markPlacementPaid(input: {
  brokerageId: string
  invoiceId: string
  paymentMethod: string
}): Promise<
  | { invoiceId: string; placementUntil: string; error: null }
  | { invoiceId: null; placementUntil: null; error: string }
> {
  const { brokerageId, invoiceId, paymentMethod } = input
  if (!brokerageId || !invoiceId) {
    return { invoiceId: null, placementUntil: null, error: "Missing brokerage or invoice" }
  }

  const supabase = createServiceClient()

  // Tenant anchor: invoice must belong to the caller's brokerage.
  const { data: invoice, error: invError } = await supabase
    .from("vendor_invoices")
    .select("id, brokerage_id, status, line_items")
    .eq("id", invoiceId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (invError) return { invoiceId: null, placementUntil: null, error: invError.message }
  if (!invoice) return { invoiceId: null, placementUntil: null, error: "Invoice not found in your brokerage" }

  const placementItem = findPlacementItem(invoice.line_items)
  if (!placementItem) {
    return { invoiceId: null, placementUntil: null, error: "Not a premium placement invoice" }
  }
  if (invoice.status === "paid") {
    return { invoiceId: null, placementUntil: null, error: "Invoice already marked paid" }
  }
  if (invoice.status === "cancelled") {
    return { invoiceId: null, placementUntil: null, error: "Invoice was cancelled" }
  }

  // Tenant anchor on the flip target too — the vendor referenced by the line
  // item must still exist in this brokerage.
  const { data: vendorRow, error: vendorError } = await supabase
    .from("vendors")
    .select("id, brokerage_id")
    .eq("id", placementItem.vendor_id)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (vendorError) return { invoiceId: null, placementUntil: null, error: vendorError.message }
  if (!vendorRow) {
    return { invoiceId: null, placementUntil: null, error: "The vendor for this placement no longer exists in your brokerage" }
  }

  const paidAt = new Date()
  const placementUntil = new Date(paidAt)
  placementUntil.setMonth(placementUntil.getMonth() + (placementItem.months || 1))

  // Record the paid state + the placement term on the line item.
  // This is the tenant's assertion of collection (check / ACH / external
  // Stripe invoice) — no payment is simulated here.
  const updatedItems = (invoice.line_items as any[]).map((li: any) =>
    li === placementItem || (li?.type === "premium_placement" && li?.vendor_id === placementItem.vendor_id)
      ? { ...li, placement_until: placementUntil.toISOString() }
      : li
  )

  const { error: payError } = await supabase
    .from("vendor_invoices")
    .update({
      status: "paid",
      paid_at: paidAt.toISOString(),
      payment_method: paymentMethod || "manual",
      line_items: updatedItems,
    })
    .eq("id", invoiceId)
    .eq("brokerage_id", brokerageId)
    .neq("status", "paid") // cheap double-mark guard

  if (payError) return { invoiceId: null, placementUntil: null, error: payError.message }

  // THEN flip the placement flags — the paid ledger row is the source of truth
  // the expiry sweep reads, so it must land first.
  const { error: flipError } = await supabase
    .from("vendors")
    .update({
      preferred: true,
      display_priority: PLACEMENT_DISPLAY_PRIORITY,
      visible_in_portal: true,
    })
    .eq("id", placementItem.vendor_id)
    .eq("brokerage_id", brokerageId)

  if (flipError) {
    // Invoice IS paid (money collected) — surface the flip failure so the
    // tenant retries; never roll back a recorded payment.
    return {
      invoiceId: null,
      placementUntil: null,
      error: `Invoice marked paid but featuring failed (retry): ${flipError.message}`,
    }
  }

  return { invoiceId, placementUntil: placementUntil.toISOString(), error: null }
}

// ---------------------------------------------------------------------------
// expirePlacements — nightly sweep: un-feature rows whose paid term lapsed
// ---------------------------------------------------------------------------

export async function expirePlacements(input: {
  brokerageId: string
}): Promise<{ expired: number; error: string | null }> {
  const { brokerageId } = input
  if (!brokerageId) return { expired: 0, error: "Missing brokerage" }

  const supabase = createServiceClient()

  const { data: preferredRows, error: benchError } = await supabase
    .from("vendors")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("preferred", true)

  if (benchError) return { expired: 0, error: benchError.message }
  if (!preferredRows || preferredRows.length === 0) return { expired: 0, error: null }

  // All PAID placement invoices for this brokerage, newest payment first —
  // the LATEST paid invoice per vendor decides the current term
  // (a renewal supersedes the original invoice's window).
  const { data: paidInvoices, error: invError } = await supabase
    .from("vendor_invoices")
    .select("id, paid_at, line_items")
    .eq("brokerage_id", brokerageId)
    .eq("status", "paid")
    // JSON-string form: jsonb @> containment (an array arg would be formatted
    // as a Postgres array literal by postgrest-js).
    .contains("line_items", JSON.stringify([{ type: "premium_placement" }]))
    .order("paid_at", { ascending: false })

  if (invError) return { expired: 0, error: invError.message }

  // vendor_id → latest paid placement term (first hit wins: sorted desc).
  const latestTermByVendor = new Map<string, string | undefined>()
  for (const inv of paidInvoices ?? []) {
    const item = findPlacementItem(inv.line_items)
    if (!item) continue
    if (!latestTermByVendor.has(item.vendor_id)) {
      latestTermByVendor.set(item.vendor_id, item.placement_until)
    }
  }

  const now = Date.now()
  let expired = 0

  for (const row of preferredRows) {
    // Rows with NO placement billing history are manually curated preferred
    // vendors — the sweep never touches those.
    if (!latestTermByVendor.has(row.id)) continue
    const until = latestTermByVendor.get(row.id)
    // Term not recorded (paid before this feature landed) → can't judge lapse.
    if (!until) continue
    if (new Date(until).getTime() >= now) continue

    const { error: resetError } = await supabase
      .from("vendors")
      .update({ preferred: false, display_priority: 0 })
      .eq("id", row.id)
      .eq("brokerage_id", brokerageId)

    if (resetError) return { expired, error: resetError.message }
    expired++
  }

  return { expired, error: null }
}
