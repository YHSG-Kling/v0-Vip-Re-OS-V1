"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import {
  Radar, Send, X, Edit, Loader2, AlertTriangle, Mail, Phone, Clock, CheckCircle2,
  Sparkles, User as UserIcon,
} from "lucide-react"
import { approveSphereTouch, updateSphereMessage, dismissSphereTouch, type SphereRow, type SphereLoad } from "./actions"

interface Props {
  data: SphereLoad
}

const fmtRelative = (iso: string) => {
  const d = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(d / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const fmtUntil = (iso: string) => {
  const d = new Date(iso).getTime() - Date.now()
  const mins = Math.floor(d / 60_000)
  if (mins <= 0) return "ready now"
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `in ${hrs}h`
  return `in ${Math.floor(hrs / 24)}d`
}

export function SphereClient({ data }: Props) {
  const router = useRouter()

  return (
    <div className="container max-w-5xl mx-auto py-6 px-4">
      <div className="mb-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1 mb-1">
          <Radar className="h-3 w-3" /> Sphere Resonance
        </p>
        <h1 className="text-2xl font-bold tracking-tight">Who&apos;s hot in your sphere right now</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Past clients and your warm network with detected life events. Warm-network outreach converts higher than any other lead source &mdash; act on what&apos;s here.
        </p>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard icon={Clock}  label="Auto-queued"  count={data.pendingAuto.length} tone="indigo" />
        <StatCard icon={AlertTriangle} label="Needs action" count={data.needsAction.length} tone="amber" />
        <StatCard icon={CheckCircle2}  label="Sent (30d)"    count={data.sent.length}         tone="emerald" />
        <StatCard icon={X}            label="Dismissed"      count={data.cancelled.length}    tone="slate" />
      </div>

      {data.needsAction.length === 0 && data.pendingAuto.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center space-y-2">
            <Radar className="h-10 w-10 text-indigo-600 mx-auto" />
            <p className="text-base font-medium">No active sphere signals.</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              The daily resonance scan picks up life events on past clients automatically (job changes, marriage, new baby, retirement, kids graduated, etc.). You&apos;ll see actionable cards here when there&apos;s something to do.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Needs action — render first because it's actionable */}
      {data.needsAction.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Needs your action ({data.needsAction.length})
          </h2>
          <div className="space-y-3">
            {data.needsAction.map(row => (
              <SphereCard key={row.id} row={row} onRefresh={() => router.refresh()} />
            ))}
          </div>
        </section>
      )}

      {/* Auto-queued — review window before automatic send */}
      {data.pendingAuto.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <Clock className="h-4 w-4 text-indigo-600" />
            Auto-queued ({data.pendingAuto.length}) <span className="text-[10px] text-muted-foreground">— sending soon unless dismissed</span>
          </h2>
          <div className="space-y-3">
            {data.pendingAuto.map(row => (
              <SphereCard key={row.id} row={row} onRefresh={() => router.refresh()} />
            ))}
          </div>
        </section>
      )}

      {/* Recent sent + dismissed history */}
      {(data.sent.length > 0 || data.cancelled.length > 0) && (
        <section>
          <h2 className="text-sm font-semibold mb-2 flex items-center gap-2 text-muted-foreground">
            Recent history
          </h2>
          <Card>
            <CardContent className="py-3 divide-y">
              {[...data.sent, ...data.cancelled].slice(0, 20).map(row => (
                <HistoryRow key={row.id} row={row} />
              ))}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  )
}

function StatCard({ icon: Icon, label, count, tone }: { icon: any; label: string; count: number; tone: string }) {
  const toneClasses: Record<string, string> = {
    indigo:  "border-indigo-200 bg-indigo-50/40",
    amber:   "border-amber-200 bg-amber-50/30",
    emerald: "border-emerald-200 bg-emerald-50/30",
    slate:   "border-slate-200 bg-slate-50/30",
  }
  const iconClasses: Record<string, string> = {
    indigo:  "text-indigo-600",
    amber:   "text-amber-600",
    emerald: "text-emerald-600",
    slate:   "text-slate-500",
  }
  return (
    <Card className={toneClasses[tone]}>
      <CardContent className="py-3 px-3 flex items-center gap-2">
        <Icon className={`h-4 w-4 ${iconClasses[tone]}`} />
        <div>
          <p className="text-xl font-bold leading-none">{count}</p>
          <p className="text-[10px] uppercase text-muted-foreground tracking-wide mt-0.5">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function SphereCard({ row, onRefresh }: { row: SphereRow; onRefresh: () => void }) {
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState(false)
  const [draftBody, setDraftBody] = useState(row.messageBody ?? "")
  const [dismissOpen, setDismissOpen] = useState(false)
  const [dismissReason, setDismissReason] = useState("")

  const eventLabel = row.primarySignal?.label ?? "Life event"
  const sourceLabel = row.primarySignal?.source ?? null

  function handleApprove() {
    startTransition(async () => {
      const r = await approveSphereTouch(row.id)
      if (r.success) {
        toast.success("Approved — sending shortly")
        onRefresh()
      } else toast.error(r.error ?? "Failed")
    })
  }

  function handleSaveEdit() {
    startTransition(async () => {
      const r = await updateSphereMessage(row.id, draftBody)
      if (r.success) {
        toast.success("Message updated")
        setEditing(false)
        onRefresh()
      } else toast.error(r.error ?? "Failed")
    })
  }

  function handleDismiss() {
    startTransition(async () => {
      const r = await dismissSphereTouch(row.id, dismissReason)
      if (r.success) {
        toast.success("Dismissed")
        setDismissOpen(false)
        onRefresh()
      } else toast.error(r.error ?? "Failed")
    })
  }

  return (
    <Card className={row.isSensitive ? "border-amber-300" : ""}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <CardTitle className="text-base font-semibold flex items-center gap-2 flex-wrap">
              <UserIcon className="h-4 w-4 text-indigo-600 shrink-0" />
              <span className="truncate">{row.contactName}</span>
              <Badge variant="outline" className="text-[10px]">{eventLabel}</Badge>
              {row.isSensitive && <Badge className="bg-amber-600 text-[10px]">Sensitive &mdash; manual only</Badge>}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
              {row.contactEmail && <span className="flex items-center gap-0.5"><Mail className="h-3 w-3" /> {row.contactEmail}</span>}
              {row.contactPhone && <span className="flex items-center gap-0.5"><Phone className="h-3 w-3" /> {row.contactPhone}</span>}
              <span>· detected {fmtRelative(row.createdAt)}</span>
              {sourceLabel && <span>· via {sourceLabel}</span>}
            </p>
          </div>
          {row.scheduledSendAt && row.actionType === "auto_touch" && !row.isSensitive && (
            <Badge variant="outline" className="text-[10px] shrink-0">Auto-sends {fmtUntil(row.scheduledSendAt)}</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {row.isSensitive ? (
          <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded p-3">
            <p className="font-medium mb-1">{eventLabel} — handle personally.</p>
            <p className="text-xs">No AI message generated. The platform recognizes this event but recommends a personal note or call rather than an automated touch.</p>
          </div>
        ) : editing ? (
          <div className="space-y-2">
            <Textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              rows={5}
              className="text-sm"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSaveEdit} disabled={pending}>
                {pending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null} Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraftBody(row.messageBody ?? "") }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          row.messageBody ? (
            <div className="text-sm leading-relaxed bg-slate-50 border rounded p-3 whitespace-pre-wrap">
              <Sparkles className="h-3 w-3 inline mr-1 text-indigo-600" />
              {row.messageBody}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">No message draft yet.</p>
          )
        )}

        {!row.isSensitive && !editing && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={handleApprove} disabled={pending || !row.messageBody}>
              {pending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
              Send now
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={pending}>
              <Edit className="h-3 w-3 mr-1" /> Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissOpen(v => !v)} disabled={pending}>
              <X className="h-3 w-3 mr-1" /> Dismiss
            </Button>
          </div>
        )}

        {row.isSensitive && (
          <Button size="sm" variant="ghost" onClick={() => setDismissOpen(v => !v)} disabled={pending}>
            <X className="h-3 w-3 mr-1" /> Mark handled
          </Button>
        )}

        {dismissOpen && (
          <div className="border rounded p-2 bg-slate-50 space-y-2">
            <p className="text-xs text-muted-foreground">Reason (helps the AI learn — optional)</p>
            <Textarea
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
              placeholder="e.g. already reached out by phone, not relevant, wrong contact"
              rows={2}
              className="text-sm"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={handleDismiss} disabled={pending}>
                {pending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null} Confirm dismiss
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDismissOpen(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function HistoryRow({ row }: { row: SphereRow }) {
  return (
    <div className="py-2 flex items-center justify-between gap-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{row.contactName}</p>
        <p className="text-[10px] text-muted-foreground">
          {row.primarySignal?.label ?? "Life event"} ·{" "}
          {row.status === "sent" ? `sent ${fmtRelative(row.sentAt ?? row.createdAt)}` :
           row.status === "cancelled" ? `dismissed ${fmtRelative(row.cancelledAt ?? row.createdAt)}${row.cancelReason ? ` (${row.cancelReason})` : ""}` :
           row.status}
        </p>
      </div>
      <Badge variant="outline" className="text-[9px] shrink-0">{row.status}</Badge>
    </div>
  )
}
