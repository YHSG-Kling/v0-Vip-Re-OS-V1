"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, X, Clock, CheckCircle2, AlertTriangle } from "lucide-react"
import { revokeInvitationAction, type InvitationRow } from "@/app/actions/admin/invitations"

function defaultStatusBadge(s: string) {
  switch (s) {
    case "pending":  return <Badge className="bg-amber-100 text-amber-800"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
    case "accepted": return <Badge className="bg-emerald-100 text-emerald-800"><CheckCircle2 className="h-3 w-3 mr-1" />Accepted</Badge>
    case "expired":  return <Badge className="bg-slate-100 text-slate-700"><AlertTriangle className="h-3 w-3 mr-1" />Expired</Badge>
    case "revoked":  return <Badge className="bg-red-100 text-red-800"><X className="h-3 w-3 mr-1" />Revoked</Badge>
    default:         return <Badge variant="outline">{s}</Badge>
  }
}

export function InvitationsTable({
  initialRows,
  statusBadge = defaultStatusBadge,
}: {
  initialRows: InvitationRow[]
  statusBadge?: (s: string) => React.ReactNode
}) {
  const [rows, setRows] = useState<InvitationRow[]>(initialRows)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleRevoke(id: string) {
    setFeedback(null)
    setPendingId(id)
    startTransition(async () => {
      const r = await revokeInvitationAction(id)
      setPendingId(null)
      if (!r.ok) { setFeedback(`Revoke failed: ${r.error}`); return }
      setRows(prev => prev.map(row => row.id === id ? { ...row, status: "revoked" } : row))
      setFeedback("Invitation revoked.")
    })
  }

  if (rows.length === 0) {
    return <p className="p-6 text-center text-sm text-muted-foreground">No invitations issued yet.</p>
  }

  return (
    <div>
      {feedback && (
        <div className="mx-4 my-3 text-xs rounded border bg-muted/30 px-3 py-1.5">{feedback}</div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/10">
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">User</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">Role</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">Invited by</th>
              <th className="text-center px-4 py-2 font-medium text-muted-foreground">Status</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">Expires</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="border-b last:border-0 hover:bg-muted/10">
                <td className="px-4 py-2.5">
                  <div className="font-medium">{[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}</div>
                  <div className="text-xs text-muted-foreground">{r.email}</div>
                </td>
                <td className="px-4 py-2.5 text-xs">
                  <Badge variant="outline">{r.user_type}</Badge>
                </td>
                <td className="px-4 py-2.5 text-xs">{r.invited_by_name ?? "—"}</td>
                <td className="px-4 py-2.5 text-center">{statusBadge(r.status)}</td>
                <td className="px-4 py-2.5 text-right text-xs">
                  {r.status === "pending"
                    ? `${r.days_until_expiry ?? 0}d`
                    : r.accepted_at
                    ? <span className="text-emerald-700">{new Date(r.accepted_at).toLocaleDateString()}</span>
                    : "—"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {r.status === "pending" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isPending && pendingId === r.id}
                      onClick={() => handleRevoke(r.id)}
                    >
                      {isPending && pendingId === r.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <><X className="h-3.5 w-3.5 mr-1" />Revoke</>}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
