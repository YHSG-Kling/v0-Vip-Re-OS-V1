"use client"

import { useState, useTransition } from "react"
import { Button } from "@/app/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/app/components/ui/dialog"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Textarea } from "@/app/components/ui/textarea"
import { CalendarPlus, Loader2, CheckCircle2 } from "lucide-react"
import { requestContactVendorBooking } from "@/app/actions/contact-vendor-booking"

interface Props {
  contactId: string
  vendorId: string
  vendorName: string
  defaultServiceType?: string
}

/**
 * Lets a buyer/seller in their portal request a booking from a vendor card.
 * Submits with status='booked' for the agent to confirm.
 */
export function RequestBookingButton({
  contactId,
  vendorId,
  vendorName,
  defaultServiceType = "consultation",
}: Props) {
  const [open, setOpen] = useState(false)
  const [serviceType, setServiceType] = useState(defaultServiceType)
  const [message, setMessage] = useState("")
  const [preferredTime, setPreferredTime] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [isPending, startTransition] = useTransition()

  function reset() {
    setServiceType(defaultServiceType)
    setMessage("")
    setPreferredTime("")
    setError(null)
    setDone(false)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!serviceType.trim()) {
      setError("Tell us what service you need")
      return
    }
    startTransition(async () => {
      const result = await requestContactVendorBooking({
        contactId,
        vendorId,
        serviceType: serviceType.trim(),
        message: message.trim() || undefined,
        preferredTimeWindow: preferredTime.trim() || undefined,
      })
      if (result.success) {
        setDone(true)
      } else {
        setError(result.error ?? "Submission failed")
      }
    })
  }

  return (
    <>
      <Button
        variant="default"
        size="sm"
        className="w-full gap-2"
        onClick={() => {
          reset()
          setOpen(true)
        }}
      >
        <CalendarPlus className="h-4 w-4" />
        Request Booking
      </Button>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request booking with {vendorName}</DialogTitle>
          </DialogHeader>

          {done ? (
            <div className="py-6 text-center space-y-3">
              <CheckCircle2 className="h-10 w-10 text-green-600 mx-auto" />
              <p className="text-sm font-medium">Request sent</p>
              <p className="text-xs text-muted-foreground">
                Your agent will review and confirm with {vendorName}. You'll see updates here.
              </p>
              <Button variant="outline" size="sm" onClick={() => { setOpen(false); reset() }}>
                Close
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <Label className="text-xs">Service needed</Label>
                <Input
                  value={serviceType}
                  onChange={(e) => setServiceType(e.target.value)}
                  placeholder="e.g. inspection, moving, painting"
                  className="mt-1 h-9"
                />
              </div>
              <div>
                <Label className="text-xs">Preferred time window (optional)</Label>
                <Input
                  value={preferredTime}
                  onChange={(e) => setPreferredTime(e.target.value)}
                  placeholder="e.g. weekday afternoons next week"
                  className="mt-1 h-9"
                />
              </div>
              <div>
                <Label className="text-xs">Anything else? (optional)</Label>
                <Textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Specific details, questions for the vendor, etc."
                  className="mt-1 min-h-[80px]"
                />
              </div>

              <p className="text-[11px] text-muted-foreground border-t pt-2">
                Your agent will review and confirm before the vendor is contacted.
              </p>

              {error && <p className="text-xs text-red-600">{error}</p>}

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => { setOpen(false); reset() }}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isPending}>
                  {isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Send Request
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
