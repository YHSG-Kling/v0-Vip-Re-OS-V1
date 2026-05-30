"use client"

import { useState, useTransition } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { updateListingStatus } from "@/app/actions/listings-kernel"
import { toast } from "sonner"

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "coming_soon", label: "Coming Soon" },
  { value: "pending", label: "Pending" },
  { value: "under_contract", label: "Under Contract" },
  { value: "sold", label: "Sold" },
  { value: "expired", label: "Expired" },
  { value: "withdrawn", label: "Withdrawn" },
]

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
