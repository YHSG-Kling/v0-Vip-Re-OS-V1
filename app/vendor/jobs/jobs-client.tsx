"use client"

import { useState, useTransition } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Receipt, Loader2, CheckCircle2, X, MessageSquarePlus } from "lucide-react"
import { VendorRequestDialog } from "./vendor-request-dialog"
import { createAndSendVendorClientInvoice } from "@/app/actions/vendor-payments"
import {
  acceptVendorBookingAction,
  declineVendorBookingAction,
} from "@/app/actions/vendor-portal"
import { markBookingComplete } from "@/app/actions/vendor-marketplace"

interface Booking {
  id: string
  service_type: string | null
  status: string | null
  scheduled_date: string | null
  notes: string | null
  contact_id: string | null
  listing_id: string | null
  transaction_id: string | null
  vendor_id: string | null
  vendors?: { id: string; name?: string } | null
  transactions?: { id: string; property_address?: string } | null
}

interface Props {
  bookings: Booking[]
}

// LIVE vocabulary (vendor_bookings.status CHECK): booked → awaiting the vendor's
// accept; confirmed → accepted; completed/cancelled/no_show terminal.
const STATUS_COLOR: Record<string, string> = {
  booked: "bg-yellow-100 text-yellow-700",
  confirmed: "bg-indigo-100 text-indigo-700",
  completed: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-700",
  no_show: "bg-gray-200 text-gray-600",
}

