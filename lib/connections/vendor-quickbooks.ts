// lib/connections/vendor-quickbooks.ts
// Single source of truth for a VENDOR's QuickBooks Online connection, on the unified
// owner model — the exact sibling of lib/connections/vendor-stripe.ts.
//
// REFACTORED (round 36) onto the shared scope-aware accounting layer
// (lib/connections/accounting-scopes.ts): credential load, token refresh, the QBO
// egress choke point, and find-or-create-customer are the SAME helpers every scope
// (platform/brokerage/team/agent/vendor) uses — this module keeps only the
// vendor-invoice semantics on top of them.
//
// A vendor's QBO connection lives in platform_credentials keyed by
// (owner_type="vendor", owner_id=<vendor id>, platform="quickbooks"). The row is written
// by the EXISTING /api/integrations/oauth/quickbooks route: its initiate step resolves the
// connecting user's owner scope via connectionScopeForUserType() (vendor/lender/title/… →
// scope "vendor", ownerId = user_role_assignments.vendor_id) and its callback stores the
// tokens owner-scoped with account_id = the Intuit realmId. No new OAuth plumbing is
// needed — this lib only READS that row and performs vendor-book writes against it.
//
// HONESTY CONTRACT: pushVendorInvoiceToQuickBooks returns { attempted:false } when the
// vendor has no QBO connection — callers render "Not synced" and never fake a sync.
// Every Intuit call is a real production endpoint through the connector-gateway
// (mirroring lib/providers/accounting/quickbooks.ts); a QBO id is only recorded after
// Intuit actually returned one.

import "server-only"
import type { createServiceClient } from "@/lib/supabase/service"
import {
  loadScopedQuickBooksCredential,
  ensureFreshQuickBooksToken,
  qboRequest,
  findOrCreateQboCustomer,
} from "@/lib/connections/accounting-scopes"

type ServiceClient = ReturnType<typeof createServiceClient>

export interface VendorQuickBooksStatus {
  connected: boolean
  realmId: string | null
}

/** Read whether the vendor has a usable QBO connection (token + realmId present). */
export async function readVendorQuickBooks(
  svc: ServiceClient,
  vendorId: string,
): Promise<VendorQuickBooksStatus> {
  const cred = await loadScopedQuickBooksCredential(svc, "vendor", vendorId)
  return { connected: !!cred, realmId: cred?.realmId ?? null }
}

export interface VendorQBPushOutcome {
  /** false ⇒ vendor has no QBO connection; nothing was attempted (render "Not synced"). */
  attempted: boolean
  success: boolean
  externalId?: string
  error?: string
}

/**
 * Push ONE vendor invoice into the VENDOR's own QuickBooks company as a QBO Invoice
 * (find-or-create the customer, then create the invoice for the ledger total).
 * Idempotent: an invoice that already carries a quickbooks_invoice_id is returned as-is.
 *
 * Requires migration 1104 (vendor_invoices.quickbooks_invoice_id / quickbooks_synced_at);
 * before that migration is applied the pre-flight select fails and we return an honest
 * "requires migration" error WITHOUT calling Intuit.
 */
export async function pushVendorInvoiceToQuickBooks(
  svc: ServiceClient,
  params: { vendorId: string; invoiceId: string },
): Promise<VendorQBPushOutcome> {
  // Pre-flight: read the invoice INCLUDING the sync columns so a missing migration is
  // detected before any Intuit write (a QBO invoice we can't record locally would double
  // on retry).
  const { data: invoice, error: invErr } = await svc
    .from("vendor_invoices")
    .select("id, vendor_id, brokerage_id, contact_id, billed_to, invoice_number, total_amount, notes, quickbooks_invoice_id")
    .eq("id", params.invoiceId)
    .eq("vendor_id", params.vendorId)
    .maybeSingle()

  if (invErr) {
    const msg = invErr.message ?? ""
    if (/quickbooks_invoice_id/i.test(msg)) {
      return {
        attempted: false,
        success: false,
        error: "QuickBooks sync requires database migration 1104 (vendor_invoices.quickbooks_invoice_id) — not yet applied.",
      }
    }
    return { attempted: false, success: false, error: msg || "Failed to load invoice" }
  }
  if (!invoice) return { attempted: false, success: false, error: "Invoice not found for this vendor" }
  if (invoice.quickbooks_invoice_id) {
    return { attempted: true, success: true, externalId: invoice.quickbooks_invoice_id }
  }

  const cred = await loadScopedQuickBooksCredential(svc, "vendor", params.vendorId)
  if (!cred) return { attempted: false, success: false }

  try {
    const accessToken = await ensureFreshQuickBooksToken(svc, cred)

    // The QBO customer is whoever the invoice bills: the contact (buyer/seller) for
    // billed_to='contact', otherwise the brokerage.
    let displayName = "Client"
    let email: string | null = null
    if (invoice.billed_to === "contact" && invoice.contact_id) {
      const { data: contact } = await svc
        .from("contacts")
        .select("first_name, last_name, email")
        .eq("id", invoice.contact_id)
        .maybeSingle()
      displayName = [contact?.first_name, contact?.last_name].filter(Boolean).join(" ") || "Client"
      email = contact?.email ?? null
    } else if (invoice.brokerage_id) {
      const { data: brokerage } = await svc
        .from("brokerages")
        .select("name, email")
        .eq("id", invoice.brokerage_id)
        .maybeSingle()
      displayName = brokerage?.name ?? "Brokerage"
      email = (brokerage as { email?: string | null } | null)?.email ?? null
    }

    const customerId = await findOrCreateQboCustomer({ accessToken, realmId: cred.realmId, displayName, email })

    const created = await qboRequest<{ Invoice: { Id: string } }>({
      accessToken,
      realmId: cred.realmId,
      method: "POST",
      path: "/invoice?minorversion=73",
      body: {
        CustomerRef: { value: customerId },
        ...(invoice.invoice_number ? { DocNumber: String(invoice.invoice_number).slice(0, 21) } : {}),
        Line: [
          {
            Amount: Number(invoice.total_amount ?? 0),
            DetailType: "SalesItemLineDetail",
            Description: invoice.notes ?? `Invoice ${invoice.invoice_number ?? invoice.id.slice(0, 8)}`,
            SalesItemLineDetail: { ItemRef: { value: "1" } },
          },
        ],
      },
    })

    const externalId = created.Invoice.Id
    const { error: updErr } = await svc
      .from("vendor_invoices")
      .update({ quickbooks_invoice_id: externalId, quickbooks_synced_at: new Date().toISOString() })
      .eq("id", params.invoiceId)
      .eq("vendor_id", params.vendorId)

    if (updErr) {
      // The QBO invoice exists but the local record failed — surface it so the vendor
      // knows the ledger link is missing (never silently succeed).
      return {
        attempted: true,
        success: false,
        externalId,
        error: `Invoice created in QuickBooks (id ${externalId}) but recording the sync locally failed: ${updErr.message}`,
      }
    }
    return { attempted: true, success: true, externalId }
  } catch (err) {
    return { attempted: true, success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
