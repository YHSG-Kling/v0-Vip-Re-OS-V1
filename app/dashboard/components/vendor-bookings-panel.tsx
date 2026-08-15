"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Wrench, CalendarDays, CheckCircle2, XCircle, AlertCircle, FileText, Loader2 } from "lucide-react"
import { transitionBookingStatus, type VendorBookingStatus } from "@/app/actions/ai-vendor-management"
import { submitVendorInvoice } from "@/app/actions/multi-persona"
import { cn } from "@/lib/utils"

export type VendorBookingRow = {
  id: string
  service_type: string | null
  status: string | null
  scheduled_date: string | null
  notes: string | null
  contact_id: string | null
  listing_id: string | null
  vendors: { name: string } | null
}

interface VendorBookingsPanelProps {
  bookings: VendorBookingRow[]
}

const STATUS_CONFIG: Record<string, { label: string; variant: string; icon: React.ReactNode }> = {
  booked:    { label: "Booked",     variant: "secondary",    icon: <CalendarDays className="h-3 w-3" /> },
  confirmed: { label: "Confirmed",  variant: "default",      icon: <CheckCircle2 className="h-3 w-3 text-blue-600" /> },
  completed: { label: "Completed",  variant: "outline",      icon: <CheckCircle2 className="h-3 w-3 text-green-600" /> },
  cancelled: { label: "Cancelled",  variant: "destructive",  icon: <XCircle className="h-3 w-3" /> },
  no_show:   { label: "No Show",    variant: "destructive",  icon: <AlertCircle className="h-3 w-3" /> },
}

interface InvoiceFormState {
  amount: string
  invoiceNumber: string
  dueDate: string
  notes: string
}