export function JobsClient({ bookings: initial }: Props) {
  const [bookings, setBookings] = useState(initial)
  const [invoiceFor, setInvoiceFor] = useState<Booking | null>(null)
  const [requestFor, setRequestFor] = useState<Booking | null>(null)
  const [invoiced, setInvoiced] = useState<Set<string>>(new Set())
  const [actionPending, startAction] = useTransition()
  const [actingOn, setActingOn] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleAccept(b: Booking) {
    if (!b.vendor_id) return
    setActingOn(b.id)
    setErrorMsg(null)
    startAction(async () => {
      const res = await acceptVendorBookingAction({
        bookingId: b.id,
        vendorId:  b.vendor_id!,
      })
      if (res.success) {
        setBookings((prev) => prev.map((x) => (x.id === b.id ? { ...x, status: "confirmed" } : x)))
      } else {
        setErrorMsg(res.error ?? "Failed to accept")
      }
      setActingOn(null)
    })
  }

  async function handleDecline(b: Booking) {
    if (!b.vendor_id) return
    if (!confirm("Decline this job? The brokerage will be notified to route to another vendor.")) return
    setActingOn(b.id)
    setErrorMsg(null)
    startAction(async () => {
      const res = await declineVendorBookingAction({
        bookingId: b.id,
        vendorId:  b.vendor_id!,
      })
      if (res.success) {
        setBookings((prev) => prev.map((x) => (x.id === b.id ? { ...x, status: "cancelled" } : x)))
      } else {
        setErrorMsg(res.error ?? "Failed to decline")
      }
      setActingOn(null)
    })
  }

  async function handleComplete(b: Booking) {
    if (!confirm("Mark this job complete? The agent and clients will be notified.")) return
    setActingOn(b.id)
    setErrorMsg(null)
    startAction(async () => {
      try {
        await markBookingComplete(b.id)
        setBookings((prev) => prev.map((x) => (x.id === b.id ? { ...x, status: "completed" } : x)))
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Failed to complete")
      }
      setActingOn(null)
    })
  }

  if (bookings.length === 0) {
    return (
      <Card>
        <CardContent className="text-center py-12 text-gray-500">
          No jobs found. Jobs assigned to you will appear here.
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      {errorMsg && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 mb-3">
          {errorMsg}
        </div>
      )}
      <div className="space-y-3">
        {bookings.map((b) => (
          <Card key={b.id}>
            <CardContent className="p-4 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{b.service_type || "Service Job"}</p>
                <p className="text-sm text-gray-500 line-clamp-1">
                  {b.notes || b.transactions?.property_address || "No additional details"}
                </p>
                {b.scheduled_date && (
                  <p className="text-xs text-gray-400">
                    {new Date(b.scheduled_date).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge className={STATUS_COLOR[b.status ?? ""] ?? "bg-gray-100 text-gray-700"}>
                  {b.status}
                </Badge>
                {b.status === "booked" && (
                  <>
                    <Button
                      size="sm"
                      className="bg-green-600 hover:bg-green-700 text-white text-xs"
                      onClick={() => handleAccept(b)}
                      disabled={actionPending && actingOn === b.id}
                    >
                      {actionPending && actingOn === b.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        "Accept"
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs text-red-600 border-red-200 hover:bg-red-50"
                      onClick={() => handleDecline(b)}
                      disabled={actionPending && actingOn === b.id}
                    >
                      <X className="h-3 w-3 mr-1" />
                      Decline
                    </Button>
                  </>
                )}
                {b.status === "confirmed" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs gap-1 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                    onClick={() => handleComplete(b)}
                    disabled={actionPending && actingOn === b.id}
                  >
                    {actionPending && actingOn === b.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3" />
                    )}
                    Complete
                  </Button>
                )}
                {b.transaction_id && b.vendor_id && b.status !== "cancelled" && b.status !== "completed" && b.status !== "no_show" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs gap-1"
                    onClick={() => setRequestFor(b)}
                  >
                    <MessageSquarePlus className="h-3 w-3" />
                    Request
                  </Button>
                )}
                {b.status === "completed" && (
                  invoiced.has(b.id) ? (
                    <Badge variant="outline" className="text-xs gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Invoiced
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs gap-1"
                      onClick={() => setInvoiceFor(b)}
                    >
                      <Receipt className="h-3 w-3" />
                      Create Invoice
                    </Button>
                  )
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {requestFor && requestFor.transaction_id && requestFor.vendor_id && (
        <VendorRequestDialog
          vendorId={requestFor.vendor_id}
          transactionId={requestFor.transaction_id}
          propertyAddress={requestFor.transactions?.property_address ?? null}
          onClose={() => setRequestFor(null)}
        />
      )}

      {invoiceFor && (
        <InvoiceDialog
          booking={invoiceFor}
          onClose={() => setInvoiceFor(null)}
          onInvoiced={(id) => setInvoiced((s) => new Set([...s, id]))}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

interface InvoiceLine {
  description: string
  quantity: string
  unitPrice: string
}

function InvoiceDialog({
  booking,
  onClose,
  onInvoiced,
}: {
  booking: Booking
  onClose: () => void
  onInvoiced: (bookingId: string) => void
}) {
  const [billedTo, setBilledTo] = useState<"brokerage" | "contact">("brokerage")
  const [invoiceNumber, setInvoiceNumber] = useState(
    `INV-${Date.now().toString(36).toUpperCase()}`
  )
  const [dueDate, setDueDate] = useState(
    new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)
  )
  const [lines, setLines] = useState<InvoiceLine[]>([
    { description: booking.service_type ?? "Services rendered", quantity: "1", unitPrice: "" },
  ])
  const [taxRate, setTaxRate] = useState("0")
  const [notes, setNotes] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function updateLine(i: number, patch: Partial<InvoiceLine>) {
    setLines((arr) => arr.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function addLine() {
    setLines((arr) => [...arr, { description: "", quantity: "1", unitPrice: "" }])
  }
  function removeLine(i: number) {
    setLines((arr) => arr.filter((_, idx) => idx !== i))
  }

  const subtotal = lines.reduce((s, l) => {
    const q = parseFloat(l.quantity) || 0
    const p = parseFloat(l.unitPrice) || 0
    return s + q * p
  }, 0)
  const tax = subtotal * (parseFloat(taxRate) || 0) / 100
  const total = subtotal + tax

  function handleSubmit() {
    setError(null)
    if (subtotal <= 0) {
      setError("Add at least one line item with a price")
      return
    }
    if (billedTo === "contact" && !booking.contact_id) {
      setError("This booking has no contact attached. Bill the brokerage instead, or have the agent attach a contact first.")
      return
    }

    startTransition(async () => {
      // Issues the invoice (status 'submitted') and — for contact billing — notifies
      // the buyer/seller by email with a link to their portal invoice surface.
      const result = await createAndSendVendorClientInvoice({
        vendorId: booking.vendor_id ?? "",
        bookingId: booking.id,
        listingId: booking.listing_id ?? undefined,
        transactionId: booking.transaction_id ?? undefined,
        billedTo,
        contactId: billedTo === "contact" ? (booking.contact_id ?? undefined) : undefined,
        invoiceNumber,
        dueDate,
        taxRate: (parseFloat(taxRate) || 0) / 100,
        lineItems: lines.map((l) => ({
          description: l.description,
          quantity: parseFloat(l.quantity) || 0,
          unitPrice: parseFloat(l.unitPrice) || 0,
          amount: (parseFloat(l.quantity) || 0) * (parseFloat(l.unitPrice) || 0),
        })),
        notes: notes || undefined,
      })

      if (result.success) {
        // Honest email reporting: the invoice IS issued (visible in the client's
        // portal) even if the notification email did not go out.
        if (billedTo === "contact" && !result.emailSent) {
          window.alert(
            `Invoice submitted and visible in the client's portal, but the email notification was not sent${result.emailError ? `: ${result.emailError}` : "."}`
          )
        }
        onInvoiced(booking.id)
        onClose()
      } else {
        setError(result.error ?? "Failed to create invoice")
      }
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-blue-600" />
            Create Invoice
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Bill to */}
          <div>
            <Label className="text-xs">Bill to</Label>
            <Select value={billedTo} onValueChange={(v) => setBilledTo(v as any)}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="brokerage">Brokerage</SelectItem>
                <SelectItem value="contact">Contact directly (buyer or seller)</SelectItem>
              </SelectContent>
            </Select>
            {billedTo === "contact" && !booking.contact_id && (
              <p className="text-xs text-amber-700 mt-1">
                ⚠ This job has no contact attached. Ask the brokerage to attach a contact, or bill the brokerage.
              </p>
            )}
            {billedTo === "contact" && booking.contact_id && (
              <p className="text-xs text-muted-foreground mt-1">
                Will be sent directly to the contact via their portal.
              </p>
            )}
          </div>

          {/* Invoice number + due date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Invoice #</Label>
              <Input
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
            <div>
              <Label className="text-xs">Due Date</Label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
          </div>

          {/* Line items */}
          <div>
            <Label className="text-xs">Line items</Label>
            <div className="space-y-2 mt-1">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <Input
                    className="col-span-6 h-8 text-xs"
                    placeholder="Description"
                    value={l.description}
                    onChange={(e) => updateLine(i, { description: e.target.value })}
                  />
                  <Input
                    className="col-span-2 h-8 text-xs"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Qty"
                    value={l.quantity}
                    onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  />
                  <Input
                    className="col-span-3 h-8 text-xs"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="$ each"
                    value={l.unitPrice}
                    onChange={(e) => updateLine(i, { unitPrice: e.target.value })}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="col-span-1 h-8 text-xs px-1"
                    onClick={() => removeLine(i)}
                    disabled={lines.length === 1}
                  >
                    ×
                  </Button>
                </div>
              ))}
            </div>
            <Button size="sm" variant="ghost" className="text-xs mt-1" onClick={addLine}>
              + Add line item
            </Button>
          </div>

          {/* Tax + totals */}
          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <Label className="text-xs">Tax rate (%)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">
                Subtotal: ${subtotal.toFixed(2)} · Tax: ${tax.toFixed(2)}
              </p>
              <p className="text-base font-semibold">Total: ${total.toFixed(2)}</p>
            </div>
          </div>

          {/* Notes */}
          <div>
            <Label className="text-xs">Notes (optional)</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 h-9"
              placeholder="Payment terms, thank-you note, etc."
            />
          </div>

          {error && (
            <p className="text-xs text-red-600">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isPending || subtotal <= 0}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Submit Invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
