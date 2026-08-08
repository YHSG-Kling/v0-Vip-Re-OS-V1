"use client"

// Vendor Bills panel — the BROKERAGE→VENDOR payable lane
// (vendor_invoices.billed_to='brokerage'), i.e. money the brokerage OWES a
// vendor for booked work. This is the mirror of the Vendor Charges panel next to
// it, which handles the opposite direction (billed_to='vendor', money the vendor
// owes the brokerage).
//
// WHY THIS EXISTS: the lane had a live PRODUCER and no CONSUMER. A vendor invoice
// for a booking is created by app/actions/multi-persona.ts:submitVendorInvoice
// (wired to the dashboard's vendor-bookings panel) as billed_to='brokerage',
// status 'submitted'. Nothing on the platform could then mark one paid, and
// marking it paid is the ONLY thing that mints the vendor_earnings row the vendor
// earnings page displays and initiateVendorPayout pays out. So vendors could be
// booked, could invoice, and could never be paid through the product.
//
// Collection here is an ASSERTION, exactly like the sibling panels: the funds move
// off-platform (check / ACH / bill pay) and marking paid records that fact, which
// credits the vendor's available balance. The server action
// (vendor-payments.ts:markInvoicePaid) enforces tenancy, the broker/admin/team_lead
// role, the billed_to lane, and idempotency — this panel never widens those.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Receipt, Loader2 } from "lucide-react"
import { markInvoicePaid } from "@/app/actions/vendor-payments"

export interface VendorBillInvoice {
  id: string
  vendor_id: string
  invoice_number: string | null
  status: string
  total_amount: number | null
  due_date: string | null
  paid_at: string | null
  notes: string | null
}

/** Mirrors VENDOR_CHARGE_ADMIN_ROLES minus 'agent' — authorizing a payment OUT of
 *  brokerage funds is leadership's, and markInvoicePaid enforces the same set
 *  server-side. Rendering this to an agent would only produce a "Forbidden". */
const BILL_PAYER_ROLES = ["broker", "broker_owner", "broker_admin", "admin", "superadmin", "team_lead"]
const PAYMENT_METHODS = ["check", "ach", "bill_pay", "card", "manual"]

function fmt(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)
}

export function VendorBillsPanel({
  bills,
  vendorNames,
  userRole,
}: {
  bills: VendorBillInvoice[]
  /** vendors.id → display name, resolved server-side. */
  vendorNames: Record<string, string>
  userRole: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [payMethod, setPayMethod] = useState("check")
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [payingId, setPayingId] = useState<string | null>(null)

  if (!BILL_PAYER_ROLES.includes(userRole)) return null

  const openBills = bills.filter((b) => b.status !== "paid" && b.status !== "cancelled")
  const paidBills = bills.filter((b) => b.status === "paid").slice(0, 5)

  // Nothing to show and nothing ever billed — stay out of the way.
  if (bills.length === 0) return null

  const vendorName = (id: string) => vendorNames[id] ?? "Vendor"
  const openTotal = openBills.reduce((s, b) => s + Number(b.total_amount ?? 0), 0)

  function handleMarkPaid(invoiceId: string) {
    setMessage(null)
    setError(null)
    setPayingId(invoiceId)
    startTransition(async () => {
      const res = await markInvoicePaid({ invoiceId, paymentMethod: payMethod })
      setPayingId(null)
      if (!res.success) {
        setError(res.error ?? "Failed to mark this bill paid")
        return
      }
      setMessage("Bill marked paid — the vendor's available balance has been credited.")
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="h-5 w-5" />
          Vendor Bills
        </CardTitle>
        <CardDescription>
          Invoices your vendors have submitted for booked work. Pay them off-platform
          (check, ACH, bill pay) and mark them paid here — that credits the vendor&apos;s
          available balance so they can be paid out.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {message && (
          <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            {message}
          </p>
        )}
        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {openBills.length > 0 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">
              Awaiting payment — {fmt(openTotal)} across {openBills.length}{" "}
              {openBills.length === 1 ? "bill" : "bills"}
            </p>
            {openBills.map((inv) => {
              const overdue =
                !!inv.due_date && inv.status !== "paid" && new Date(inv.due_date) < new Date()
              return (
                <div
                  key={inv.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4 border rounded-lg"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{inv.invoice_number ?? inv.id.slice(0, 8)}</p>
                      <Badge variant="outline">{inv.status}</Badge>
                      {overdue && <Badge variant="destructive">overdue</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {vendorName(inv.vendor_id)} — {fmt(Number(inv.total_amount ?? 0))}
                      {inv.due_date ? ` — due ${new Date(inv.due_date).toLocaleDateString()}` : ""}
                    </p>
                    {inv.notes && (
                      <p className="text-xs text-muted-foreground">{inv.notes}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Select value={payMethod} onValueChange={setPayMethod}>
                      <SelectTrigger className="w-28 h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PAYMENT_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m.replace(/_/g, " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      onClick={() => handleMarkPaid(inv.id)}
                      disabled={isPending}
                    >
                      {isPending && payingId === inv.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Mark paid"
                      )}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground border rounded-lg px-3 py-2">
            No vendor bills are awaiting payment.
          </p>
        )}

        {paidBills.length > 0 && (
          <div className="space-y-2 pt-2">
            <p className="text-sm font-medium">Recently paid</p>
            {paidBills.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between text-sm py-1 border-b last:border-0"
              >
                <span>
                  {inv.invoice_number ?? inv.id.slice(0, 8)} — {vendorName(inv.vendor_id)}
                </span>
                <span className="text-muted-foreground">
                  {fmt(Number(inv.total_amount ?? 0))}
                  {inv.paid_at ? ` · ${new Date(inv.paid_at).toLocaleDateString()}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
