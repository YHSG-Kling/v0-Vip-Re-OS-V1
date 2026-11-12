"use client"

import { useState, useTransition } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { updateListingStatus } from "@/app/actions/listings-kernel"
import { toast } from "sonner"
import { LISTING_STATUSES, LISTING_STATUS_LABELS } from "@/lib/constants"
import { isManuallySettableListingStatus } from "@/lib/listings/listing-status-sync"
import { StatusChangeDialog, type StatusChange } from "@/components/status/status-change-dialog"

// DERIVED, NOT RESTATED. This was its own list of 7, and it offered
// "under_contract" — a TRANSACTION status that listings.status does not admit,
// so picking it produced a rejected write and a "Failed to update status"
// toast. It also omitted four real phases (listing_signed, off_market,
// cancelled, draft). Both problems are the same problem: a second vocabulary.
// The phases now come from lib/constants, which matches the column's CHECK.
// C12 (wave 147, lane 147F): Coming Soon, Listing Signed and Active are reached only through their gated doors (the
// agreement, its compliance gate, the MLS-live event). They still DISPLAY as the current value, but cannot be picked —
// the server refuses them too (app/actions/listings-kernel.ts updateListingStatus).
// C23 (wave 148, lane 148I — owner ruling 13): EVERY value is shown (a gated one disabled, with why); picking a manual one
// opens the reason dialog (proof for Sold), and the server door asks the same decision (decideStatusOverride).
const STATUS_OPTIONS = LISTING_STATUSES.map((value) => ({
  value,
  label: LISTING_STATUS_LABELS[value],
  gated: !isManuallySettableListingStatus(value),
}))

interface ListingStatusSelectProps {
  listingId: string
  currentStatus: string
}

export function ListingStatusSelect({ listingId, currentStatus }: ListingStatusSelectProps) {
  const [status, setStatus] = useState(currentStatus)
  const [target, setTarget] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const apply = (newStatus: string, change: StatusChange) => {
    const prev = status
    setStatus(newStatus)
    setTarget(null)
    startTransition(async () => {
      const result = await updateListingStatus(listingId, newStatus, change)
      if (result?.success === false) {
        setStatus(prev)
        toast.error(result.error ?? "Failed to update status")
      } else {
        toast.success("Status updated — the reason is on the record")
      }
    })
  }

  return (
    <>
      <Select value={status} onValueChange={(v) => { if (v !== status) setTarget(v) }} disabled={isPending}>
        <SelectTrigger
          className="h-7 text-xs w-36 border-0 bg-transparent hover:bg-muted focus:ring-0 focus:ring-offset-0"
          onClick={(e) => e.preventDefault()}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="text-xs" disabled={opt.gated && opt.value !== status}>
              {opt.label}{opt.gated && opt.value !== status ? " (set by its gate)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <StatusChangeDialog
        entity="listing"
        from={status}
        to={target}
        open={target !== null}
        pending={isPending}
        onOpenChange={(o) => { if (!o) setTarget(null) }}
        onConfirm={(change) => { if (target) apply(target, change) }}
      />
    </>
  )
}
