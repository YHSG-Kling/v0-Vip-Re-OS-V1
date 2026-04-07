"use client"

// app/components/features/vendors/VendorManagerPanel.tsx
//
// Canonical reusable Vendor Manager Panel.
// Accepts a context (listing | transaction | contact) and contextId,
// fetches assigned vendors and deliverables for that context, and renders:
//   - Assigned vendor list with status badges
//   - Book new vendor CTA (opens booking dialog)
//   - Deliverables list per booking with attach action
//
// Kernel OS Rules:
//   - All mutations go through app/actions/vendors-kernel.ts (kernel commands)
//   - No direct DB calls in this component
//   - vendor_bookings.listing_id = listing context
//   - vendor_assignments.transaction_id = transaction context
//   - contact_vendors = contact context (read-only list here)

import { useState, useTransition, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  Building2,
  Calendar,
  Paperclip,
  Package,
  Plus,
  ExternalLink,
  CheckCircle2,
  Clock,
  XCircle,
  AlertTriangle,
} from "lucide-react"
import {
  assignVendorToListingAction,
  assignVendorToTransactionAction,
  updateVendorBookingStatusAction,
  attachVendorDeliverableAction,
} from "@/app/actions/vendors-kernel"

// ─── TYPES ───────────────────────────────────────────────────────────────────

export type VendorManagerContext = "listing" | "transaction" | "contact"

export type BookingStatus = "booked" | "confirmed" | "completed" | "cancelled" | "no_show"

export interface PanelVendorRow {
  id:           string
  name:         string
  category:     string | null
  phone:        string | null
  email:        string | null
  rating:       number | null
}

export interface PanelBookingRow {
  id:             string
  vendor_id:      string
  service_type:   string
  scheduled_date: string | null
  cost:           number | null
  status:         BookingStatus
  completed_at:   string | null
  notes:          string | null
  vendors?:       PanelVendorRow | null
}

export interface PanelAssignmentRow {
  id:             string
  vendor_id:      string
  assignment_type: string
  scheduled_date: string | null
  status:         string
  vendors?:       PanelVendorRow | null
}

export interface PanelDeliverableRow {
  id:          string
  doc_name:    string | null
  file_url:    string
  notes:       string | null
  created_at:  string
  metadata:    { vendor_booking_id?: string; vendor_id?: string; service_type?: string } | null
}

export interface VendorManagerPanelProps {
  brokerageId:    string
  context:        VendorManagerContext
  contextId:      string
  // Pre-loaded data from parent RSC (optional — panel fetches via actions if not provided)
  bookings?:      PanelBookingRow[]
  assignments?:   PanelAssignmentRow[]
  deliverables?:  PanelDeliverableRow[]
  // Available vendors to book from (pass from parent to avoid double-fetch)
  availableVendors?: PanelVendorRow[]
  className?:     string
}

// ─── STATUS BADGE ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return (
        <Badge className="bg-green-100 text-green-800 border-green-200 flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Completed
        </Badge>
      )
    case "confirmed":
      return (
        <Badge className="bg-blue-100 text-blue-800 border-blue-200 flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Confirmed
        </Badge>
      )
    case "booked":
      return (
        <Badge className="bg-amber-100 text-amber-800 border-amber-200 flex items-center gap-1">
          <Clock className="h-3 w-3" />
          Booked
        </Badge>
      )
    case "cancelled":
      return (
        <Badge variant="destructive" className="flex items-center gap-1">
          <XCircle className="h-3 w-3" />
          Cancelled
        </Badge>
      )
    case "no_show":
      return (
        <Badge className="bg-gray-100 text-gray-700 border-gray-200 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          No Show
        </Badge>
      )
    default:
      return <Badge variant="secondary">{status}</Badge>
  }
}

