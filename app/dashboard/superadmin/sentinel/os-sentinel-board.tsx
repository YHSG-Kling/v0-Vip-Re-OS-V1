'use client'

// The OS Sentinel board — one glance at the state of the whole agentic OS.
// Subsystem status tiles (green/amber/red) + top open incidents + the self-heal
// rate + red-team posture, each linking to the existing console that owns it.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Activity, Loader2, ShieldCheck, ShieldAlert, ShieldX, Wrench } from 'lucide-react'
import { getOsHealthAction } from '@/app/actions/superadmin/os-sentinel'
import type { OsHealth, SubsystemStatus } from '@/lib/platform/os-sentinel'

const STATUS_STYLE: Record<SubsystemStatus, { badge: string; dot: string; label: string }> = {
  ok:     { badge: 'bg-emerald-100 text-emerald-800', dot: 'bg-emerald-500', label: 'OK' },
  warn:   { badge: 'bg-amber-100 text-amber-800',     dot: 'bg-amber-500',   label: 'Warning' },
  breach: { badge: 'bg-red-100 text-red-800',         dot: 'bg-red-500',     label: 'Breach' },
}

function OverallIcon({ status }: { status: SubsystemStatus }) {
  if (status === 'ok') return <ShieldCheck className="h-6 w-6 text-emerald-600" />
  if (status === 'warn') return <ShieldAlert className="h-6 w-6 text-amber-600" />
  return <ShieldX className="h-6 w-6 text-red-600" />
}

export function OsSentinelBoard() {
  const [health, setHealth] = useState<OsHealth | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  function refresh() {
    setLoading(true)
    getOsHealthAction().then((r) => {
      if (r.ok) { setHealth(r.data); setErr(null) } else setErr(r.error)
      setLoading(false)
    })
  }
  useEffect(refresh, [])

  if (loading && !health) {
    return <p className="p-6 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Reading the state of the OS…</p>
  }
  if (err) return <p className="p-6 text-sm text-red-600">{err}</p>
  if (!health) return null

  const overall = STATUS_STYLE[health.overall]

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2"><Activity className="h-5 w-5 text-primary" />OS Sentinel</CardTitle>
          <div className="flex items-center gap-2">
            <OverallIcon status={health.overall} />
            <Badge className={`text-xs ${overall.badge}`}>OS {overall.label}</Badge>
            <button onClick={refresh} className="text-xs text-muted-foreground underline">refresh</button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {health.subsystems.map((s) => {
              const st = STATUS_STYLE[s.status]
              return (
                <Link key={s.key} href={s.link} className="rounded-lg border p-3 hover:bg-muted/30 transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{s.label}</span>
                    <span className={`h-2.5 w-2.5 rounded-full ${st.dot}`} />
                  </div>
                  <p className="mt-1 text-lg font-bold">{s.count}</p>
                  <p className="text-[11px] text-muted-foreground">{s.detail}</p>
                </Link>
              )
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><Wrench className="h-3.5 w-3.5" />Self-heal (24h): {health.selfHeal.replayed} replayed · {health.selfHeal.escalated} escalated · {health.selfHeal.runs} runs</span>
            <span>Red-team: {health.redTeam.lastRegressionAt ? `⚠ regression ${health.redTeam.lastRegressionAt.slice(0, 10)}` : '✓ no recent regression'}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Top open incidents</CardTitle></CardHeader>
        <CardContent>
          {health.topIncidents.length === 0 ? (
            <p className="text-sm text-emerald-600">Nothing open — the OS is healthy.</p>
          ) : (
            <ul className="space-y-1.5">
              {health.topIncidents.map((inc, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[inc.severity].dot}`} />
                  <span><span className="text-[11px] uppercase text-muted-foreground mr-2">{inc.subsystem}</span>{inc.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
