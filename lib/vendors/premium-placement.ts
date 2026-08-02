// lib/vendors/premium-placement.ts
//
// PREMIUM PLACEMENT — the monetization connector between the two existing halves:
//   • vendor_directory.{preferred, display_priority, visible_in_portal} — the
//     placement flags surfaced on the Vendors page "Preferred" tab / contact portal.
//   • vendor_invoices — the existing billing ledger (migration 1000).
//
// A brokerage (the subscriber) charges a vendor for featured placement in its
// curated directory: offer → invoice (status 'submitted', awaiting payment) →
// mark paid → directory row flipped preferred + display_priority → nightly
// expiry sweep un-features rows whose paid term lapsed.
//
// HONESTY NOTE (v1): payment collection itself is manual — the brokerage
// collects by check / ACH / an externally-sent Stripe invoice. markPlacementPaid
// is the tenant's assertion that funds were actually collected; nothing here
// simulates or fakes a Stripe payment success. Stripe-native collection can be
// layered on later via vendor_invoices.stripe_invoice_id.
//
// Ledger vocabulary (verified against scripts/1000-vendor-invoices-earnings-
// stripe-connect.sql and the writers in app/actions/vendor-payments.ts):
//   status CHECK IN ('draft','submitted','viewed','paid','overdue','cancelled','disputed')
//   — there is NO 'pending' literal; 'submitted' (issued, awaiting payment) is
//   the awaiting-payment state, mirroring submitVendorInvoice(). Amount columns
//   are NUMERIC(10,2) DOLLARS (existing writers store dollars); the line item
//   keeps the exact price_cents as given.
//
// No new tables. Every query is anchored on brokerage_id (tenant anchor).

import { createServiceClient } from "@/lib/supabase/service"

// Priority a paid placement pins the row at (floats to the top of the
// idx_vendor_directory_visible ordering; manual curation default is 0).
const PLACEMENT_DISPLAY_PRIORITY = 10

const PLACEMENT_DUE_DAYS = 14

