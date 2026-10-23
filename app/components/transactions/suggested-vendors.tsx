"use client"

import { useState, useEffect, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Star, Phone, Building2, Loader2, ChevronRight } from "lucide-react"
import { getSuggestedVendorsByStage, createVendorBooking } from "@/app/actions/vendor-marketplace"
import Link from "next/link"

interface Vendor {
  id: string
  name: string
  email: string | null
  phone: string | null
  category: string | null
  rating: number | null
  brokerage_id: string | null
}

interface SuggestedVendorsProps {
  transactionId: string
  stage: string
  propertyAddress: string
}

// Map stages to service type display names
const stageServiceMap: Record<string, string> = {
  INSPECTION: "Inspectors",
  APPRAISAL: "Appraisers",
  FINANCING_PENDING: "Lenders",
}

export function SuggestedVendors({ transactionId, stage, propertyAddress }: SuggestedVendorsProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [loading, setLoading] = useState(true)

  // Booking dialog state
  const [bookingDialogOpen, setBookingDialogOpen] = useState(false)
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null)
  const [bookingDate, setBookingDate] = useState("")
  const [bookingCost, setBookingCost] = useState("")
  const [bookingNotes, setBookingNotes] = useState("")

  // Only show for relevant stages
  const serviceType = stageServiceMap[stage]
  const showComponent = !!serviceType

  useEffect(() => {
    if (!showComponent) {
      setLoading(false)
      return
    }

    async function fetchVendors() {
      try {
        const suggestedVendors = await getSuggestedVendorsByStage(stage)
        setVendors(suggestedVendors)
      } catch (error) {
        console.error("Failed to fetch suggested vendors:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchVendors()
  }, [stage, showComponent])

  if (!showComponent) return null

  const handleBookVendor = (vendor: Vendor) => {
    setSelectedVendor(vendor)
    setBookingDialogOpen(true)
  }

  const submitBooking = () => {
    if (!selectedVendor || !bookingDate) return

    startTransition(async () => {
      await createVendorBooking({
        vendorId: selectedVendor.id,
        transactionId,
        serviceType: selectedVendor.category || stage.toLowerCase(),
        scheduledDate: bookingDate,
        cost: bookingCost ? parseFloat(bookingCost) : undefined,
        notes: bookingNotes || undefined,
      })
      setBookingDialogOpen(false)
      resetForm()
      router.refresh()
    })
  }

  const resetForm = () => {
    setSelectedVendor(null)
    setBookingDate("")
    setBookingCost("")
    setBookingNotes("")
  }

  const renderStars = (rating: number | null) => {
    if (!rating) return null
    return (
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={`h-3 w-3 ${star <= rating ? "fill-yellow-400 text-yellow-400" : "text-gray-300"}`}
          />
        ))}
        <span className="ml-1 text-xs text-muted-foreground">{rating.toFixed(1)}</span>
      </div>
    )
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                Suggested {serviceType}
              </CardTitle>
              <CardDescription className="text-xs">
                Book trusted vendors for {stage.replace(/_/g, " ").toLowerCase()}
              </CardDescription>
            </div>
            <Link href="/dashboard/vendors">
              <Button variant="ghost" size="sm" className="h-7 text-xs">
                View All <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {vendors.length === 0 ? (
            <div className="text-center py-4 text-sm text-muted-foreground">
              <p>No {serviceType.toLowerCase()} found.</p>
              <Link href="/dashboard/vendors">
                <Button variant="link" size="sm" className="mt-1">
                  Browse all vendors
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {vendors.slice(0, 3).map((vendor) => (
                <div
                  key={vendor.id}
                  className="flex items-center justify-between p-2 border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{vendor.name}</span>
                      {!vendor.brokerage_id && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0">Global</Badge>
                      )}
                    </div>
                    {renderStars(vendor.rating)}
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                      {vendor.phone && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-2.5 w-2.5" />
                          {vendor.phone}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleBookVendor(vendor)}
                    className="ml-2 bg-transparent shrink-0"
                  >
                    Book
                  </Button>
                </div>
              ))}
              
              {vendors.length > 3 && (
                <Link href="/dashboard/vendors" className="block">
                  <Button variant="ghost" size="sm" className="w-full text-xs">
                    +{vendors.length - 3} more {serviceType.toLowerCase()}
                  </Button>
                </Link>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Booking Dialog */}
      <Dialog open={bookingDialogOpen} onOpenChange={setBookingDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Book {selectedVendor?.name}</DialogTitle>
            <DialogDescription>
              {propertyAddress}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Scheduled Date</Label>
              <Input
                type="date"
                value={bookingDate}
                onChange={(e) => setBookingDate(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>Estimated Cost ($)</Label>
              <Input
                type="number"
                value={bookingCost}
                onChange={(e) => setBookingCost(e.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={bookingNotes}
                onChange={(e) => setBookingNotes(e.target.value)}
                placeholder="Any special instructions..."
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setBookingDialogOpen(false)} className="bg-transparent">
              Cancel
            </Button>
            <Button
              onClick={submitBooking}
              disabled={isPending || !bookingDate}
            >
              {isPending ? "Booking..." : "Confirm Booking"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
