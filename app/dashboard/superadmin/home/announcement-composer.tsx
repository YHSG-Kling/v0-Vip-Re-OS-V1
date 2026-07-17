"use client"

// Post an internal staff announcement (admin+). Delivery fans out over the existing
// platform-staff notification rail; the list on the home page refreshes after post.
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { postPlatformAnnouncementAction } from "@/app/actions/superadmin/platform-announcements"

export function AnnouncementComposer() {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium")
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function post() {
    setMsg(null)
    startTransition(async () => {
      const r = await postPlatformAnnouncementAction({ title, body, priority })
      if (r.ok) {
        setMsg({ ok: true, text: `Announcement sent to ${r.notified} staff member${r.notified === 1 ? "" : "s"}` })
        setTitle(""); setBody(""); setPriority("medium"); setOpen(false)
        router.refresh()
      } else {
        setMsg({ ok: false, text: r.error ?? "Failed to post" })
      }
    })
  }

  return (
    <div className="space-y-2">
      {msg && <p className={"text-xs " + (msg.ok ? "text-emerald-600" : "text-red-600")}>{msg.text}</p>}
      {!open ? (
        <Button size="sm" variant="outline" onClick={() => { setOpen(true); setMsg(null) }}>Post announcement</Button>
      ) : (
        <div className="rounded-md border bg-muted/10 p-3 space-y-2">
          <input className="w-full rounded border px-2 py-1 text-sm" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="w-full rounded border px-2 py-1 text-sm" rows={3} placeholder="Message to all platform staff…" value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex items-center gap-2">
            <select className="rounded border p-1 text-xs" value={priority} onChange={(e) => setPriority(e.target.value as "low" | "medium" | "high")}>
              <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
            </select>
            <Button size="sm" disabled={pending || !title.trim() || !body.trim()} onClick={post}>{pending ? "Posting…" : "Post to all staff"}</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}
