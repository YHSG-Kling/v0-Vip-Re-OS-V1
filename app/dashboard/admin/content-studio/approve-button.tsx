"use client"
import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { approveContentItemAction } from "./actions"

export function ApproveReelButton({ id }: { id: string }) {
  const [pending, start] = useTransition()
  const [note, setNote] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  if (done) return <span className="text-xs text-muted-foreground">Approved ✓</span>
  return (
    <div className="flex items-center gap-2">
      {note && <span className="text-xs text-amber-600 max-w-[16rem] text-right">{note}</span>}
      <Button size="sm" variant="outline" disabled={pending}
        onClick={() => start(async () => { const r = await approveContentItemAction(id); if (r.ok) setDone(true); else setNote(r.note ?? "Couldn't approve.") })}>
        {pending ? "…" : "Approve"}
      </Button>
    </div>
  )
}
