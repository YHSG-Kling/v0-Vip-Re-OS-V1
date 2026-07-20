import { redirect } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { readVendorStripeConnect } from "@/lib/connections/vendor-stripe"
import { confirmVendorInvoiceCheckout } from "@/app/actions/vendor-payments"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Receipt, CheckCircle2, AlertTriangle } from "lucide-react"
import { PayInvoiceButton } from "./pay-invoice-button"

export const dynamic = "force-dynamic"

const STATUS_COLOR: Record<string, string> = {
  submitted: "bg-blue-100 text-blue-700",
  viewed: "bg-indigo-100 text-indigo-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
  disputed: "bg-amber-100 text-amber-700",
}

const PAYABLE = new Set(["submitted", "viewed", "overdue"])

function fmt(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)
}

interface LineItem {
  description?: string
  amount?: number
}

/**
 * Buyer/seller invoice surface — invoices vendors (inspectors, photographers,
 * contractors…) billed DIRECTLY to this contact on their transaction.
 *
 * Payment honesty:
 *   • Vendor has Stripe Connect → "Pay online" (Stripe Checkout destination charge
 *     — the money goes to the VENDOR's account; 'paid' is recorded only after
 *     Stripe confirms the session is paid).
 *   • No Stripe Connect → honest pay-the-vendor-directly instructions; the VENDOR
 *     marks the invoice collected (their documented assertion), and it shows paid here.
 */
