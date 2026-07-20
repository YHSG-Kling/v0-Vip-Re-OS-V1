// lib/connections/vendor-quickbooks.ts
// Single source of truth for a VENDOR's QuickBooks Online connection, on the unified
// owner model — the exact sibling of lib/connections/vendor-stripe.ts.
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
import { callConnector } from "@/lib/agentic-os/connector-gateway"

type ServiceClient = ReturnType<typeof createServiceClient>

const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
const QBO_API_BASE = "https://quickbooks.api.intuit.com/v3/company"

export interface VendorQuickBooksStatus {
  connected: boolean
  realmId: string | null
}

interface VendorQBCredential {
  id: string
  accessToken: string
  refreshToken: string
  realmId: string
  tokenExpiresAt: string | null
}

/** Read whether the vendor has a usable QBO connection (token + realmId present). */
export async function readVendorQuickBooks(
  svc: ServiceClient,
  vendorId: string,
): Promise<VendorQuickBooksStatus> {
  const cred = await loadVendorQBCredential(svc, vendorId)
  return { connected: !!cred, realmId: cred?.realmId ?? null }
}

async function loadVendorQBCredential(
  svc: ServiceClient,
  vendorId: string,
): Promise<VendorQBCredential | null> {
  const { data } = await svc
    .from("platform_credentials")
    .select("id, access_token, refresh_token, account_id, token_expires_at, config, is_active")
    .eq("owner_type", "vendor")
    .eq("owner_id", vendorId)
    .eq("platform", "quickbooks")
    .maybeSingle()

  if (!data || data.is_active === false) return null
  const config = (data.config ?? {}) as Record<string, unknown>
  // Token columns are canonical; older QBO rows kept tokens in `config` (same
  // tolerance as lib/finance/accounting-egress.ts).
  const accessToken = (data.access_token as string | null) ?? (config.access_token as string | undefined) ?? null
  const refreshToken = (data.refresh_token as string | null) ?? (config.refresh_token as string | undefined) ?? ""
  const realmId = (data.account_id as string | null) ?? (config.realm_id as string | undefined) ?? (config.realmId as string | undefined) ?? null
  if (!accessToken || !realmId) return null
  return {
    id: data.id as string,
    accessToken,
    refreshToken,
    realmId,
    tokenExpiresAt: (data.token_expires_at as string | null) ?? null,
  }
}

/** Refresh the vendor's access token when near expiry and persist the new set.
 *  Returns the live access token (refreshed or current). Throws on refresh failure. */
async function ensureFreshToken(svc: ServiceClient, cred: VendorQBCredential): Promise<string> {
  const exp = cred.tokenExpiresAt ? Date.parse(cred.tokenExpiresAt) : NaN
  const nearExpiry = !Number.isNaN(exp) && exp <= Date.now() + 5 * 60_000
  if (!nearExpiry || !cred.refreshToken) return cred.accessToken

  const clientId = process.env.QUICKBOOKS_CLIENT_ID
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error("QuickBooks app credentials not configured (QUICKBOOKS_CLIENT_ID/SECRET)")
  }

  const tokenUrl = new URL(INTUIT_TOKEN_URL)
  const res = await callConnector<{ access_token: string; refresh_token: string; expires_in: number }>({
    connector: "quickbooks-oauth",
    baseUrl: tokenUrl.origin,
    path: tokenUrl.pathname,
    method: "POST",
    auth: { style: "basic", username: clientId, password: clientSecret },
    bodyType: "form",
    body: { grant_type: "refresh_token", refresh_token: cred.refreshToken },
  })
  if (!res.ok || !res.data) {
    throw new Error(`QuickBooks token refresh failed (${res.status ?? "—"}): ${res.error ?? ""}`)
  }
  const tokenExpiresAt = new Date(Date.now() + (res.data.expires_in ?? 3600) * 1000).toISOString()
  await svc
    .from("platform_credentials")
    .update({
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token,
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", cred.id)
  return res.data.access_token
}

/** Single egress choke point for QBO API calls (Bearer, via the connector-gateway). */
async function qboRequest<T>(args: {
  accessToken: string
  realmId: string
  method: "GET" | "POST"
  path: string
  body?: unknown
}): Promise<T> {
  const res = await callConnector<T>({
    connector: "quickbooks",
    baseUrl: `${QBO_API_BASE}/${args.realmId}`,
    path: args.path,
    method: args.method,
    body: args.body,
    auth: { style: "bearer", token: args.accessToken },
  })
  if (!res.ok || res.data == null) {
    throw new Error(`QuickBooks ${args.method} ${args.path.split("?")[0]} failed (${res.status ?? "—"}): ${res.error ?? ""}`)
  }
  return res.data
}

/** Find a QBO Customer by display name, creating it when absent. Returns the Customer Id. */
async function findOrCreateCustomer(args: {
  accessToken: string
  realmId: string
  displayName: string
  email?: string | null
}): Promise<string> {
  // QBO query syntax escapes single quotes by doubling them.
  const name = args.displayName.trim().slice(0, 100) || "Client"
  const escaped = name.replace(/'/g, "''")
  const query = `select Id from Customer where DisplayName = '${escaped}'`
  const found = await qboRequest<{ QueryResponse?: { Customer?: Array<{ Id: string }> } }>({
    accessToken: args.accessToken,
    realmId: args.realmId,
    method: "GET",
    path: `/query?query=${encodeURIComponent(query)}&minorversion=73`,
  })
  const existing = found.QueryResponse?.Customer?.[0]?.Id
  if (existing) return existing

  const created = await qboRequest<{ Customer: { Id: string } }>({
    accessToken: args.accessToken,
    realmId: args.realmId,
    method: "POST",
    path: "/customer?minorversion=73",
    body: {
      DisplayName: name,
      ...(args.email ? { PrimaryEmailAddr: { Address: args.email } } : {}),
    },
  })
  return created.Customer.Id
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

  const cred = await loadVendorQBCredential(svc, params.vendorId)
  if (!cred) return { attempted: false, success: false }

  try {
    const accessToken = await ensureFreshToken(svc, cred)

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

    const customerId = await findOrCreateCustomer({ accessToken, realmId: cred.realmId, displayName, email })

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