export interface PremiumPlacementLineItem {
  type: "premium_placement"
  description: string
  months: number
  price_cents: number
  directory_id: string
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

/**
 * Resolve — creating if needed — the CURATION row for a bench vendor.
 *
 * THE MISSING ENTRY POINT. Everything downstream of this function worked: offer
 * → invoice → mark paid → flip {preferred, display_priority, visible_in_portal}
 * → nightly expiry sweep. An earlier pass repointed the READERS back onto
 * vendor_directory and restored that chain. What nobody noticed is that no code
 * path anywhere in the repo ever INSERTS a vendor_directory row — the only SQL
 * that ever wrote one was a one-time backfill UPDATE in m303. Live count: 0.
 *
 * So offerPremiumPlacement needed a vendorDirectoryId the product could not
 * mint, the panel's `directoryEntries.length === 0 && placementInvoices.length
 * === 0 → return null` early-return meant the monetization card NEVER rendered,
 * and resolve-contact-vendors always fell through to its uncurated `vendors`
 * fallback — which is why audience/stage targeting and visible_in_portal did
 * nothing and every portal contact saw every approved vendor.
 *
 * TWO TABLES, TWO JOBS — this is not a duplicate to consolidate away. `vendors`
 * is the operational bench (bookings, assignments, verification, access level);
 * `vendor_directory` is the curated, sellable listing (preferred, priority,
 * portal visibility, audience/stage tags). m303 gave the second a real FK to
 * the first. This function is the bridge that was specified and never built.
 *
 * IDENTITY: vendorId is a `vendors.id` — the FK target of
 * vendor_directory.vendor_id. The returned id is a `vendor_directory.id`, which
 * is what the placement line item and the invoice's vendor_id anchor on.
 *
 * SELECT-THEN-INSERT, deliberately, not upsert: the uniqueness guarantee is a
 * PARTIAL index (ux_vendor_directory_brokerage_vendor ... WHERE vendor_id IS
 * NOT NULL), and PostgREST's on_conflict cannot infer a partial index without
 * emitting its predicate. An upsert here would fail at runtime, not compile.
 */
export async function ensureDirectoryEntryForVendor(input: {
  brokerageId: string
  /** A vendors.id — never a vendor_directory.id. */
  vendorId: string
}): Promise<
  | { directoryId: string; created: boolean; error: null }
  | { directoryId: null; created: false; error: string }
> {
  const { brokerageId, vendorId } = input
  if (!brokerageId || !vendorId) {
    return { directoryId: null, created: false, error: "Missing brokerage or vendor" }
  }

  const supabase = createServiceClient()

  const { data: existing, error: findError } = await supabase
    .from("vendor_directory")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("vendor_id", vendorId)
    .maybeSingle()

  if (findError) return { directoryId: null, created: false, error: findError.message }
  if (existing) return { directoryId: existing.id as string, created: false, error: null }

  // The bench row is the source of identity; the directory row adds curation.
  // Tenant-anchored, so a vendor id from another brokerage resolves to nothing.
  const { data: bench, error: benchError } = await supabase
    .from("vendors")
    .select("id, name, category, phone, email, website, rating")
    .eq("id", vendorId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (benchError) return { directoryId: null, created: false, error: benchError.message }
  if (!bench) return { directoryId: null, created: false, error: "Vendor not found in your brokerage" }

  const { data: created, error: insertError } = await supabase
    .from("vendor_directory")
    .insert({
      brokerage_id: brokerageId,
      vendor_id: bench.id,
      name: bench.name,
      // vendor_directory.category is NOT NULL while vendors.category is
      // nullable. Both carry the SAME 38-value CHECK (verified live), so the
      // value copies across unchanged; 'other' is the vocabulary's own escape
      // hatch for a bench row that never got one.
      category: bench.category ?? "other",
      phone: bench.phone,
      email: bench.email,
      website: bench.website,
      rating: bench.rating,
      // Curated, NOT yet sold. preferred/display_priority are the PAID flags and
      // only markPlacementPaid may set them — curating a vendor must never look
      // like a vendor who paid, or the Preferred tab stops meaning anything.
      preferred: false,
      display_priority: 0,
      visible_in_portal: true,
    })
    .select("id")
    .single()

  if (insertError || !created) {
    return { directoryId: null, created: false, error: insertError?.message ?? "Could not curate this vendor" }
  }

  return { directoryId: created.id as string, created: true, error: null }
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
      typeof li.directory_id === "string"
  )
  return (item as PremiumPlacementLineItem) ?? null
}

// ---------------------------------------------------------------------------
// offerPremiumPlacement — draft the charge (invoice awaiting payment)
// ---------------------------------------------------------------------------

export async function offerPremiumPlacement(input: {
  brokerageId: string
  vendorDirectoryId: string
  months: number
  priceCents: number
  notes?: string
}): Promise<
  | { invoiceId: string; invoiceNumber: string; error: null }
  | { invoiceId: null; invoiceNumber: null; error: string }
> {
  const { brokerageId, vendorDirectoryId, notes } = input
  const months = Math.floor(input.months)
  const priceCents = Math.round(input.priceCents)

  if (!brokerageId || !vendorDirectoryId) {
    return { invoiceId: null, invoiceNumber: null, error: "Missing brokerage or directory entry" }
  }
  if (!Number.isFinite(months) || months < 1 || months > 60) {
    return { invoiceId: null, invoiceNumber: null, error: "Months must be between 1 and 60" }
  }
  if (!Number.isFinite(priceCents) || priceCents < 1) {
    return { invoiceId: null, invoiceNumber: null, error: "Price must be greater than zero" }
  }

  const supabase = createServiceClient()

  // Tenant anchor: the directory row must belong to the caller's brokerage.
  const { data: dirRow, error: dirError } = await supabase
    .from("vendor_directory")
    .select("id, name, brokerage_id")
    .eq("id", vendorDirectoryId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (dirError) {
    return { invoiceId: null, invoiceNumber: null, error: dirError.message }
  }
  if (!dirRow) {
    return { invoiceId: null, invoiceNumber: null, error: "Directory entry not found in your brokerage" }
  }

  const amount = parseFloat((priceCents / 100).toFixed(2)) // ledger stores dollars
  const invoiceNumber = generatePlacementInvoiceNumber()
  const dueDate = new Date(Date.now() + PLACEMENT_DUE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  const lineItem: PremiumPlacementLineItem = {
    type: "premium_placement",
    description: `Premium placement — ${dirRow.name ?? "vendor"} (${months} month${months === 1 ? "" : "s"})`,
    months,
    price_cents: priceCents,
    directory_id: vendorDirectoryId,
  }

  // vendor_id has no FK (migration 1000); for a placement charge the billed
  // party IS the directory row, so its id is the vendor anchor. billed_to's
  // CHECK vocabulary ('brokerage'|'contact') has no vendor recipient — the
  // charge direction lives in the line item type, so the column default stands.
  const { data: invoice, error: invError } = await supabase
    .from("vendor_invoices")
    .insert({
      brokerage_id: brokerageId,
      vendor_id: vendorDirectoryId,
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

  // Tenant anchor on the flip target too — the directory row referenced by the
  // line item must still exist in this brokerage.
  const { data: dirRow, error: dirError } = await supabase
    .from("vendor_directory")
    .select("id, brokerage_id")
    .eq("id", placementItem.directory_id)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (dirError) return { invoiceId: null, placementUntil: null, error: dirError.message }
  if (!dirRow) {
    return { invoiceId: null, placementUntil: null, error: "Directory entry for this placement no longer exists in your brokerage" }
  }

  const paidAt = new Date()
  const placementUntil = new Date(paidAt)
  placementUntil.setMonth(placementUntil.getMonth() + (placementItem.months || 1))

  // Record the paid state + the placement term on the line item.
  // This is the tenant's assertion of collection (check / ACH / external
  // Stripe invoice) — no payment is simulated here.
  const updatedItems = (invoice.line_items as any[]).map((li: any) =>
    li === placementItem || (li?.type === "premium_placement" && li?.directory_id === placementItem.directory_id)
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
    .from("vendor_directory")
    .update({
      preferred: true,
      display_priority: PLACEMENT_DISPLAY_PRIORITY,
      visible_in_portal: true,
    })
    .eq("id", placementItem.directory_id)
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

  const { data: preferredRows, error: dirError } = await supabase
    .from("vendor_directory")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("preferred", true)

  if (dirError) return { expired: 0, error: dirError.message }
  if (!preferredRows || preferredRows.length === 0) return { expired: 0, error: null }

  // All PAID placement invoices for this brokerage, newest payment first —
  // the LATEST paid invoice per directory row decides the current term
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

  // directory_id → latest paid placement term (first hit wins: sorted desc).
  const latestTermByDirectory = new Map<string, string | undefined>()
  for (const inv of paidInvoices ?? []) {
    const item = findPlacementItem(inv.line_items)
    if (!item) continue
    if (!latestTermByDirectory.has(item.directory_id)) {
      latestTermByDirectory.set(item.directory_id, item.placement_until)
    }
  }

  const now = Date.now()
  let expired = 0

  for (const row of preferredRows) {
    // Rows with NO placement billing history are manually curated preferred
    // vendors — the sweep never touches those.
    if (!latestTermByDirectory.has(row.id)) continue
    const until = latestTermByDirectory.get(row.id)
    // Term not recorded (paid before this feature landed) → can't judge lapse.
    if (!until) continue
    if (new Date(until).getTime() >= now) continue

    const { error: resetError } = await supabase
      .from("vendor_directory")
      .update({ preferred: false, display_priority: 0 })
      .eq("id", row.id)
      .eq("brokerage_id", brokerageId)

    if (resetError) return { expired, error: resetError.message }
    expired++
  }

  return { expired, error: null }
}
