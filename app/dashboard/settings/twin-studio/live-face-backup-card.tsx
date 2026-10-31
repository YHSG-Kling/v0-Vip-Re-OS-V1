"use client"

// Lane 86H — the brokerage's live-avatar face fail-over (brokerage_settings.
// live_agent_face_provider_order), next to the twins that face renders. The column was read
// by both live session doors (portal + embed) and written by nobody, so every brokerage ran
// the m627 default forever. The doors always start the primary face first and consult this
// list only when it fails, so the one real choice is WHICH BACKUP legs may catch that
// failure — that is what this card offers (the server refuses any order the doors would not
// honour; see validateFaceProviderOrder). Tenant admins only: the Twin Studio page renders it
// only when getLiveFaceProviderSettingAction passed its gate, and the save re-runs that gate.
import { useState, useTransition } from "react"
import { Check, Loader2, MonitorPlay } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { saveLiveFaceProviderOrderAction } from "@/app/actions/settings/brokerage-column-settings"

export interface LiveFaceBackupInitial {
  canEdit: boolean
  /** The order the session doors use today (normalized by the reader). */
  order: string[]
  /** The reader's vocabulary in its default order — the primary is first. */
  providers: Array<{ id: string; label: string }>
}

export function LiveFaceBackupCard({ initial }: { initial: LiveFaceBackupInitial }) {
  const primary = initial.providers[0]
  const backups = initial.providers.slice(1)
  const [order, setOrder] = useState<string[]>(initial.order)
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(initial.order.filter((id) => id !== primary?.id)))
  const [pending, startTransition] = useTransition()

  if (!primary) return null

  const nextOrder = [primary.id, ...backups.map((b) => b.id).filter((id) => enabled.has(id))]
  const dirty = nextOrder.join(",") !== order.join(",")

  const save = () =>
    startTransition(async () => {
      const r = await saveLiveFaceProviderOrderAction(nextOrder)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      setOrder(r.order)
      setEnabled(new Set(r.order.filter((id) => id !== primary.id)))
      toast.success("Live avatar fail-over saved")
    })

  const labelOf = (id: string) => initial.providers.find((p) => p.id === id)?.label ?? id

  return (
    <Card className="mt-10">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <MonitorPlay className="h-4 w-4 text-primary" />
          Live avatar fail-over (brokerage-wide)
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          When a client opens a live conversation with a twin in their portal or on an embedded site, the{" "}
          {primary.label.toLowerCase()} starts first. If it cannot start, the backups you allow here are tried
          in turn before the conversation falls back to text chat.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs">
          Current order: <strong>{order.map(labelOf).join(" → ")} → text chat</strong>
        </p>
        <ul className="space-y-2">
          <li className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked disabled aria-label={primary.label} />
            {primary.label} — always tried first
          </li>
          {backups.map((b) => (
            <li key={b.id} className="flex items-center gap-2 text-xs">
              <input
                id={`live-face-${b.id}`}
                type="checkbox"
                checked={enabled.has(b.id)}
                disabled={!initial.canEdit || pending}
                onChange={(e) => {
                  const next = new Set(enabled)
                  if (e.target.checked) next.add(b.id)
                  else next.delete(b.id)
                  setEnabled(next)
                }}
              />
              <label htmlFor={`live-face-${b.id}`}>{b.label}</label>
            </li>
          ))}
        </ul>
        <Button size="sm" disabled={!initial.canEdit || pending || !dirty} onClick={save}>
          {pending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
          Save
        </Button>
        {!initial.canEdit && (
          <p className="text-xs text-muted-foreground">Read-only access — switch to full access to change this.</p>
        )}
      </CardContent>
    </Card>
  )
}
