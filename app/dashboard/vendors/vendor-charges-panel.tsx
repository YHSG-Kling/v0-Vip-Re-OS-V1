"use client"

// Vendor Charges panel — the GENERAL tenant→vendor billing lane (beyond premium
// placement). Brokerage leadership issues an invoice TO a vendor (billed_to='vendor',
// status 'submitted' = issued & awaiting payment) and, once funds arrive off-platform
// (check / ACH / an externally-sent Stripe invoice), marks it paid — the same
// documented-assertion idiom as premium placement. Requires migration 1104
// (vendor_invoices.billed_to CHECK includes 'vendor'); pre-migration attempts surface
// an honest migration error from the server action.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { FileText, Loader2 } from "lucide-react"
import { issueVendorCharge, markVendorChargePaid } from "@/app/actions/vendor-payments"

export interface ChargeableVendor {
  id: string
  name: string | null
  category: string | null
}

export interface VendorChargeInvoice {
  id: string
  vendor_id: string
  invoice_number: string | null
  status: string
  total_amount: number | null
  due_date: string | null
  paid_at: string | null
  notes: string | null
}

const MANAGER_ROLES = ["admin", "broker", "broker_admin", "broker_owner", "superadmin", "team_lead"]
const PAYMENT_METHODS = ["check", "ach", "stripe", "cash_app", "manual"]

export function VendorChargesPanel({
  vendors,
  charges,
  userRole,
}: {
  vendors: ChargeableVendor[]
  charges: VendorChargeInvoice[]
  userRole: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [vendorId, setVendorId] = useState("")
  const [description, setDescription] = useState("")
  const [amount, setAmount] = useState("")
  const [dueDate, setDueDate] = useState(
    new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)
  )
  const [notes, setNotes] = useState("")
  const [payMethod, setPayMethod] = useState("check")
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const canManage = MANAGER_ROLES.includes(userRole)
  if (!canManage) return null

  const vendorName = (id: string) => vendors.find((v) => v.id === id)?.name ?? "Vendor"
  const openCharges = charges.filter((c) => c.status !== "paid" && c.status !== "cancelled")
  const paidCharges = charges.filter((c) => c.status === "paid").slice(0, 5)

  function handleIssue() {
    setMessage(null)
    setError(null)
    const amt = parseFloat(amount)
    if (!vendorId) { setError("Select a vendor to charge."); return }
    if (!description.trim()) { setError("Describe what you are charging for."); return }
    if (!Number.isFinite(amt) || amt <= 0) { setError("Enter an amount greater than zero."); return }

    startTransition(async () => {
      const res = await issueVendorCharge({
        vendorId,
        dueDate,
        notes: notes || undefined,
        lineItems: [{ description: description.trim(), quantity: 1, unitPrice: amt, amount: amt }],
      })
      if (!res.success) {
        setError(res.error ?? "Failed to issue vendor charge")
        return
      }
      setMessage(`Invoice ${res.invoiceNumber} issued to ${vendorName(vendorId)} — mark it paid once funds arrive.`)
      setDescription("")
      setAmount("")
      setNotes("")
      router.refresh()
    })
  }

  function handleMarkPaid(invoiceId: string) {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const res = await markVendorChargePaid({ invoiceId, paymentMethod: payMethod })
      if (!res.success) {
        setError(res.error ?? "Failed to mark charge paid")
        return
      }
      setMessage("Charge marked paid.")
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Vendor Charges
        </CardTitle>
        <CardDescription>
          Bill a vendor for anything beyond placement — services, events, referral program
          fees. Collection is off-platform (check, ACH, or a Stripe invoice you send); mark
          the charge paid once funds arrive.
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

        {/* Issue a new charge */}
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Vendor</Label>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select vendor…" />
              </SelectTrigger>
              <SelectContent>
                {vendors.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name ?? "Vendor"}{v.category ? ` — ${v.category}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Description</Label>
            <Input
              className="h-9"
              placeholder="e.g. Broker open house sponsorship"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Amount ($)</Label>
            <Input
              className="h-9"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Due date</Label>
            <Input
              className="h-9"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">Notes (optional — included in the vendor's email)</Label>
            <Input
              className="h-9"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Payment instructions, context…"
            />
          </div>
        </div>
        <Button size="sm" onClick={handleIssue} disabled={isPending}>
          {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Issue vendor charge
        </Button>

        {/* Open charges awaiting collection */}
        {openCharges.length > 0 && (
          <div className="space-y-3 pt-2">
            <p className="text-sm font-medium">Charges awaiting payment</p>
            {openCharges.map((inv) => (
              <div
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-3 p-4 border rounded-lg"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{inv.invoice_number ?? inv.id.slice(0, 8)}</p>
                    <Badge variant="outline">{inv.status}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {vendorName(inv.vendor_id)} — ${Number(inv.total_amount ?? 0).toFixed(2)}
                    {inv.due_date ? ` — due ${new Date(inv.due_date).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Select value={payMethod} onValueChange={setPayMethod}>
                    <SelectTrigger className="w-28 h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_METHODS.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" onClick={() => handleMarkPaid(inv.id)} disabled={isPending}>
                    {isPending ? "Saving..." : "Mark paid"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Recent collected charges */}
        {paidCharges.length > 0 && (
          <div className="space-y-2 pt-2">
            <p className="text-sm font-medium">Recently collected</p>
            {paidCharges.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between text-sm py-1 border-b last:border-0">
                <span>
                  {inv.invoice_number ?? inv.id.slice(0, 8)} — {vendorName(inv.vendor_id)}
                </span>
                <span className="text-muted-foreground">
                  ${Number(inv.total_amount ?? 0).toFixed(2)}
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
