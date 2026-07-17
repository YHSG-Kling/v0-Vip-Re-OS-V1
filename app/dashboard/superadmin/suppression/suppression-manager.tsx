"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, ShieldOff, Search } from "lucide-react"
import {
  listSuppressionAction,
  addSuppressionEntryAction,
  removeSuppressionEntryAction,
  type SuppressionRow,
} from "@/app/actions/superadmin/suppression"

const REASON_LABELS: Record<string, string> = {
  explicit_opt_out: "Explicit opt-out",
  tcpa_violation: "TCPA violation",
  federal_dnc: "Federal DNC",
  spam_complaint: "Spam complaint",
  litigator: "Litigator pattern",
  manual_admin: "Manual (staff)",
}

export function SuppressionManager({
  initialRows,
  total,
  canRemove,
}: {
  initialRows: SuppressionRow[]
  total: number
  canRemove: boolean
}) {
  const [rows, setRows] = useState<SuppressionRow[]>(initialRows)
  const [search, setSearch] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [notes, setNotes] = useState("")
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeReason, setRemoveReason] = useState("")
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  function runSearch() {
    setFeedback(null)
    startTransition(async () => {
      const r = await listSuppressionAction(search.trim() || undefined)
      if (!r.ok) { setFeedback({ kind: "error", message: r.error }); return }
      setRows(r.rows)
    })
  }

  function addEntry() {
    setFeedback(null)
    if (!phone.trim() && !email.trim()) {
      setFeedback({ kind: "error", message: "Provide a phone or an email" })
      return
    }
    startTransition(async () => {
      const r = await addSuppressionEntryAction({ phone: phone.trim() || null, email: email.trim() || null, notes: notes.trim() || null })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setPhone(""); setEmail(""); setNotes("")
      const refreshed = await listSuppressionAction(search.trim() || undefined)
      if (refreshed.ok) setRows(refreshed.rows)
      setFeedback({ kind: "success", message: "Added — now blocked across all subscribers and channels" })
    })
  }

  function confirmRemove(id: string) {
    setFeedback(null)
    if (removeReason.trim().length < 5) {
      setFeedback({ kind: "error", message: "Reason must be 5+ chars — removals are audited" })
      return
    }
    startTransition(async () => {
      const r = await removeSuppressionEntryAction({ id, reason: removeReason.trim() })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setRows((prev) => prev.filter((x) => x.id !== id))
      setRemovingId(null); setRemoveReason("")
      setFeedback({ kind: "success", message: "Entry removed — contact is reachable again" })
    })
  }

  return (
    <div className="space-y-4">
      {/* Add */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Add to suppression list</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2 flex-wrap">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (any format)"
              className="h-9 rounded-md border px-2 text-sm flex-1 min-w-40" aria-label="Phone" />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email"
              className="h-9 rounded-md border px-2 text-sm flex-1 min-w-40" aria-label="Email" />
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (e.g. consumer request via support)"
              className="h-9 rounded-md border px-2 text-sm flex-[2] min-w-52" aria-label="Notes" />
            <Button size="sm" onClick={addEntry} disabled={isPending}>
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Suppress"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Blocks the identifier from lead distribution and ALL outbound channels across every subscriber. Reason is recorded as “Manual (staff)”.
          </p>
        </CardContent>
      </Card>

      {/* Search + list */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm">Entries ({total})</CardTitle>
            <div className="flex items-center gap-2">
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runSearch() }}
                placeholder="Search phone or email" className="h-8 rounded-md border px-2 text-sm w-56" aria-label="Search" />
              <Button size="sm" variant="outline" onClick={runSearch} disabled={isPending}>
                <Search className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No entries{search ? " match this search" : " yet"}.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="p-2">Identifier</th>
                    <th className="p-2">Reason</th>
                    <th className="p-2">Notes</th>
                    <th className="p-2">Added</th>
                    {canRemove && <th className="p-2 text-right">Remove</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 align-top">
                      <td className="p-2 font-mono text-xs">
                        {r.phone_digits && <div>📵 …{r.phone_digits.slice(-10)}</div>}
                        {r.email && <div>✉️ {r.email}</div>}
                      </td>
                      <td className="p-2"><Badge variant="outline" className="text-xs">{REASON_LABELS[r.reason] ?? r.reason}</Badge></td>
                      <td className="p-2 text-xs text-muted-foreground max-w-56 break-words">{r.notes ?? "—"}</td>
                      <td className="p-2 text-xs text-muted-foreground whitespace-nowrap">
                        {r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}
                      </td>
                      {canRemove && (
                        <td className="p-2 text-right">
                          {removingId === r.id ? (
                            <div className="flex items-center gap-1 justify-end">
                              <input value={removeReason} onChange={(e) => setRemoveReason(e.target.value)}
                                placeholder="Reason (audited)" className="h-7 rounded-md border px-2 text-xs w-44" aria-label="Removal reason" />
                              <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => confirmRemove(r.id)} disabled={isPending}>
                                {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setRemovingId(null); setRemoveReason("") }}>×</Button>
                            </div>
                          ) : (
                            <Button size="sm" variant="ghost" className="h-7 text-xs text-red-600"
                              onClick={() => { setRemovingId(r.id); setRemoveReason("") }}>
                              <ShieldOff className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!canRemove && rows.length > 0 && (
            <p className="text-xs text-muted-foreground mt-2">Removing entries requires superadmin (it re-exposes the contact to all outreach).</p>
          )}
        </CardContent>
      </Card>

      {feedback && (
        <div className={`rounded-md border p-3 text-sm ${
          feedback.kind === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"
        }`}>
          {feedback.message}
        </div>
      )}
    </div>
  )
}
