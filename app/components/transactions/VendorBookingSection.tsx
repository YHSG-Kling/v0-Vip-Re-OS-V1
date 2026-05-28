"use client"

import { useState, useTransition, useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Plus, Wrench, Star, CheckCircle2, XCircle, CalendarDays, Search } from "lucide-react"
import {
  searchVendors,
  getVendorBookingsForTransaction,
  createVendorBookingWithKernelEvent,
  markBookingComplete,
  rateVendorBooking,
  getSuggestedVendorsByStage,
} from "@/app/actions/vendor-marketplace"

const SERVICE_TYPES = [
  "inspector", "appraiser", "title", "escrow", "lender",
  "contractor", "plumber", "electrician", "hvac", "roofer",
  "stager", "photographer", "cleaner", "mover", "surveyor",
]

interface Vendor {
  id: string
  name: string
  email?: string | null
  phone?: string | null
  category?: string | null
  rating?: number | null
}

interface Booking {
  id: string
  service_type: string | null
  status: string | null
  scheduled_date: string | null
  notes: string | null
  vendor_id?: string
  vendors: { id: string; name: string; category?: string | null; rating?: number | null } | null
  agent_rating?: number | null
}

interface Props {
  transactionId: string
  transactionStage?: string
  initialBookings?: Booking[]
}

