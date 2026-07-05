'use client'

// GoHighLevel-style config snapshots: capture THIS tenant's brand + voice + feature
// enablement as a template, or apply an existing template to THIS tenant. Superadmin-
// gated + audited server-side; secrets are never captured (allow-list on the server).
import { useEffect, useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Camera, Download, Trash2, Loader2 } from 'lucide-react'
import {
  captureSnapshotAction, listSnapshotsAction, applySnapshotAction, deleteSnapshotAction,
  type SnapshotRow,
} from '@/app/actions/superadmin/config-snapshots'

export function TenantSnapshotsPanel({ brokerageId }: { brokerageId: string }) {
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState('')

  function refresh() {
    listSnapshotsAction().then((r) => { if (r.ok) setSnapshots(r.snapshots); else setErr(r.error); setLoading(false) })
  }
  useEffect(refresh, [])

  function capture() {
    setErr(null); setMsg(null)
    if (!name.trim()) { setErr('Name the snapshot'); return }
    startTransition(async () => {
      const r = await captureSnapshotAction({ sourceBrokerageId: brokerageId, name })
      if (!r.ok) setErr(r.error ?? 'Capture failed'); else { setMsg(`Captured "${name}"`); setName('') }
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
          <Button size="sm" disabled={pending} onClick={capture} className="gap-1.5"><Camera className="h-3.5 w-3.5" />Capture</Button>
        </div>
        <p className="text-[11px] text-muted-foreground -mt-2">Captures branding, brand voice, and feature enablement. Secrets/credentials are never included.</p>

        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : snapshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No snapshots yet.</p>
        ) : (
          <div className="space-y-1">
            {snapshots.map((s) => (
              <div key={s.id} className="flex items-center gap-2 rounded border px-2 py-1.5 text-sm">
                <span className="flex-1 truncate">
                  <span className="font-medium">{s.name}</span>
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    {s.counts.global + s.counts.brand} brand · {s.counts.voice} voice · {s.counts.features} features
                  </span>
                  {s.sourceBrokerageId === brokerageId && <Badge variant="outline" className="ml-2 text-[9px]">from this tenant</Badge>}
                </span>
                <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" disabled={pending} onClick={() => apply(s.id, s.name)}><Download className="h-3 w-3" />Apply here</Button>
                <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={pending} onClick={() => remove(s.id)}><Trash2 className="h-3.5 w-3.5 text-red-500" /></Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
