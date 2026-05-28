"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Wrench, Loader2 } from "lucide-react"
import { createVendorBooking } from "@/app/actions/vendor-marketplace"

interface Vendor {
  id: string
  name: string
  category: string | null
  rating: number | null
}

interface VendorBookingButtonProps {
  listingId: string
  brokerageId: string
  vendors: Vendor[]
}

const SERVICE_TYPES = [
  "Photography",
  "Staging",
  "Inspection",
  "Appraisal",
  "Cleaning",
  "Landscaping",
  "Repairs",
  "Moving",
  "Title",
  "Escrow",
  "Other",
]

export function VendorBookingButton({
  listingId,
  brokerageId,
  vendors,
}: VendorBookingButtonProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [vendorId, setVendorId] = useState("")
  const [serviceType, setServiceType] = useState("")
  const [scheduledDate, setScheduledDate] = useState("")
  const [cost, setCost] = useState("")
  const [notes, setNotes] = useState("")

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!vendorId || !serviceType || !scheduledDate) {
      setError("Please fill in all required fields.")
      return
    }
    setError(null)

    startTransition(async () => {
      try {
        await createVendorBooking({
          vendorId,
          // listing-only bookings use listing_id, not transaction_id
          // pass listing_id via transactionId field and let server handle it
          transactionId: listingId,
          serviceType,
          scheduledDate,
          cost: cost ? Number(cost) : undefined,
          notes: notes || undefined,
        })
        setOpen(false)
        setVendorId("")
        setServiceType("")
        setScheduledDate("")
        setCost("")
        setNotes("")
        router.refresh()
      } catch (err: any) {
        setError(err.message ?? "Booking failed. Please try again.")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Wrench className="h-4 w-4" />
          Assign Vendor
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Book a Vendor</DialogTitle>
          <DialogDescription>
            Schedule a service provider for this listing. A booking record will be created with status &ldquo;booked&rdquo;.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          {/* Vendor selection */}
          <div className="space-y-1.5">
            <Label htmlFor="vendor">Vendor *</Label>
            {vendors.length > 0 ? (
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger id="vendor">
                  <SelectValue placeholder="Select a vendor" />
                </SelectTrigger>
                <SelectContent>
                  {vendors.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                      {v.category ? ` — ${v.category}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground py-2">
                No vendors in your directory.{" "}
                <a href="/dashboard/vendors" className="text-blue-600 hover:underline">
                  Add vendors
                </a>{" "}
                first.
              </p>
            )}
          </div>

          {/* Service type */}
          <div className="space-y-1.5">
            <Label htmlFor="serviceType">Service Type *</Label>
            <Select value={serviceType} onValueChange={setServiceType}>
              <SelectTrigger id="serviceType">
                <SelectValue placeholder="Select service type" />
              </SelectTrigger>
              <SelectContent>
                {SERVICE_TYPES.map((s) => (
                  <SelectItem key={s} value={s.toLowerCase()}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date */}
          <div className="space-y-1.5">
            <Label htmlFor="scheduledDate">Scheduled Date *</Label>
            <Input
              id="scheduledDate"
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
              min={new Date().toISOString().split("T")[0]}
            />
          </div>

          {/* Cost */}
          <div className="space-y-1.5">
            <Label htmlFor="cost">Estimated Cost ($)</Label>
            <Input
              id="cost"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              placeholder="Any special instructions or notes for the vendor..."
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !vendorId}>
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Booking...
                </>
              ) : (
                "Book Vendor"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
