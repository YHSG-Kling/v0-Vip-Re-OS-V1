"use client"

// Tenant-side ticket conversation — view the support thread + reply, from the help UI. Two-way with the
// platform support console.
import { useState, useTransition } from "react"
import { replyToMyTicket, getMyTicketThread } from "@/app/actions/support"
import type { TicketThread as Thread } from "@/lib/support/support-thread"

export function TicketThread({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false)
  const [thread, setThread] = useState<Thread | null>(null)
  const [body, setBody] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && !thread) getMyTicketThread(ticketId).then(setThread)
  }
  function reply() {
    if (!body.trim()) return
    setErr(null)
    start(async () => {
      const r = await replyToMyTicket({ ticketId, body })
      if (!r.ok) { setErr(r.error ?? "Failed"); return }
      setBody("")
      const t = await getMyTicketThread(ticketId); setThread(t)
    })
  }

  return (
    <div className="mt-2">
      <button onClick={toggle} className="text-xs font-medium text-indigo-600 hover:underline">
        {open ? "Hide conversation" : "View conversation & reply"}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {thread === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : thread.messages.length === 0 ? (
            <p className="text-xs text-muted-foreground">No replies yet.</p>
          ) : thread.messages.map((m) => (
            <div key={m.id} className={"rounded border p-2 text-sm " + (m.authorKind === "staff" ? "bg-indigo-50/60 border-indigo-200" : "bg-white")}>
              <p className="text-[11px] font-medium text-muted-foreground mb-0.5">{m.authorKind === "staff" ? "Support" : "You"} · {new Date(m.createdAt).toLocaleString()}</p>
              <p className="whitespace-pre-wrap">{m.body}</p>
            </div>
          ))}
          <div className="flex items-start gap-2">
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="Reply to support…" className="flex-1 rounded-md border p-2 text-sm" />
            <button onClick={reply} disabled={pending || !body.trim()} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Send</button>
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
      )}
    </div>
  )
}
