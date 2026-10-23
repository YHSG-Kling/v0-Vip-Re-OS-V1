"use client"

import { useState, useTransition } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { updateListingStatus } from "@/app/actions/listings-kernel"
import { toast } from "sonner"
import { LISTING_STATUSES, LISTING_STATUS_LABELS } from "@/lib/constants"

// DERIVED, NOT RESTATED. This was its own list of 7, and it offered
// "under_contract" — a TRANSACTION status that listings.status does not admit,
// so picking it produced a rejected write and a "Failed to update status"
// toast. It also omitted four real phases (listing_signed, off_market,
// cancelled, draft). Both problems are the same problem: a second vocabulary.
// The phases now come from lib/constants, which matches the column's CHECK.
const STATUS_OPTIONS = LISTING_STATUSES.map((value) => ({
  value,
  label: LISTING_STATUS_LABELS[value],
}))

interface ListingStatusSelectProps {
  listingId: string
  currentStatus: string
}

export function ListingStatusSelect({ listingId, currentStatus }: ListingStatusSelectProps) {
  const [status, setStatus] = useState(currentStatus)
  const [isPending, startTransition] = useTransition()

  const handleChange = (newStatus: string) => {
    const prev = status
    setStatus(newStatus)
    startTransition(async () => {
      const result = await updateListingStatus(listingId, newStatus)
      if (result?.success === false) {
        setStatus(prev)
        toast.error("Failed to update status")
      } else {
        toast.success("Status updated")
      }
    })
  }

  return (
    <Select value={status} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger
        className="h-7 text-xs w-36 border-0 bg-transparent hover:bg-muted focus:ring-0 focus:ring-offset-0"
        onClick={(e) => e.preventDefault()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUS_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className="text-xs">
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
