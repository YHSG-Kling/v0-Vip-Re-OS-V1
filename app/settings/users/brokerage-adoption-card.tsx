"use client"

// Settings → Users → "Adopt an independent agent or team" (wave 141A). Lives on
// the Users surface because adoption is ROSTER work — the Recruiting Manager's
// side of the transfer rail (lib/kernel/brokerage-transfer.ts): a brokerage admin
// names the agent's ACCOUNT EMAIL (never a brokerage name — two tenants can share
// one), the agent consents from their own workspace, and the migration runs the
// moment they do. States are honest end-to-end: requested (waiting on the agent),
// consented / migrating (running or stalled with the step and reason), completed,
// declined, cancelled.

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, UserPlus, RefreshCw, XCircle } from "lucide-react"
import {
  getBrokerageAdoptionPanelAction, requestBrokerageAdoptionAction, cancelBrokerageAdoptionAction, retryBrokerageAdoptionAction,
  type AdoptionPanel, type TransferRequestView,
} from "@/app/actions/brokerage-transfer"

const STATUS_CLS: Record<string, string> = {
  requested: "bg-amber-50 text-amber-700 border-amber-200",
  consented: "bg-sky-50 text-sky-700 border-sky-200",
  migrating: "bg-sky-50 text-sky-700 border-sky-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  declined: "bg-gray-50 text-gray-600 border-gray-200",
  cancelled: "bg-gray-50 text-gray-600 border-gray-200",
  failed: "bg-red-50 text-red-700 border-red-200",
}

function statusLabel(r: TransferRequestView): string {
  if (r.status === "requested") return "Waiting for the agent's consent"
  if (r.status === "consented" || r.status === "migrating") return r.lastError ? `Stalled at ${r.pendingSteps[0]?.replace(/_/g, " ") ?? "a step"}` : "Migrating"
  if (r.status === "completed") return r.ready === false ? "Completed — brokerage not ready" : "Completed"
  return r.status.charAt(0).toUpperCase() + r.status.slice(1)
}

export function BrokerageAdoptionCard() {
  const [panel, setPanel] = useState<AdoptionPanel | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<"agent" | "team_lead">("agent")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const reload = () => getBrokerageAdoptionPanelAction().then((r) => { if (r.ok) { setPanel(r.panel); setLoadError(null) } else setLoadError(r.error) }).catch((e) => setLoadError((e as Error).message))
  useEffect(() => { void reload() }, [])

  if (loadError) return null // not an admin, or no tenant — the page's own gate already said so
  if (!panel || !panel.canManage) return null

  const submit = () => {
    setError(null); setNotice(null)
    startTransition(async () => {
      const r = await requestBrokerageAdoptionAction({ subjectEmail: email, targetRole: role, reason: reason || null })
      if (!r.ok) { setError(r.error); return }
      setNotice(`Request sent to ${r.request.subjectEmail ?? email}. Nothing moves until they consent from their own workspace.`)
      setEmail(""); setReason("")
      await reload()
    })
  }
  const cancel = (id: string) => startTransition(async () => { const r = await cancelBrokerageAdoptionAction({ requestId: id }); if (!r.ok) setError(r.error ?? "Could not cancel"); await reload() })
  const retry = (id: string) => startTransition(async () => {
    const r = await retryBrokerageAdoptionAction({ requestId: id })
    if (!r.ok) setError(r.error ?? "The migration is still stalled")
    else setNotice("The migration completed.")
    await reload()
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><UserPlus className="h-4 w-4" /> Adopt an independent agent or team</CardTitle>
        <CardDescription>
          An agent or team subscribing on their own can join your brokerage with their contacts, deals, listings,
          campaigns and media. Identify them by their <strong>account email</strong> — never by brokerage name, since
          unrelated workspaces can share a brand. They consent from their workspace; their individual billing stops at
          the effective time with no double billing, and their workspace is archived (never deleted).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="adopt-email">Agent&apos;s account email</Label>
            <Input id="adopt-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="agent@example.com" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="adopt-role">Seat in your brokerage</Label>
            <select id="adopt-role" value={role} onChange={(e) => setRole(e.target.value as "agent" | "team_lead")} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {panel.roles.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="adopt-reason">Note to the agent (optional)</Label>
          <Input id="adopt-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Welcome aboard — your book comes with you." maxLength={500} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={submit} disabled={pending || !email.trim()}>{pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Send adoption request</Button>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}
        </div>

        {panel.requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No adoption requests yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {panel.requests.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">{r.sourceName ?? "Independent workspace"} <span className="text-muted-foreground">· {r.subjectEmail ?? ""}</span></p>
                  <p className="text-xs text-muted-foreground">
                    as {r.targetRole.replace(/_/g, " ")} · requested {new Date(r.createdAt).toLocaleDateString()}
                    {r.completedAt ? ` · completed ${new Date(r.completedAt).toLocaleDateString()}` : ""}
                    {r.status === "completed" ? ` · ${r.counts.members ?? 0} member(s) moved` : ""}
                  </p>
                  {r.lastError ? <p className="text-xs text-red-600">{r.billingPending ? "Billing handoff pending — the workspace stays open until it completes." : r.lastError}</p> : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? ""}`}>{statusLabel(r)}</span>
                  {(r.status === "requested" || r.status === "consented") && !r.lastError ? (
                    <Button variant="ghost" size="sm" onClick={() => cancel(r.id)} disabled={pending}><XCircle className="mr-1 h-3.5 w-3.5" /> Cancel</Button>
                  ) : null}
                  {(r.status === "consented" || r.status === "migrating") && r.lastError ? (
                    <Button variant="outline" size="sm" onClick={() => retry(r.id)} disabled={pending}><RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry</Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
