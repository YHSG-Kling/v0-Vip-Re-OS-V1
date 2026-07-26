"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, Trash2 } from "lucide-react"
import { setRequiredDocBlocking, removeRequiredDoc } from "@/app/actions/compliance/manage-required-docs"

/** Per-row edit controls for an active required-document rule: flip
 *  blocking↔warning and remove. Server actions enforce role/scope + brokerage. */
export function RequiredDocRowActions({ id, blockOnMissing }: { id: string; blockOnMissing: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()

  function toggle() {
    start(async () => {
      await setRequiredDocBlocking({ id, blockOnMissing: !blockOnMissing })
      router.refresh()
    })
  }
  function remove() {
    start(async () => {
      await removeRequiredDoc({ id })
      router.refresh()
    })
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      <Button variant="outline" size="sm" onClick={toggle} disabled={pending} className="text-xs">
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : blockOnMissing ? "Make warning" : "Make blocking"}
      </Button>
      <Button variant="ghost" size="sm" onClick={remove} disabled={pending} aria-label="Remove rule" className="text-red-600 hover:text-red-700">
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
