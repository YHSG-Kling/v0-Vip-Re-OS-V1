"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { removeVendorPortfolioItem } from "@/app/actions/vendor-portfolio"

/** Remove one work sample (wave 147, lane 147H) — the server action pins it to the session's own vendor. */
export function RemovePortfolioItemButton({ itemId }: { itemId: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-1">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => start(async () => {
          setError(null)
          const r = await removeVendorPortfolioItem(itemId)
          if (!r.ok) setError(r.error ?? "Could not remove it.")
          else router.refresh()
        })}
      >
        {pending ? "Removing…" : "Remove"}
      </Button>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  )
}