export default async function PortalInvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ contactId: string }>
  searchParams: Promise<{ checkout?: string; invoice?: string; session_id?: string }>
}) {
  const { contactId } = await params
  const sp = await searchParams
  const supabase = await createClient()

  // Defense-in-depth access gate (the portal layout also gates): the caller must be
  // the contact themselves or same-brokerage staff.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/portal/login?contactId=${contactId}`)

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("id, brokerage_id, first_name, email, contact_user_id")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact) redirect("/portal?error=contact_not_found")

  const isSelf =
    contact.contact_user_id === user.id ||
    (!!contact.email && !!user.email && contact.email.toLowerCase() === user.email.toLowerCase())
  if (!isSelf) {
    const { data: caller } = await svc
      .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
    if (!caller?.brokerage_id || caller.brokerage_id !== contact.brokerage_id) {
      redirect(`/portal/login?contactId=${contactId}`)
    }
  }

  // ── Checkout return: verify against Stripe BEFORE showing anything as paid ──
  let checkoutBanner: { ok: boolean; text: string } | null = null
  if (sp.checkout === "success" && sp.session_id && sp.invoice) {
    const confirmed = await confirmVendorInvoiceCheckout({
      contactId,
      invoiceId: sp.invoice,
      sessionId: sp.session_id,
    })
    checkoutBanner = confirmed.success
      ? { ok: true, text: confirmed.alreadyPaid ? "This invoice is paid." : "Payment received — thank you! The vendor has been paid." }
      : { ok: false, text: `We could not confirm this payment: ${confirmed.error ?? "unknown error"}. If you were charged, contact your agent.` }
  } else if (sp.checkout === "cancelled") {
    checkoutBanner = { ok: false, text: "Checkout was cancelled — the invoice is still awaiting payment." }
  }

  // ── The contact's vendor invoices ──────────────────────────────────────────
  const { data: invoices } = await svc
    .from("vendor_invoices")
    .select("id, vendor_id, transaction_id, invoice_number, status, total_amount, due_date, paid_at, payment_method, line_items, notes, created_at")
    .eq("contact_id", contactId)
    .eq("billed_to", "contact")
    .eq("brokerage_id", contact.brokerage_id)
    .neq("status", "draft") // drafts are not issued yet
    .order("created_at", { ascending: false })

  const rows = invoices ?? []

  // Vendor names/contact info + Stripe readiness (per unique vendor).
  const vendorIds = [...new Set(rows.map((r: any) => r.vendor_id).filter(Boolean))] as string[]
  const vendorInfo = new Map<string, { name: string; phone: string | null; email: string | null }>()
  const vendorStripeReady = new Map<string, boolean>()
  if (vendorIds.length > 0) {
    const { data: vendors } = await svc
      .from("vendors").select("id, name, phone, email").in("id", vendorIds)
    for (const v of vendors ?? []) {
      vendorInfo.set(v.id, { name: v.name ?? "Vendor", phone: v.phone ?? null, email: v.email ?? null })
    }
    await Promise.all(
      vendorIds.map(async (vid) => {
        const c = await readVendorStripeConnect(svc, vid)
        vendorStripeReady.set(vid, !!c.accountId && c.onboardingComplete)
      })
    )
  }

  // Transaction addresses for context lines.
  const txIds = [...new Set(rows.map((r: any) => r.transaction_id).filter(Boolean))] as string[]
  const txAddress = new Map<string, string>()
  if (txIds.length > 0) {
    const { data: txs } = await svc
      .from("transactions").select("id, property_address").in("id", txIds)
    for (const t of txs ?? []) txAddress.set(t.id, t.property_address ?? "")
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Receipt className="w-6 h-6 text-blue-600" />
          Your Invoices
        </h1>
        <p className="text-muted-foreground text-sm">
          Invoices from service providers on your transaction — inspections, photography,
          repairs, and more.
        </p>
      </div>

      {checkoutBanner && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${
            checkoutBanner.ok
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-amber-50 border-amber-200 text-amber-800"
          }`}
        >
          {checkoutBanner.ok ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          )}
          <span>{checkoutBanner.text}</span>
        </div>
      )}

      {rows.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 text-muted-foreground text-sm">
            No invoices yet. When a service provider bills you directly, the invoice will
            appear here.
          </CardContent>
        </Card>
      ) : (
        rows.map((inv: any) => {
          const vendor = vendorInfo.get(inv.vendor_id)
          const stripeReady = vendorStripeReady.get(inv.vendor_id) ?? false
          const payable = PAYABLE.has(inv.status)
          const lineItems: LineItem[] = Array.isArray(inv.line_items) ? inv.line_items : []
          const address = inv.transaction_id ? txAddress.get(inv.transaction_id) : null
          return (
            <Card key={inv.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">
                      {inv.invoice_number ?? `Invoice ${inv.id.slice(0, 8).toUpperCase()}`}
                    </CardTitle>
                    <CardDescription>
                      From {vendor?.name ?? "your service provider"}
                      {address ? ` · ${address}` : ""}
                      {inv.due_date ? ` · Due ${new Date(inv.due_date).toLocaleDateString()}` : ""}
                    </CardDescription>
                  </div>
                  <Badge className={STATUS_COLOR[inv.status] ?? "bg-gray-100 text-gray-600"}>
                    {inv.status === "submitted" ? "awaiting payment" : inv.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {lineItems.length > 0 && (
                  <div className="text-sm space-y-1">
                    {lineItems.map((l, i) => (
                      <div key={i} className="flex justify-between text-muted-foreground">
                        <span>{l.description || "Service"}</span>
                        <span>{fmt(Number(l.amount ?? 0))}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex justify-between items-center border-t pt-2">
                  <span className="font-semibold">Total</span>
                  <span className="font-semibold text-lg">{fmt(Number(inv.total_amount ?? 0))}</span>
                </div>

                {inv.status === "paid" ? (
                  <p className="text-sm text-green-700 flex items-center gap-1">
                    <CheckCircle2 className="h-4 w-4" />
                    Paid{inv.paid_at ? ` on ${new Date(inv.paid_at).toLocaleDateString()}` : ""}
                    {inv.payment_method === "stripe" ? " online" : ""}
                  </p>
                ) : payable ? (
                  stripeReady ? (
                    <PayInvoiceButton
                      contactId={contactId}
                      invoiceId={inv.id}
                      amountLabel={fmt(Number(inv.total_amount ?? 0))}
                      vendorName={vendor?.name ?? "the vendor"}
                    />
                  ) : (
                    <div className="rounded-lg bg-muted/50 border px-3 py-2 text-sm text-muted-foreground">
                      <p className="font-medium text-foreground mb-1">How to pay</p>
                      <p>
                        {vendor?.name ?? "This vendor"} doesn’t accept online payment here yet —
                        please pay them directly
                        {vendor?.phone ? ` (call ${vendor.phone}` : ""}
                        {vendor?.phone && vendor?.email ? `, or email ${vendor.email})` : vendor?.phone ? ")" : vendor?.email ? ` (email ${vendor.email})` : ""}.
                        Once they confirm receipt, this invoice will show as paid.
                      </p>
                    </div>
                  )
                ) : null}
              </CardContent>
            </Card>
          )
        })
      )}

      <p className="text-xs text-muted-foreground">
        Questions about an invoice? Ask your agent — or{" "}
        <Link href={`/portal/${contactId}/vendors`} className="underline">
          view your service providers
        </Link>
        .
      </p>
    </div>
  )
}
