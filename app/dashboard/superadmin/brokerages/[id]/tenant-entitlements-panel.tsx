'use client'

// Per-tenant entitlements: flip a feature for THIS tenant (trial/disable/clear) + grant/
// revoke an AI-token quota override. Superadmin-gated + audited server-side.
import { useEffect, useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, SlidersHorizontal, Zap } from 'lucide-react'
import {
  getTenantEntitlementsAction, setTenantFeatureOverrideAction, grantTenantQuotaAction, revokeTenantQuotaAction,
  type TenantEntitlements,
} from '@/app/actions/superadmin/tenant-entitlements'

export function TenantEntitlementsPanel({ brokerageId }: { brokerageId: string }) {
  const [data, setData] = useState<TenantEntitlements | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [q, setQ] = useState({ extraTokens: '', days: '30', reason: '' })

  function refresh() {
    getTenantEntitlementsAction(brokerageId).then((r) => {
      if (r.ok) setData(r.data); else setErr(r.error)
      setLoading(false)
    })
  }
  useEffect(refresh, [brokerageId])

  function flip(featureKey: string, action: 'grant_trial' | 'disable' | 'clear') {
    setErr(null)
    startTransition(async () => {
      const r = await setTenantFeatureOverrideAction({ brokerageId, featureKey, action, trialDays: 30 })
      if (!r.ok) setErr(r.error ?? 'Failed'); refresh()
    })
  }
  function grantQuota() {
    setErr(null)
    const n = Number(q.extraTokens)
    if (!Number.isFinite(n) || n <= 0) { setErr('Enter a positive token amount'); return }
    if (!q.reason.trim()) { setErr('A reason is required (audited)'); return }
    startTransition(async () => {
      const r = await grantTenantQuotaAction({ brokerageId, extraTokens: n, days: Number(q.days) || undefined, reason: q.reason })
      if (!r.ok) setErr(r.error ?? 'Failed'); else setQ({ extraTokens: '', days: '30', reason: '' })
      refresh()
    })
  }
  function revoke(id: string) {
    setErr(null)
    startTransition(async () => { const r = await revokeTenantQuotaAction(id); if (!r.ok) setErr(r.error ?? 'Failed'); refresh() })
  }

  const grouped = (data?.features ?? []).reduce<Record<string, TenantEntitlements['features']>>((acc, f) => {
    (acc[f.category] ??= []).push(f); return acc
  }, {})

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-primary" />Entitlements</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {err && <p className="text-xs text-red-600">{err}</p>}
        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">No entitlement data.</p>
        ) : (
          <>
            {/* AI quota */}
            <div className="rounded-md border bg-muted/10 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-amber-500" />AI tokens</p>
                <span className="text-xs text-muted-foreground">
                  {data.quota.limit < 0 ? 'unlimited' : `${data.quota.used.toLocaleString()} / ${data.quota.limit.toLocaleString()} (${Math.round(data.quota.percent)}%)`}
                  <Badge variant="outline" className="ml-2 text-[10px]">{data.quota.status}</Badge>
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input className="w-28 rounded border px-2 py-1 text-sm" placeholder="+ tokens" value={q.extraTokens} onChange={(e) => setQ((s) => ({ ...s, extraTokens: e.target.value }))} />
                <input className="w-20 rounded border px-2 py-1 text-sm" placeholder="days" value={q.days} onChange={(e) => setQ((s) => ({ ...s, days: e.target.value }))} />
                <input className="flex-1 min-w-[8rem] rounded border px-2 py-1 text-sm" placeholder="reason (audited)" value={q.reason} onChange={(e) => setQ((s) => ({ ...s, reason: e.target.value }))} />
                <Button size="sm" disabled={pending} onClick={grantQuota}>Grant</Button>
              </div>
              {data.grants.length > 0 && (
                <div className="mt-2 space-y-1">
                  {data.grants.map((g) => (
                    <div key={g.id} className="flex items-center gap-2 text-xs">
                      <span className="flex-1 truncate">+{g.extraTokens.toLocaleString()} · {g.reason}{g.effectiveUntil ? ` · until ${new Date(g.effectiveUntil).toLocaleDateString()}` : ' · no expiry'}</span>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => revoke(g.id)}>Revoke</Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Feature matrix */}
            <div className="space-y-3">
              {Object.entries(grouped).map(([cat, feats]) => (
                <div key={cat}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{cat}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <tbody>
                        {feats.map((f) => (
                          <tr key={f.featureKey} className="border-b last:border-0">
                            <td className="py-1.5 pr-2">
                              <span className="font-medium">{f.displayName}</span>
                              {f.superadminOnly && <Badge variant="outline" className="ml-1.5 text-[9px]">superadmin</Badge>}
                            </td>
                            <td className="py-1.5 px-2">
                              {f.override === 'grant_trial' ? <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">trial{f.trialEndsAt ? ` · ${new Date(f.trialEndsAt).toLocaleDateString()}` : ''}</Badge>
                                : f.override === 'disable' ? <Badge className="bg-red-100 text-red-800 text-[10px]">disabled</Badge>
                                : <Badge variant="outline" className="text-[10px]">{f.tierDefault ? 'tier: on' : 'tier: off'}</Badge>}
                            </td>
                            <td className="py-1.5 pl-2 text-right whitespace-nowrap">
                              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={pending} onClick={() => flip(f.featureKey, 'grant_trial')}>Trial</Button>
                              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={pending} onClick={() => flip(f.featureKey, 'disable')}>Disable</Button>
                              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={pending || !f.override} onClick={() => flip(f.featureKey, 'clear')}>Clear</Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
