'use client'

// PER-TENANT AUTONOMY HALT (cert blocker #3) — the staff lever that pauses ALL autonomous AI
// manager sends for THIS tenant, sitting between the platform god switch and the tenant's own
// broker-set posture. Reason required (audited 'tenant.autonomy_halted'/'tenant.autonomy_resumed'
// and shown verbatim on the tenant's Command Center banner). Human-approved sends are unaffected.
import { useEffect, useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, PauseOctagon, Play } from 'lucide-react'
import {
  getTenantAutonomyStateAction, setTenantAutonomyHaltAction, type TenantAutonomyState,
} from '@/app/actions/superadmin/tenant-entitlements'

export function TenantAutonomyPanel({ brokerageId }: { brokerageId: string }) {
  const [state, setState] = useState<TenantAutonomyState | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()

  function refresh() {
    getTenantAutonomyStateAction(brokerageId).then((r) => {
      if (r.ok) setState(r.data); else setErr(r.error)
      setLoading(false)
    })
  }
  useEffect(refresh, [brokerageId])

  function toggle(halt: boolean) {
    setErr(null)
    if (!reason.trim()) { setErr('A reason is required — it is audited and shown to the tenant.'); return }
    startTransition(async () => {
      const r = await setTenantAutonomyHaltAction({ brokerageId, halt, reason })
      if (!r.ok) setErr(r.error ?? 'Failed'); else setReason('')
      refresh()
    })
  }

  return (
    <Card className={state?.halted ? 'border-amber-300' : undefined}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <PauseOctagon className="h-4 w-4 text-amber-600" />
          Autonomy
          {state && (state.halted
            ? <Badge className="bg-amber-100 text-amber-800 text-[10px]">HALTED</Badge>
            : <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">running</Badge>)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {err && <p className="text-xs text-red-600">{err}</p>}
        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground max-w-2xl">
              Halting pauses every <span className="font-medium">autonomous</span> AI manager send for this tenant at the
              dispatch gate — below the platform god switch, above the broker&apos;s own posture (the tenant cannot lift it).
              Approved / human-sent messages are unaffected. The tenant sees the reason on their Command Center.
            </p>
            {state?.halted && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs">
                <span className="font-medium">Halted{state.haltedAt ? ` ${new Date(state.haltedAt).toLocaleString()}` : ''}:</span>{' '}
                {state.reason ?? 'No reason recorded.'}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="flex-1 min-w-[14rem] rounded border px-2 py-1 text-sm"
                placeholder={state?.halted ? 'Reason for resuming (audited)' : 'Reason for halting (audited + shown to tenant)'}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              {state?.halted ? (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => toggle(false)}>
                  <Play className="h-3.5 w-3.5 mr-1" />Resume autonomy
                </Button>
              ) : (
                <Button size="sm" variant="destructive" disabled={pending} onClick={() => toggle(true)}>
                  <PauseOctagon className="h-3.5 w-3.5 mr-1" />Halt autonomy
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
