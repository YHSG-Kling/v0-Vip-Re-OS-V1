"use client"

// The archive control on the internal listing record (wave 147, lane 147Z — lane 147F "Still open": app/actions/listings.ts
// archiveListing / unarchiveListing had no UI caller). Owner ruling 8: archived is INTERNAL (history, transactions, reporting)
// and hidden from every public page, feed and search; nothing is deleted — the action keeps every retained row and the way back
// is built. Rendered only where the record page already grants override authority (the brokerage's admin roster); the actions
// re-check the session's tenant themselves. Palette tokens only (test:ui-palette-contrast).

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { archiveListing, unarchiveListing } from "@/app/actions/listings"
import { Button } from "@/components/ui/button"

export function ArchiveListingControl({ listingId, archived }: { listingId: string; archived: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState<string | null>(null)

  const run = () => {
    const sure = archived
      ? window.confirm("Restore this listing? It returns to the working board; public pages show it again only if its status is public.")
      : window.confirm("Archive this listing? It stays in history, transactions and reporting, and leaves every public page, feed and search. Nothing is deleted.")
    if (!sure) return
    startTransition(async () => {
      const r = archived ? await unarchiveListing(listingId) : await archiveListing(listingId)
      if (!r || (r as { success?: boolean }).success !== true) {
        setNote((r as { error?: string } | null)?.error ?? "That did not go through — nothing was changed.")
        return
      }
      setNote(archived ? "Restored." : "Archived — kept for history; hidden from public pages.")
      router.refresh()
    })
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={run}>
        {pending ? "Working…" : archived ? "Restore listing" : "Archive listing"}
      </Button>
      {note && <span role="status" className="text-xs text-muted-foreground">{note}</span>}
    </div>
  )
}