// Allowed next transitions for each status — mirrors the kernel graph
const NEXT_STATUSES: Record<string, BookingStatus[]> = {
  booked:    ["confirmed", "cancelled", "no_show"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show:   [],
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export function VendorManagerPanel({
  brokerageId,
  context,
  contextId,
  bookings: initialBookings = [],
  assignments: initialAssignments = [],
  deliverables: initialDeliverables = [],
  availableVendors = [],
  className,
}: VendorManagerPanelProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Local state derived from props (refreshed on router.refresh())
  const [bookings, setBookings]         = useState<PanelBookingRow[]>(initialBookings)
  const [assignments, setAssignments]   = useState<PanelAssignmentRow[]>(initialAssignments)
  const [deliverables, setDeliverables] = useState<PanelDeliverableRow[]>(initialDeliverables)

  // Sync state when parent provides updated props
  useEffect(() => { setBookings(initialBookings) }, [initialBookings])
  useEffect(() => { setAssignments(initialAssignments) }, [initialAssignments])
  useEffect(() => { setDeliverables(initialDeliverables) }, [initialDeliverables])

  // Book Vendor dialog state
  const [bookDialogOpen, setBookDialogOpen]   = useState(false)
  const [selectedVendorId, setSelectedVendorId] = useState("")
  const [bookServiceType, setBookServiceType] = useState("")
  const [bookDate, setBookDate]               = useState("")
  const [bookCost, setBookCost]               = useState("")
  const [bookNotes, setBookNotes]             = useState("")
  const [bookError, setBookError]             = useState("")

  // Attach Deliverable dialog state
  const [deliverableDialogOpen, setDeliverableDialogOpen] = useState(false)
  const [delBookingId, setDelBookingId]       = useState("")
  const [delVendorId, setDelVendorId]         = useState("")
  const [delUrl, setDelUrl]                   = useState("")
  const [delFileName, setDelFileName]         = useState("")
  const [delDescription, setDelDescription]  = useState("")
  const [delError, setDelError]               = useState("")

  // Status transition state
  const [transitionBookingId, setTransitionBookingId] = useState<string | null>(null)

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleBookVendor = useCallback(() => {
    if (!selectedVendorId || !bookServiceType || !bookDate) {
      setBookError("Vendor, service type, and date are required.")
      return
    }
    setBookError("")
    startTransition(async () => {
      let result
      if (context === "listing") {
        result = await assignVendorToListingAction({
          vendorId:      selectedVendorId,
          listingId:     contextId,
          serviceType:   bookServiceType,
          scheduledDate: bookDate,
          cost:          bookCost ? parseFloat(bookCost) : undefined,
          notes:         bookNotes || undefined,
        })
      } else {
        // transaction or contact — use transaction assignment
        result = await assignVendorToTransactionAction({
          vendorId:       selectedVendorId,
          transactionId:  contextId,
          assignmentType: bookServiceType,
          scheduledDate:  bookDate,
          notes:          bookNotes || undefined,
        })
      }

      if (!result.success) {
        setBookError(result.error ?? "Failed to assign vendor.")
        return
      }
      setBookDialogOpen(false)
      setSelectedVendorId("")
      setBookServiceType("")
      setBookDate("")
      setBookCost("")
      setBookNotes("")
      router.refresh()
    })
  }, [selectedVendorId, bookServiceType, bookDate, bookCost, bookNotes, context, contextId, router])

  const handleStatusTransition = useCallback((bookingId: string, toStatus: BookingStatus) => {
    setTransitionBookingId(bookingId)
    startTransition(async () => {
      const result = await updateVendorBookingStatusAction({ bookingId, toStatus })
      setTransitionBookingId(null)
      if (result.success) {
        // Optimistically update local state
        setBookings(prev =>
          prev.map(b => b.id === bookingId
            ? { ...b, status: toStatus, completed_at: toStatus === "completed" ? new Date().toISOString() : b.completed_at }
            : b
          )
        )
      }
    })
  }, [])

  const handleAttachDeliverable = useCallback(() => {
    if (!delBookingId || !delUrl || !delDescription) {
      setDelError("Booking, URL, and description are required.")
      return
    }
    setDelError("")
    startTransition(async () => {
      const result = await attachVendorDeliverableAction({
        bookingId:   delBookingId,
        vendorId:    delVendorId,
        documentUrl: delUrl,
        description: delDescription,
        fileName:    delFileName || undefined,
      })
      if (!result.success) {
        setDelError(result.error ?? "Failed to attach deliverable.")
        return
      }
      setDeliverableDialogOpen(false)
      setDelBookingId("")
      setDelVendorId("")
      setDelUrl("")
      setDelFileName("")
      setDelDescription("")
      router.refresh()
    })
  }, [delBookingId, delVendorId, delUrl, delDescription, delFileName, router])

  // ── Derived counts ─────────────────────────────────────────────────────────

  const activeBookings    = bookings.filter(b => !["completed", "cancelled", "no_show"].includes(b.status))
  const activeAssignments = assignments.filter(a => !["completed", "cancelled"].includes(a.status))

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={`space-y-4 ${className ?? ""}`}>
      {/* ── Assigned Vendors ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                Assigned Vendors
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                {context === "listing" ? "Booked for this listing" : context === "transaction" ? "Assigned to this transaction" : "Linked to this contact"}
              </CardDescription>
            </div>
            {availableVendors.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => setBookDialogOpen(true)} className="bg-transparent h-8">
                <Plus className="h-3.5 w-3.5 mr-1" />
                Assign
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {/* Bookings (listing + contact context) */}
          {context !== "transaction" && (
            <>
              {bookings.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  <Building2 className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  No vendors assigned yet
                </div>
              ) : (
                <div className="space-y-2">
                  {bookings.map((booking) => {
                    const nextStatuses = NEXT_STATUSES[booking.status] ?? []
                    return (
                      <div key={booking.id} className="p-3 border rounded-lg space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-0.5 min-w-0">
                            <div className="font-medium text-sm truncate">
                              {booking.vendors?.name ?? "Vendor"}
                            </div>
                            <div className="text-xs text-muted-foreground">{booking.service_type}</div>
                            {booking.scheduled_date && (
                              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Calendar className="h-3 w-3" />
                                {new Date(booking.scheduled_date).toLocaleDateString()}
                              </div>
                            )}
                            {booking.cost != null && (
                              <div className="text-xs text-muted-foreground">
                                ${booking.cost.toLocaleString()}
                              </div>
                            )}
                          </div>
                          <StatusBadge status={booking.status} />
                        </div>
                        {nextStatuses.length > 0 && (
                          <div className="flex gap-1.5 flex-wrap">
                            {nextStatuses.map((toStatus) => (
                              <Button
                                key={toStatus}
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs bg-transparent"
                                disabled={isPending && transitionBookingId === booking.id}
                                onClick={() => handleStatusTransition(booking.id, toStatus)}
                              >
                                Mark {toStatus}
                              </Button>
                            ))}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs text-muted-foreground"
                              onClick={() => {
                                setDelBookingId(booking.id)
                                setDelVendorId(booking.vendor_id)
                                setDeliverableDialogOpen(true)
                              }}
                            >
                              <Paperclip className="h-3 w-3 mr-1" />
                              Attach file
                            </Button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}

          {/* Assignments (transaction context) */}
          {context === "transaction" && (
            <>
              {assignments.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  <Building2 className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  No vendors assigned yet
                </div>
              ) : (
                <div className="space-y-2">
                  {assignments.map((assignment) => (
                    <div key={assignment.id} className="flex items-start justify-between gap-2 p-3 border rounded-lg">
                      <div className="space-y-0.5 min-w-0">
                        <div className="font-medium text-sm truncate">
                          {assignment.vendors?.name ?? "Vendor"}
                        </div>
                        <div className="text-xs text-muted-foreground">{assignment.assignment_type}</div>
                        {assignment.scheduled_date && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Calendar className="h-3 w-3" />
                            {new Date(assignment.scheduled_date).toLocaleDateString()}
                          </div>
                        )}
                      </div>
                      <StatusBadge status={assignment.status} />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Deliverables ──────────────────────────────────────────────────── */}
      {deliverables.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground" />
              Vendor Deliverables
              <Badge variant="secondary" className="text-xs">{deliverables.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {deliverables.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="space-y-0.5 min-w-0">
                    <div className="font-medium text-sm truncate">{doc.doc_name ?? doc.notes ?? "Deliverable"}</div>
                    {doc.metadata?.service_type && (
                      <Badge variant="outline" className="text-xs">{doc.metadata.service_type}</Badge>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {new Date(doc.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <a href={doc.file_url} target="_blank" rel="noopener noreferrer">
                    <Button size="sm" variant="ghost" className="h-8">
                      <ExternalLink className="h-3.5 w-3.5 mr-1" />
                      View
                    </Button>
                  </a>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Assign Vendor Dialog ──────────────────────────────────────────── */}
      <Dialog open={bookDialogOpen} onOpenChange={setBookDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign Vendor</DialogTitle>
            <DialogDescription>
              {context === "listing"
                ? "Assign a vendor to this listing."
                : "Assign a vendor to this transaction."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Vendor <span className="text-destructive">*</span></Label>
              <Select value={selectedVendorId} onValueChange={setSelectedVendorId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select vendor" />
                </SelectTrigger>
                <SelectContent>
                  {availableVendors.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}{v.category ? ` — ${v.category}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Service Type <span className="text-destructive">*</span></Label>
              <Input
                value={bookServiceType}
                onChange={(e) => setBookServiceType(e.target.value)}
                placeholder="e.g., Home Inspection, Photography"
              />
            </div>

            <div className="space-y-2">
              <Label>Scheduled Date <span className="text-destructive">*</span></Label>
              <Input
                type="date"
                value={bookDate}
                onChange={(e) => setBookDate(e.target.value)}
              />
            </div>

            {context !== "transaction" && (
              <div className="space-y-2">
                <Label>Estimated Cost ($)</Label>
                <Input
                  type="number"
                  value={bookCost}
                  onChange={(e) => setBookCost(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            )}

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={bookNotes}
                onChange={(e) => setBookNotes(e.target.value)}
                placeholder="Optional notes..."
                rows={2}
              />
            </div>

            {bookError && <p className="text-sm text-destructive">{bookError}</p>}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setBookDialogOpen(false)
                setBookError("")
              }}
              className="bg-transparent"
            >
              Cancel
            </Button>
            <Button
              onClick={handleBookVendor}
              disabled={isPending || !selectedVendorId || !bookServiceType || !bookDate}
            >
              {isPending ? "Assigning..." : "Assign Vendor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Attach Deliverable Dialog ─────────────────────────────────────── */}
      <Dialog open={deliverableDialogOpen} onOpenChange={setDeliverableDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Attach Deliverable</DialogTitle>
            <DialogDescription>
              Link a vendor-supplied document or file to a booking.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Booking <span className="text-destructive">*</span></Label>
              <Select value={delBookingId} onValueChange={(val) => {
                setDelBookingId(val)
                const b = bookings.find(bk => bk.id === val)
                if (b) setDelVendorId(b.vendor_id)
              }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select booking" />
                </SelectTrigger>
                <SelectContent>
                  {bookings.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.vendors?.name ?? "Vendor"} — {b.service_type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>File URL <span className="text-destructive">*</span></Label>
              <Input
                value={delUrl}
                onChange={(e) => setDelUrl(e.target.value)}
                placeholder="https://..."
                type="url"
              />
            </div>

            <div className="space-y-2">
              <Label>File Name</Label>
              <Input
                value={delFileName}
                onChange={(e) => setDelFileName(e.target.value)}
                placeholder="e.g., inspection-report.pdf"
              />
            </div>

            <div className="space-y-2">
              <Label>Description <span className="text-destructive">*</span></Label>
              <Textarea
                value={delDescription}
                onChange={(e) => setDelDescription(e.target.value)}
                placeholder="Describe the deliverable..."
                rows={2}
              />
            </div>

            {delError && <p className="text-sm text-destructive">{delError}</p>}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeliverableDialogOpen(false)
                setDelError("")
              }}
              className="bg-transparent"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAttachDeliverable}
              disabled={isPending || !delBookingId || !delUrl || !delDescription}
            >
              {isPending ? "Attaching..." : "Attach Deliverable"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
