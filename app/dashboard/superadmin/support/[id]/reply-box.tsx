"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { replyToTicketAction, setTicketStatusAction, assignTicketAction } from "@/app/actions/superadmin/support-console"
import type { TicketStatus } from "@/lib/support/ticket-constants"
import { statusOptionsFor } from "@/lib/kernel/status-override"
import { StatusChangeDialog, type StatusChange } from "@/components/status/status-change-dialog"

// TOMBSTONE (wave 148, lane 148I — CLAUDE.md §6): `const STATUSES = ["open", "in_progress", "resolved", "closed"] as const`
// stood here — a second spelling of the ticket vocabulary. Survivor: lib/support/ticket-constants.ts TICKET_STATUSES (the
// live CHECK), rendered through lib/kernel/status-override.ts statusOptionsFor (every value, labelled). A status pick opens
// the C23 reason dialog.

export function SupportReplyBox({ ticketId, status }: { ticketId: string; status: string }) {
  const router = useRouter()
  const [body, setBody] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [target, setTarget] = useState<TicketStatus | null>(null)
  const [pending, start] = useTransition()

  function reply() {
    if (!body.trim()) return
    setErr(null)
    start(async () => {
      const r = await replyToTicketAction({ ticketId, body })
      if (!r.ok) { setErr(r.error ?? "Failed"); return }
      setBody(""); router.refresh()
    })
  }
  function changeStatus(next: TicketStatus, change: StatusChange) {
    setErr(null)
    setTarget(null)
    start(async () => { const r = await setTicketStatusAction({ ticketId, status: next, reason: change.reason }); if (!r.ok) setErr(r.error ?? "Failed"); router.refresh() })
  }
  function assignSelf() {
    setErr(null)
    start(async () => { const r = await assignTicketAction({ ticketId, assigneeUserId: null }); if (!r.ok) setErr(r.error ?? "Failed"); router.refresh() })
  }

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <textarea
        value={body} onChange={(e) => setBody(e.target.value)} rows={3}
        placeholder="Reply to the tenant… (they'll be notified)"
        className="w-full rounded-md border p-2 text-sm"
      />
      {err && <p className="text-xs text-red-700">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={reply} disabled={pending || !body.trim()} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {pending ? "…" : "Send reply"}
        </button>
        <button onClick={assignSelf} disabled={pending} className="rounded-md border px-3 py-1.5 text-sm">Assign to me</button>
        <span className="mx-1 text-xs text-muted-foreground">Status:</span>
        {statusOptionsFor("support_ticket", status).map((o) => (
          <button key={o.value} onClick={() => setTarget(o.value as TicketStatus)} disabled={pending || !o.selectable} title={o.why ?? undefined}
            className={"rounded-md border px-2 py-1 text-xs " + (o.value === status ? "bg-slate-900 text-white" : "")}>
            {o.label}
          </button>
        ))}
      </div>
      <StatusChangeDialog
        entity="support_ticket"
        from={status}
        to={target}
        open={target !== null}
        pending={pending}
        onOpenChange={(o) => { if (!o) setTarget(null) }}
        onConfirm={(change) => { if (target) changeStatus(target, change) }}
      />
    </div>
  )
}
