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
import { Receipt, Loader2, CheckCircle2, X, MessageSquarePlus, Camera } from "lucide-react"
import { VendorRequestDialog } from "./vendor-request-dialog"
import { createAndSendVendorClientInvoice } from "@/app/actions/vendor-payments"
import {
  acceptVendorBookingAction,
  declineVendorBookingAction,
  submitVendorQuoteAction,
} from "@/app/actions/vendor-portal"
import { markBookingComplete } from "@/app/actions/vendor-marketplace"
// WAVE 151 (lane 151B — owner ruling L6.3): the assigned photographer's own delivery door. The files go straight to the
// tenant's listing-media bucket under THIS booking's listing folder (the same path convention the Media Manager writes),
// and the delivery is RECORDED through app/actions/photo-management.ts submitPhotographerDelivery — which proves the vendor
// seat, the booking and the folder, and lands the rows for the agent's REVIEW (never published on its own).
import { submitPhotographerDelivery } from "@/app/actions/photo-management"
import { createClient } from "@/lib/supabase/client"
import { checkUpload } from "@/lib/storage/file-limits"
import {
  LISTING_MEDIA_BUCKET,
  LISTING_MEDIA_DELIVERY_VENDOR_CATEGORIES,
  DELIVERABLE_BOOKING_STATUSES,
  PHOTOGRAPHER_DELIVERY_ATTESTATION_TEXT,
  PHOTOGRAPHER_DELIVERY_ATTESTATION_VERSION,
} from "@/lib/listings/owner-photo-upload"

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
  /** The booking's tenant — the listing-media folder is `<brokerage_id>/<listing_id>/…`. */
  brokerage_id?: string | null
  approval_status?: string | null
  vendors?: { id: string; name?: string; category?: string | null } | null
  transactions?: { id: string; property_address?: string } | null
}

/** PURE — may THIS booking take a photo delivery from this vendor seat? A listing booking, accepted (or complete), of a
 *  photographer vendor. The server re-decides every one of these; this only decides whether to show the door. */
function canDeliverPhotos(b: Booking): boolean {
  return !!b.listing_id && !!b.vendor_id && !!b.brokerage_id
    && (DELIVERABLE_BOOKING_STATUSES as readonly string[]).includes(b.status ?? "")
    && (LISTING_MEDIA_DELIVERY_VENDOR_CATEGORIES as readonly string[]).includes(String(b.vendors?.category ?? "").toLowerCase())
}

interface QuoteRequest {
  vendorId: string
  id: string
  service_type: string
  needed_by: string | null
  myQuote: { amount: number; available_on: string | null; status: string } | null
}

interface Props {
  bookings: Booking[]
  /** Wave 107B — procurement requests this vendor may quote on (lib/kernel/procurement.ts). */
  quoteRequests?: QuoteRequest[]
  quoteError?: string | null
}

// LIVE vocabulary (vendor_bookings.status CHECK): booked → awaiting the vendor's
// accept; confirmed → accepted; completed/cancelled/no_show terminal.
const STATUS_COLOR: Record<string, string> = {
  requested: "bg-blue-100 text-blue-700",
  booked: "bg-yellow-100 text-yellow-700",
  confirmed: "bg-indigo-100 text-indigo-700",
  completed: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-700",
  no_show: "bg-gray-200 text-gray-600",
}

