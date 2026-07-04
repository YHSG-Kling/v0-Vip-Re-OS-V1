"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { replyToTicketAction, setTicketStatusAction, assignTicketAction } from "@/app/actions/superadmin/support-console"

const STATUSES = ["open", "in_progress", "resolved", "closed"] as const

export function SupportReplyBox({ ticketId, status }: { ticketId: string; status: string }) {
  const router = useRouter()
  const [body, setBody] = useState("")
  const [err, setErr] = useState<string | null>(null)
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
  function changeStatus(next: string) {
    setErr(null)
    start(async () => { const r = await setTicketStatusAction({ ticketId, status: next as any }); if (!r.ok) setErr(r.error ?? "Failed"); router.refresh() })
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
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={reply} disabled={pending || !body.trim()} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {pending ? "…" : "Send reply"}
        </button>
        <button onClick={assignSelf} disabled={pending} className="rounded-md border px-3 py-1.5 text-sm">Assign to me</button>
        <span className="mx-1 text-xs text-muted-foreground">Status:</span>
        {STATUSES.map((s) => (
          <button key={s} onClick={() => changeStatus(s)} disabled={pending || s === status}
            className={"rounded-md border px-2 py-1 text-xs " + (s === status ? "bg-slate-900 text-white" : "")}>
            {s.replace("_", " ")}
          </button>
        ))}
      </div>
    </div>
  )
}
