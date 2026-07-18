'use client'

// GoHighLevel-style config snapshots: capture THIS tenant's brand + voice + feature
// enablement as a template, or apply an existing template to THIS tenant. Superadmin-
// gated + audited server-side; secrets are never captured (allow-list on the server).
import { useEffect, useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Camera, Download, Trash2, Loader2, Zap } from 'lucide-react'
import {
  captureSnapshotAction, listSnapshotsAction, applySnapshotAction, deleteSnapshotAction,
  type SnapshotRow,
} from '@/app/actions/superadmin/config-snapshots'

// SELF-SERVE FUNNEL rule (mirrors lib/platform/trial-funnel resolveNewestPerTier —
// kept inline because that module is server-only): per tier, the NEWEST snapshot
// recommending it is what a self-serve signup on that tier gets applied.
function liveFunnelIds(snapshots: SnapshotRow[]): Map<string, string> {
  const live = new Map<string, string>() // tier → winning snapshot id
  for (const s of snapshots) {
    if (!s.recommendedTier) continue
    const curId = live.get(s.recommendedTier)
    const cur = curId ? snapshots.find((x) => x.id === curId) : undefined
    if (!cur || Date.parse(s.createdAt) > Date.parse(cur.createdAt)) live.set(s.recommendedTier, s.id)
  }
  return live
}

export function TenantSnapshotsPanel({ brokerageId }: { brokerageId: string }) {
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [recTier, setRecTier] = useState('')

  function refresh() {
    listSnapshotsAction().then((r) => { if (r.ok) setSnapshots(r.snapshots); else setErr(r.error); setLoading(false) })
  }
  useEffect(refresh, [])

  function capture() {
    setErr(null); setMsg(null)
    if (!name.trim()) { setErr('Name the snapshot'); return }
    startTransition(async () => {
      const r = await captureSnapshotAction({ sourceBrokerageId: brokerageId, name, recommendedTier: recTier || undefined })
      if (!r.ok) setErr(r.error ?? 'Capture failed'); else { setMsg(`Captured "${name}"`); setName(''); setRecTier('') }
      refresh()
    })
  }
  function apply(id: string, label: string) {
    setErr(null); setMsg(null)
    startTransition(async () => {
      const r = await applySnapshotAction({ snapshotId: id, targetBrokerageId: brokerageId })
      if (!r.ok) setErr(r.error ?? 'Apply failed'); else setMsg(`Applied "${label}": ${(r.applied ?? []).join(', ') || 'nothing to apply'}`)
    })
  }
  function remove(id: string) {
    setErr(null); setMsg(null)
    startTransition(async () => { const r = await deleteSnapshotAction(id); if (!r.ok) setErr(r.error ?? 'Delete failed'); refresh() })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2"><Camera className="h-4 w-4 text-primary" />Config snapshots</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <p className="text-xs text-red-600">{err}</p>}
        {msg && <p className="text-xs text-emerald-600">{msg}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <input className="flex-1 min-w-[10rem] rounded border px-2 py-1 text-sm" placeholder="Snapshot name (captures THIS tenant)" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="rounded border px-2 py-1 text-sm bg-transparent" value={recTier} onChange={(e) => setRecTier(e.target.value)} aria-label="Recommended tier">
            <option value="">No recommended tier</option>
            <option value="solo_agent">Recommend: Solo agent</option>
            <option value="team">Recommend: Team</option>
            <option value="brokerage">Recommend: Brokerage</option>
            <option value="multi_location">Recommend: Multi-location</option>
          </select>
          <Button size="sm" disabled={pending} onClick={capture} className="gap-1.5"><Camera className="h-3.5 w-3.5" />Capture</Button>
        </div>
        <p className="text-[11px] text-muted-foreground -mt-2">Captures branding, brand voice, public-site content, and feature enablement. Secrets/credentials are never included. The recommended tier is preselected when provisioning a new subscriber from the snapshot.</p>

        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : snapshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No snapshots yet.</p>
        ) : (() => {
          const live = liveFunnelIds(snapshots)
          return (
            <div className="space-y-1">
              {snapshots.map((s) => {
                const isLive = !!s.recommendedTier && live.get(s.recommendedTier) === s.id
                return (
                  <div key={s.id} className="flex items-center gap-2 rounded border px-2 py-1.5 text-sm">
                    <span className="flex-1 truncate">
                      <span className="font-medium">{s.name}</span>
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {s.counts.global + s.counts.brand} brand · {s.counts.voice} voice · {s.counts.site} site · {s.counts.features} features
                      </span>
                      {s.recommendedTier && <Badge variant="secondary" className="ml-2 text-[9px]">recommended: {s.recommendedTier}</Badge>}
                      {isLive && (
                        <Badge className="ml-2 text-[9px] bg-emerald-100 text-emerald-800 hover:bg-emerald-100 gap-0.5">
                          <Zap className="h-2.5 w-2.5" />Funnel: live for {s.recommendedTier}
                        </Badge>
                      )}
                      {s.recommendedTier && !isLive && (
                        <Badge variant="outline" className="ml-2 text-[9px] text-muted-foreground">funnel: superseded</Badge>
                      )}
                      {s.sourceBrokerageId === brokerageId && <Badge variant="outline" className="ml-2 text-[9px]">from this tenant</Badge>}
                    </span>
                    <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" disabled={pending} onClick={() => apply(s.id, s.name)}><Download className="h-3 w-3" />Apply here</Button>
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={pending} onClick={() => remove(s.id)}><Trash2 className="h-3.5 w-3.5 text-red-500" /></Button>
                  </div>
                )
              })}
              {live.size > 0 && (
                <p className="text-[11px] text-muted-foreground pt-1">
                  <Zap className="h-3 w-3 inline mr-0.5 text-emerald-600" />
                  Funnel = what a self-serve /get-started signup on that tier gets applied automatically. Newest snapshot per tier wins.
                </p>
              )}
            </div>
          )
        })()}
      </CardContent>
    </Card>
  )
}