export function VendorBookingsPanel({ bookings }: VendorBookingsPanelProps) {
  const [statuses, setStatuses] = useState<Record<string, string>>(
    () => Object.fromEntries(bookings.map(b => [b.id, b.status ?? "booked"]))
  )
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [invoiceOpen, setInvoiceOpen] = useState<Record<string, boolean>>({})
  const [invoiceForm, setInvoiceForm] = useState<Record<string, InvoiceFormState>>({})
  const [invoiceSubmitting, setInvoiceSubmitting] = useState<Record<string, boolean>>({})
  const [invoiceSent, setInvoiceSent] = useState<Record<string, boolean>>({})

  async function handleTransition(bookingId: string, toStatus: VendorBookingStatus) {
    setPending(p => ({ ...p, [bookingId]: true }))
    const result = await transitionBookingStatus({ bookingId, toStatus })
    if (result.success) {
      setStatuses(s => ({ ...s, [bookingId]: toStatus }))
    }
    setPending(p => ({ ...p, [bookingId]: false }))
  }

  function toggleInvoice(bookingId: string) {
    setInvoiceOpen(o => ({ ...o, [bookingId]: !o[bookingId] }))
    if (!invoiceForm[bookingId]) {
      const today = new Date().toISOString().slice(0, 10)
      const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)
      setInvoiceForm(f => ({
        ...f,
        [bookingId]: { amount: "", invoiceNumber: `INV-${Date.now().toString(36).toUpperCase()}`, dueDate: due, notes: "" },
      }))
    }
  }

  async function handleSubmitInvoice(bookingId: string) {
    const form = invoiceForm[bookingId]
    if (!form?.amount || parseFloat(form.amount) <= 0) return
    setInvoiceSubmitting(s => ({ ...s, [bookingId]: true }))
    const result = await submitVendorInvoice({
      bookingId,
      amount: parseFloat(form.amount),
      invoiceDate: new Date().toISOString().slice(0, 10),
      dueDate: form.dueDate,
      invoiceNumber: form.invoiceNumber,
      notes: form.notes || undefined,
    })
    setInvoiceSubmitting(s => ({ ...s, [bookingId]: false }))
    if (result.success) {
      setInvoiceSent(s => ({ ...s, [bookingId]: true }))
      setInvoiceOpen(o => ({ ...o, [bookingId]: false }))
    }
  }

  if (!bookings.length) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          Vendor Bookings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {bookings.map(booking => {
          const currentStatus = statuses[booking.id] ?? "booked"
          const config = STATUS_CONFIG[currentStatus] ?? STATUS_CONFIG.booked
          const isLoading = pending[booking.id]
          const form = invoiceForm[booking.id]

          return (
            <div
              key={booking.id}
              className="flex flex-col gap-2 rounded-md border px-3 py-2.5 text-sm"
            >
              {/* Row: vendor name + service + status badge */}
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium leading-tight">
                    {booking.vendors?.name ?? "Unknown Vendor"}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {booking.service_type?.replace(/_/g, " ") ?? "Service"}
                  </p>
                </div>
                <Badge
                  variant={config.variant as any}
                  className="flex items-center gap-1 shrink-0 text-xs"
                >
                  {config.icon}
                  {config.label}
                </Badge>
              </div>

              {/* Scheduled date + notes */}
              {(booking.scheduled_date || booking.notes) && (
                <div className="space-y-0.5">
                  {booking.scheduled_date && (
                    <p className="text-xs text-muted-foreground">
                      Scheduled:{" "}
                      {new Date(booking.scheduled_date).toLocaleDateString(undefined, {
                        month: "short", day: "numeric", year: "numeric",
                      })}
                    </p>
                  )}
                  {booking.notes && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{booking.notes}</p>
                  )}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 flex-wrap">
                {!["completed", "cancelled", "no_show"].includes(currentStatus) && (
                  <>
                    {currentStatus === "booked" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={isLoading}
                        onClick={() => handleTransition(booking.id, "confirmed")}
                      >
                        Mark Confirmed
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className={cn("h-7 text-xs", currentStatus === "confirmed" && "border-green-300 text-green-700 hover:bg-green-50")}
                      disabled={isLoading}
                      onClick={() => handleTransition(booking.id, "completed")}
                    >
                      Mark Complete
                    </Button>
                  </>
                )}

                {/* Invoice button — available on confirmed or completed bookings */}
                {["confirmed", "completed"].includes(currentStatus) && (
                  <Button
                    size="sm"
                    variant={invoiceSent[booking.id] ? "ghost" : "outline"}
                    className="h-7 text-xs gap-1"
                    onClick={() => toggleInvoice(booking.id)}
                    disabled={invoiceSent[booking.id]}
                  >
                    <FileText className="h-3 w-3" />
                    {invoiceSent[booking.id] ? "Invoiced" : "Create Invoice"}
                  </Button>
                )}
              </div>

              {/* Inline invoice form */}
              {invoiceOpen[booking.id] && form && (
                <div className="border-t pt-2 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Create Invoice</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-muted-foreground">Amount ($)</label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={form.amount}
                        onChange={e => setInvoiceForm(f => ({ ...f, [booking.id]: { ...f[booking.id], amount: e.target.value } }))}
                        placeholder="0.00"
                        className="h-7 text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Invoice #</label>
                      <Input
                        value={form.invoiceNumber}
                        onChange={e => setInvoiceForm(f => ({ ...f, [booking.id]: { ...f[booking.id], invoiceNumber: e.target.value } }))}
                        className="h-7 text-xs"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Due date</label>
                    <Input
                      type="date"
                      value={form.dueDate}
                      onChange={e => setInvoiceForm(f => ({ ...f, [booking.id]: { ...f[booking.id], dueDate: e.target.value } }))}
                      className="h-7 text-xs"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1 flex-1"
                      disabled={invoiceSubmitting[booking.id] || !form.amount}
                      onClick={() => handleSubmitInvoice(booking.id)}
                    >
                      {invoiceSubmitting[booking.id] ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <FileText className="h-3 w-3" />
                      )}
                      Submit Invoice
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setInvoiceOpen(o => ({ ...o, [booking.id]: false }))}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
