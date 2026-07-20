import { redirect } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { readVendorStripeConnect } from "@/lib/connections/vendor-stripe"
import { readVendorQuickBooks } from "@/lib/connections/vendor-quickbooks"
import { Button } from "@/components/ui/button"
import { Receipt, ArrowLeft } from "lucide-react"
import { VendorInvoicesClient, type VendorInvoiceRow } from "./invoices-client"

export const dynamic = "force-dynamic"

/**
 * Vendor Invoice Center — every invoice this vendor has raised (billed to the
 * brokerage or directly to a buyer/seller contact) plus any charges the tenant
 * issued TO the vendor. Also the vendor's accounting posture:
 *   • Stripe Connect (clients pay online → funds land on the vendor's account)
 *   • QuickBooks (vendor's own books; invoices honestly show "Not synced" until
 *     connected + synced — nothing is faked)
 */
export default async function VendorInvoicesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Canonical vendor linkage: user_role_assignments.vendor_id
  const { data: ra } = await supabase
    .from("user_role_assignments")
    .select("vendor_id, brokerage_id")
    .eq("user_id", user.id)
    .not("vendor_id", "is", null)
    .maybeSingle()

  const vendorId = (ra?.vendor_id as string | null) ?? null
  const brokerageId = (ra?.brokerage_id as string | null) ?? null

  if (!vendorId || !brokerageId) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        <p>No vendor profile found for your account.</p>
        <Link href="/vendor/dashboard">
          <Button variant="link">Back to Dashboard</Button>
        </Link>
      </div>
    )
  }

  const svc = createServiceClient()

  const [{ data: invoices }, stripeConnect, quickbooks] = await Promise.all([
    svc
      .from("vendor_invoices")
      .select("*")
      .eq("vendor_id", vendorId)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(200),
    readVendorStripeConnect(svc, vendorId),
    readVendorQuickBooks(svc, vendorId),
  ])

  // Resolve contact names for contact-billed invoices in one query.
  const contactIds = [...new Set((invoices ?? []).map((i: any) => i.contact_id).filter(Boolean))] as string[]
  const contactNames = new Map<string, string>()
  if (contactIds.length > 0) {
    const { data: contacts } = await svc
      .from("contacts")
      .select("id, first_name, last_name")
      .in("id", contactIds)
    for (const c of contacts ?? []) {
      contactNames.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(" ") || "Client")
    }
  }

  const rows: VendorInvoiceRow[] = (invoices ?? []).map((i: any) => ({
    id: i.id,
    invoiceNumber: i.invoice_number ?? null,
    billedTo: i.billed_to,
    contactName: i.contact_id ? contactNames.get(i.contact_id) ?? "Client" : null,
    status: i.status,
    total: Number(i.total_amount ?? 0),
    dueDate: i.due_date ?? null,
    paidAt: i.paid_at ?? null,
    paymentMethod: i.payment_method ?? null,
    createdAt: i.created_at ?? null,
    // Columns arrive with migration 1104 — absent columns simply read undefined,
    // which renders as the honest "Not synced" state.
    quickbooksInvoiceId: i.quickbooks_invoice_id ?? null,
  }))

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <Link href="/vendor/dashboard">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Receipt className="w-6 h-6 text-blue-600" />
            Invoices
          </h1>
          <p className="text-gray-500 text-sm">
            Bill the brokerage or your buyer/seller clients, track payment, and sync to your books
          </p>
        </div>
      </div>

      <VendorInvoicesClient
        vendorId={vendorId}
        invoices={rows}
        stripeReady={!!stripeConnect.accountId && stripeConnect.onboardingComplete}
        quickbooksConnected={quickbooks.connected}
      />
    </div>
  )
}