export function JobsClient({ bookings: initial, quoteRequests: initialQuotes = [], quoteError = null }: Props) {
  const [bookings, setBookings] = useState(initial)
  const [quoteRequests, setQuoteRequests] = useState(initialQuotes)
  const [invoiceFor, setInvoiceFor] = useState<Booking | null>(null)
  const [requestFor, setRequestFor] = useState<Booking | null>(null)
  const [deliverFor, setDeliverFor] = useState<Booking | null>(null)
  const [delivered, setDelivered] = useState<Record<string, number>>({})
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

  // Wave 107B — quote on an open procurement request (own quote only; the kernel checks candidacy).
  function handleQuote(q: QuoteRequest) {
    const raw = window.prompt(`Your price (USD) for ${q.service_type}${q.needed_by ? `, needed by ${q.needed_by}` : ""}:`, q.myQuote ? String(q.myQuote.amount) : "")
    if (raw == null) return
    const amount = Number(raw)
    if (!Number.isFinite(amount) || amount < 0) { setErrorMsg("Enter a valid amount"); return }
    const availableOn = window.prompt("Earliest date you can do it (YYYY-MM-DD, optional):", q.myQuote?.available_on ?? "") || null
    setActingOn(q.id)
    setErrorMsg(null)
    startAction(async () => {
      const res = await submitVendorQuoteAction({ vendorId: q.vendorId, bookingId: q.id, amount, availableOn })
      if (res.success) {
        setQuoteRequests((prev) => prev.map((x) => (x.id === q.id && x.vendorId === q.vendorId ? { ...x, myQuote: { amount, available_on: availableOn, status: "submitted" } } : x)))
      } else {
        setErrorMsg(res.error ?? "Failed to send quote")
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

  // Wave 107B — open procurement requests to quote on, rendered above the job book.
  const quotePanel = (quoteRequests.length > 0 || quoteError) ? (
    <div className="space-y-2 mb-4">
      <p className="text-sm font-medium">Open quote requests</p>
      {quoteError && <p className="text-sm text-red-600">{quoteError}</p>}
      {quoteRequests.map((q) => (
        <Card key={`${q.vendorId}:${q.id}`}>
          <CardContent className="p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-sm">{q.service_type}</p>
              <p className="text-xs text-gray-500">
                {q.needed_by ? `Needed by ${new Date(q.needed_by).toLocaleDateString()}` : "No deadline given"}
                {q.myQuote ? ` · your quote $${q.myQuote.amount} (${q.myQuote.status})` : ""}
              </p>
            </div>
            <Button size="sm" variant="outline" className="text-xs" onClick={() => handleQuote(q)} disabled={actionPending && actingOn === q.id}>
              {actionPending && actingOn === q.id ? <Loader2 className="h-3 w-3 animate-spin" /> : q.myQuote ? "Update quote" : "Send quote"}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  ) : null

  if (bookings.length === 0) {
    return (
      <>
      {quotePanel}
      <Card>
        <CardContent className="text-center py-12 text-gray-500">
          No jobs found. Jobs assigned to you will appear here.
        </CardContent>
      </Card>
      </>
    )
  }

  return (
    <>
      {quotePanel}
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
                  <p className="text-xs text-gray-500">
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
                      className="bg-green-700 hover:bg-green-800 text-white text-xs"
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
                {canDeliverPhotos(b) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs gap-1 text-blue-700 border-blue-200 hover:bg-blue-50"
                    onClick={() => setDeliverFor(b)}
                    title="Deliver the photos for this listing — they go to the agent for review"
                  >
                    <Camera className="h-3 w-3" />
                    {delivered[b.id] ? `Deliver more (${delivered[b.id]} sent)` : "Deliver photos"}
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

      {deliverFor && (
        <PhotoDeliveryDialog
          booking={deliverFor}
          onClose={() => setDeliverFor(null)}
          onDelivered={(id, count) => setDelivered((d) => ({ ...d, [id]: (d[id] ?? 0) + count }))}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// THE PHOTOGRAPHER'S DELIVERY (wave 151, lane 151B — owner ruling L6.3)
//
// ASSIGNED LISTING (this booking's listing_id) → authenticated photographer (the vendor seat, proved server-side)
// → permitted listing-media upload (direct to the tenant bucket under `<brokerage_id>/<listing_id>/…`, size + type gated
//   by the bucket's own limits through checkUpload) → media validation + provenance (the rights statement, versioned)
// → asset REVIEW (the rows land unapproved; the agent approves them in the Media Manager) → availability → agent notice.
// ---------------------------------------------------------------------------

function PhotoDeliveryDialog({
  booking,
  onClose,
  onDelivered,
}: {
  booking: Booking
  onClose: () => void
  onDelivered: (bookingId: string, count: number) => void
}) {
  const [files, setFiles] = useState<File[]>([])
  const [attested, setAttested] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function pickFiles(list: FileList | null) {
    const next = Array.from(list ?? [])
    const refused = next.map((f) => ({ f, gate: checkUpload({ bucket: LISTING_MEDIA_BUCKET, transport: "direct_to_storage", bytes: f.size, contentType: f.type }) }))
      .filter((x) => !x.gate.ok)
    if (refused.length > 0) {
      setError(refused.map((x) => `${x.f.name}: ${(x.gate as { reason: string }).reason}`).join(" · "))
      setFiles(next.filter((f) => !refused.some((x) => x.f === f)))
      return
    }
    setError(null)
    setFiles(next)
  }

  function handleDeliver() {
    setError(null)
    setResult(null)
    if (!booking.listing_id || !booking.brokerage_id || !booking.vendor_id) { setError("This booking names no listing to deliver to."); return }
    if (files.length === 0) { setError("Choose the photo files to deliver."); return }
    if (!attested) { setError("Confirm the rights statement before delivering."); return }
    const listingId = booking.listing_id
    const brokerageId = booking.brokerage_id
    const vendorId = booking.vendor_id
    startTransition(async () => {
      try {
        const supabase = createClient()
        const paths: string[] = []
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          setProgress(`Uploading ${i + 1} of ${files.length} — ${file.name}`)
          const ext = (file.name.split(".").pop() ?? "jpg").toLowerCase()
          // The Media Manager's own path convention: <brokerageId>/<listingId>/<timestamp>-<random>.<ext>. The bucket's
          // RESTRICTIVE policy (owner SQL, OWNER-SQL §M) admits this vendor seat into exactly this listing's folder.
          const path = `${brokerageId}/${listingId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
          const { error: upErr } = await supabase.storage.from(LISTING_MEDIA_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
          if (upErr) { setError(`${file.name} was not uploaded: ${upErr.message}`); setProgress(null); return }
          // The browser hands the server the OBJECT PATH only — the URL is minted server-side by the ONE issuer
          // (lib/storage/document-buckets.ts issueBucketObjectUrl), never by a client-side getPublicUrl.
          paths.push(path)
        }
        setProgress("Recording the delivery for the agent's review…")
        const res = await submitPhotographerDelivery({
          vendorId,
          bookingId: booking.id,
          filePaths: paths,
          attestation: { accepted: true, version: PHOTOGRAPHER_DELIVERY_ATTESTATION_VERSION },
        })
        setProgress(null)
        if (!res.success) { setError(res.error); return }
        onDelivered(booking.id, res.recorded)
        setResult(
          `${res.recorded} photo${res.recorded === 1 ? "" : "s"} delivered for review` +
          (res.skipped ? ` · ${res.skipped} already delivered` : "") +
          (res.notified ? " · the listing agent has been notified" : res.warning ? ` · ${res.warning}` : ""),
        )
        setFiles([])
      } catch (e) {
        setProgress(null)
        setError(e instanceof Error ? e.message : "The delivery could not be completed")
      }
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-blue-600" />
            Deliver listing photos
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Photos go to the listing agent for review before they are used anywhere. Only this booking&apos;s listing can receive them.
          </p>
          <div>
            <Label className="text-xs" htmlFor={`photo-delivery-${booking.id}`}>Photo files (jpg, png, webp, heic)</Label>
            <Input
              id={`photo-delivery-${booking.id}`}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/gif"
              multiple
              className="mt-1"
              onChange={(e) => pickFiles(e.target.files)}
              disabled={isPending}
            />
            {files.length > 0 && (
              <p className="text-xs text-muted-foreground mt-1">{files.length} file{files.length === 1 ? "" : "s"} selected</p>
            )}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
              disabled={isPending}
              aria-describedby={`photo-attestation-${booking.id}`}
            />
            <span id={`photo-attestation-${booking.id}`}>{PHOTOGRAPHER_DELIVERY_ATTESTATION_TEXT}</span>
          </label>
          {progress && <p className="text-xs text-muted-foreground">{progress}</p>}
          {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
          {result && <p className="text-xs text-emerald-700">{result}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{result ? "Done" : "Cancel"}</Button>
          <Button onClick={handleDeliver} disabled={isPending || files.length === 0 || !attested}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Camera className="h-4 w-4 mr-2" />}
            Deliver for review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