export function VendorBookingSection({ transactionId, transactionStage, initialBookings = [] }: Props) {
  const [bookings, setBookings] = useState<Booking[]>(initialBookings)
  const [showForm, setShowForm] = useState(false)
  const [isPending, startTransition] = useTransition()

  // Form state
  const [searchQuery, setSearchQuery] = useState("")
  const [serviceType, setServiceType] = useState("")
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [suggested, setSuggested] = useState<Vendor[]>([])
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null)
  const [scheduledDate, setScheduledDate] = useState("")
  const [notes, setNotes] = useState("")
  const [cost, setCost] = useState("")
  const [searchLoading, setSearchLoading] = useState(false)
  const [bookError, setBookError] = useState<string | null>(null)

  // Rating state
  const [ratingBookingId, setRatingBookingId] = useState<string | null>(null)
  const [ratingValue, setRatingValue] = useState(5)
  const [ratingReview, setRatingReview] = useState("")
  const [ratingPending, setRatingPending] = useState(false)

  // Load fresh bookings on mount
  useEffect(() => {
    getVendorBookingsForTransaction(transactionId)
      .then((data) => setBookings(data as any))
      .catch(() => null)
  }, [transactionId])

  // Load suggested vendors when form opens
  useEffect(() => {
    if (!showForm || !transactionStage) return
    getSuggestedVendorsByStage(transactionStage)
      .then((data) => setSuggested(data as Vendor[]))
      .catch(() => null)
  }, [showForm, transactionStage])

  const handleSearch = useCallback(() => {
    if (!searchQuery.trim() && !serviceType) return
    setSearchLoading(true)
    searchVendors({ name: searchQuery || undefined, serviceType: serviceType || undefined, limit: 10 })
      .then((data) => setVendors(data as Vendor[]))
      .catch(() => null)
      .finally(() => setSearchLoading(false))
  }, [searchQuery, serviceType])

  function handleBook() {
    if (!selectedVendor || !scheduledDate) {
      setBookError("Select a vendor and scheduled date.")
      return
    }
    setBookError(null)
    startTransition(async () => {
      try {
        const booking = await createVendorBookingWithKernelEvent({
          vendorId: selectedVendor.id,
          transactionId,
          serviceType: serviceType || selectedVendor.category || "service",
          scheduledDate,
          notes: notes || undefined,
          cost: cost ? parseFloat(cost) : undefined,
        })
        // Refresh bookings
        const fresh = await getVendorBookingsForTransaction(transactionId)
        setBookings(fresh as any)
        // Reset form
        setShowForm(false)
        setSelectedVendor(null)
        setScheduledDate("")
        setNotes("")
        setCost("")
        setSearchQuery("")
        setServiceType("")
        setVendors([])
      } catch (err: any) {
        setBookError(err?.message ?? "Failed to create booking")
      }
    })
  }

  async function handleMarkComplete(bookingId: string) {
    try {
      await markBookingComplete(bookingId)
      setBookings(prev => prev.map(b => b.id === bookingId ? { ...b, status: "completed" } : b))
    } catch {
      // silent
    }
  }

  async function handleRate(bookingId: string) {
    setRatingPending(true)
    try {
      await rateVendorBooking({ bookingId, rating: ratingValue, review: ratingReview || undefined })
      setBookings(prev => prev.map(b => b.id === bookingId ? { ...b, agent_rating: ratingValue } : b))
      setRatingBookingId(null)
    } catch {
      // silent
    } finally {
      setRatingPending(false)
    }
  }

  const displayVendors = vendors.length > 0 ? vendors : suggested

  return (
    <div className="space-y-4">
      {/* Existing Bookings */}
      {bookings.length > 0 && (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Wrench className="h-4 w-4 text-muted-foreground" />
              Booked Vendors
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            {bookings.map((booking) => (
              <div key={booking.id} className="rounded-md border px-3 py-2.5 text-sm space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium leading-tight">{booking.vendors?.name ?? "Unknown Vendor"}</p>
                    <p className="text-xs text-muted-foreground capitalize">
                      {booking.service_type?.replace(/_/g, " ") ?? "Service"}
                    </p>
                    {booking.scheduled_date && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <CalendarDays className="h-3 w-3" />
                        {new Date(booking.scheduled_date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                      </p>
                    )}
                  </div>
                  <Badge variant={
                    booking.status === "completed" ? "outline" :
                    booking.status === "confirmed" ? "default" :
                    booking.status === "cancelled" ? "destructive" : "secondary"
                  } className="text-xs shrink-0">
                    {booking.status === "completed" && <CheckCircle2 className="h-3 w-3 mr-1 text-green-600" />}
                    {booking.status === "cancelled" && <XCircle className="h-3 w-3 mr-1" />}
                    {(booking.status ?? "booked").replace(/_/g, " ")}
                  </Badge>
                </div>

                {/* Actions */}
                {booking.status !== "completed" && booking.status !== "cancelled" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-green-300 text-green-700 hover:bg-green-50"
                    onClick={() => handleMarkComplete(booking.id)}
                  >
                    Mark Complete
                  </Button>
                )}

                {/* Rating */}
                {booking.status === "completed" && !booking.agent_rating && (
                  ratingBookingId === booking.id ? (
                    <div className="space-y-2 bg-muted/30 p-2 rounded-md">
                      <div className="flex items-center gap-1">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button key={n} type="button" onClick={() => setRatingValue(n)}>
                            <Star className={`h-4 w-4 ${n <= ratingValue ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`} />
                          </button>
                        ))}
                      </div>
                      <Input
                        placeholder="Leave a review (optional)"
                        value={ratingReview}
                        onChange={(e) => setRatingReview(e.target.value)}
                        className="h-8 text-xs"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" className="h-7 text-xs" onClick={() => handleRate(booking.id)} disabled={ratingPending}>
                          {ratingPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Submit"}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setRatingBookingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => setRatingBookingId(booking.id)}>
                      <Star className="h-3 w-3" />
                      Rate Vendor
                    </Button>
                  )
                )}

                {booking.agent_rating && (
                  <div className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star key={n} className={`h-3 w-3 ${n <= booking.agent_rating! ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Book Vendor Button */}
      <Button size="sm" variant="outline" className="w-full gap-1" onClick={() => setShowForm(!showForm)}>
        <Plus className="h-4 w-4" />
        Book Vendor
      </Button>

      {/* Booking Form */}
      {showForm && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Book a Vendor</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Service Type</Label>
                <Select value={serviceType} onValueChange={setServiceType}>
                  <SelectTrigger className="h-8 text-xs mt-1">
                    <SelectValue placeholder="Any service" />
                  </SelectTrigger>
                  <SelectContent>
                    {SERVICE_TYPES.map((t) => (
                      <SelectItem key={t} value={t} className="text-xs capitalize">{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Search by name</Label>
                <div className="flex gap-1 mt-1">
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder="Vendor name…"
                    className="h-8 text-xs"
                  />
                  <Button size="sm" variant="outline" className="h-8 px-2 shrink-0" onClick={handleSearch} disabled={searchLoading}>
                    {searchLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                  </Button>
                </div>
              </div>
            </div>

            {/* Vendor list */}
            {displayVendors.length > 0 && (
              <div className="border rounded-md divide-y max-h-48 overflow-y-auto">
                {displayVendors.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelectedVendor(v)}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-muted transition-colors ${selectedVendor?.id === v.id ? "bg-primary/10 border-l-2 border-primary" : ""}`}
                  >
                    <p className="font-medium">{v.name}</p>
                    <p className="text-muted-foreground capitalize">{v.category?.replace(/_/g, " ")}{v.rating ? ` · ${v.rating}/5` : ""}</p>
                  </button>
                ))}
              </div>
            )}

            {selectedVendor && (
              <p className="text-xs text-primary font-medium">Selected: {selectedVendor.name}</p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Scheduled Date *</Label>
                <Input
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  className="h-8 text-xs mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Cost (optional)</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  className="h-8 text-xs mt-1"
                />
              </div>
            </div>

            <div>
              <Label className="text-xs">Notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Special instructions…"
                className="text-xs mt-1 min-h-[60px]"
              />
            </div>

            {bookError && <p className="text-xs text-destructive">{bookError}</p>}

            <div className="flex gap-2">
              <Button size="sm" className="flex-1" onClick={handleBook} disabled={isPending}>
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                Confirm Booking
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowForm(false)} disabled={isPending}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
