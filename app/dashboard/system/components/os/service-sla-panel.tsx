'use client'

// app/dashboard/system/components/os/service-sla-panel.tsx
// Input contract:  brokerageId (re-fetch key only — every read is tenant-scoped
//                  SERVER-side by app/actions/system-health.ts, never by this prop)
// Output contract: renders the SERVER's verdict for five health readers.
// Tables read:     none directly. All reads go through server actions.
// Tables written:  none.
//
// HONESTY CONTRACT — the whole reason this panel exists:
// every reader returns { status: 'ok' | 'empty' | 'unavailable' }. A number is
// rendered ONLY under status === 'ok'. 'empty' says nothing was collected and
// names the collector; 'unavailable' says the read was refused or forbidden.
// There is deliberately no branch that turns a missing measurement into 0, or
// into 100%.

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Activity, Download, Gauge, HelpCircle, ShieldAlert, Timer } from 'lucide-react'
import {
  getServiceStatuses,
  getServiceHealthHistory,
  getUptimeHistory,
  getResponseTimeLogs,
  getMessageProviderStats,
  exportSLAReport,
  type ServiceStatus,
  type HealthCheck,
  type HealthCheckHistory,
  type ApiResponseLog,
  type MessageProviderSummary,
  type SLAReportFile,
  type HealthRead,
} from '@/app/actions/system-health'

interface ServiceSLAPanelProps {
  brokerageId: string
}

type Loadable<T> = { phase: 'idle' } | { phase: 'loading' } | { phase: 'done'; read: HealthRead<T> }

const IDLE = { phase: 'idle' } as const
const LOADING = { phase: 'loading' } as const

/** Renders the non-ok half of a read verdict. Returns null when the read is ok. */
function ReadVerdict({ read }: { read: HealthRead<unknown> }) {
  if (read.status === 'ok') return null
  if (read.status === 'empty') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-3">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Not measured</p>
          <p className="text-xs text-muted-foreground">{read.detail}</p>
          <p className="break-words font-mono text-[11px] text-muted-foreground">
            Collector: {read.collector}
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/20">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-red-800 dark:text-red-200">
          Unavailable ({read.reason.replace(/_/g, ' ')})
        </p>
        <p className="text-xs text-red-700 dark:text-red-300">{read.detail}</p>
      </div>
    </div>
  )
}

export function ServiceSLAPanel({ brokerageId }: ServiceSLAPanelProps) {
  const [services, setServices] = useState<ServiceStatus[]>([])
  const [catalogState, setCatalogState] = useState<{
    readStatus: 'ok' | 'empty' | 'unavailable'
    readDetail: string | null
  } | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [selected, setSelected] = useState<string>('')

  const [checks, setChecks] = useState<Loadable<HealthCheck[]>>(IDLE)
  const [uptime, setUptime] = useState<Loadable<HealthCheckHistory[]>>(IDLE)
  const [latency, setLatency] = useState<Loadable<ApiResponseLog[]>>(IDLE)
  const [delivery, setDelivery] = useState<Loadable<MessageProviderSummary>>(LOADING)
  const [report, setReport] = useState<Loadable<SLAReportFile>>(IDLE)

  // ── Service catalog + provider delivery ────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setCatalogLoading(true)
      try {
        const result = await getServiceStatuses()
        if (cancelled) return
        setServices(result.services)
        setCatalogState({ readStatus: result.readStatus, readDetail: result.readDetail })
        if (result.services.length > 0) setSelected(result.services[0].service_key)
      } catch (err) {
        if (cancelled) return
        setServices([])
        setCatalogState({
          readStatus: 'unavailable',
          readDetail: err instanceof Error ? err.message : 'Service catalog could not be read.',
        })
      } finally {
        if (!cancelled) setCatalogLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [brokerageId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setDelivery(LOADING)
      try {
        const read = await getMessageProviderStats(24)
        if (!cancelled) setDelivery({ phase: 'done', read })
      } catch (err) {
        if (cancelled) return
        setDelivery({
          phase: 'done',
          read: {
            status: 'unavailable',
            reason: 'query_failed',
            detail: err instanceof Error ? err.message : 'Provider delivery stats could not be read.',
          },
        })
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [brokerageId])

  // ── Per-service drill-down ─────────────────────────────────────────────────
  const loadService = useCallback(async (serviceKey: string) => {
    if (!serviceKey) return
    setChecks(LOADING)
    setUptime(LOADING)
    setLatency(LOADING)
    const fail = (err: unknown): HealthRead<never> => ({
      status: 'unavailable',
      reason: 'query_failed',
      detail: err instanceof Error ? err.message : 'Read failed.',
    })
    const [c, u, l] = await Promise.all([
      getServiceHealthHistory(serviceKey, 10).catch(fail),
      getUptimeHistory(serviceKey, 7).catch(fail),
      getResponseTimeLogs([serviceKey], 24).catch(fail),
    ])
    setChecks({ phase: 'done', read: c })
    setUptime({ phase: 'done', read: u })
    setLatency({ phase: 'done', read: l })
  }, [])

  useEffect(() => {
    if (selected) void loadService(selected)
  }, [selected, loadService])

  // ── SLA CSV export ─────────────────────────────────────────────────────────
  const handleExport = async () => {
    setReport(LOADING)
    let read: HealthRead<SLAReportFile>
    try {
      read = await exportSLAReport(30)
    } catch (err) {
      read = {
        status: 'unavailable',
        reason: 'query_failed',
        detail: err instanceof Error ? err.message : 'SLA report could not be generated.',
      }
    }
    setReport({ phase: 'done', read })
    if (read.status === 'ok') {
      const blob = new Blob([read.data.csvData], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = read.data.filename
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg font-semibold">
          <Gauge className="h-5 w-5 text-primary" />
          Service SLA &amp; Delivery
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ── SLA export ─────────────────────────────────────────────────── */}
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-muted-foreground">30-Day SLA Report</p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={report.phase === 'loading'}
            >
              <Download className="mr-1 h-4 w-4" />
              {report.phase === 'loading' ? 'Building…' : 'Export CSV'}
            </Button>
          </div>
          {report.phase === 'done' && report.read.status === 'ok' && (
            <p className="text-xs text-muted-foreground">
              Downloaded <span className="font-mono">{report.read.data.filename}</span> —{' '}
              {report.read.data.rowCount} service(s) with measured uptime over{' '}
              {report.read.data.windowDays} days.
            </p>
          )}
          {report.phase === 'done' && <ReadVerdict read={report.read} />}
        </section>

        {/* ── Message provider delivery ──────────────────────────────────── */}
        <section className="space-y-2 border-t border-border pt-4">
          <p className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
            <Activity className="h-3 w-3" />
            Message Provider Delivery (24h)
          </p>
          {delivery.phase === 'loading' && (
            <p className="text-xs text-muted-foreground">Reading provider logs…</p>
          )}
          {delivery.phase === 'done' && delivery.read.status === 'ok' && (
            <div className="space-y-1">
              {delivery.read.data.providers.map((p) => (
                <div
                  key={p.provider_key}
                  className="flex items-center justify-between rounded-lg border border-border p-2"
                >
                  <span className="truncate text-sm font-medium">{p.provider_key}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {p.sent_count} logged / {p.error_count} failed
                    </span>
                    <Badge
                      variant={p.delivery_rate >= 95 ? 'outline' : 'destructive'}
                      className="text-xs"
                    >
                      {p.delivery_rate.toFixed(1)}%
                    </Badge>
                  </div>
                </div>
              ))}
              {delivery.read.data.providers.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No dispatch fell inside the {delivery.read.data.windowHours}h window.
                </p>
              )}
              {delivery.read.data.undatedExcluded > 0 && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                  {delivery.read.data.undatedExcluded} provider row(s) carry no timestamp at all and
                  are excluded from every window. Failed sends are written with a null sent_at, so
                  the rate above understates failures.
                </p>
              )}
            </div>
          )}
          {delivery.phase === 'done' && <ReadVerdict read={delivery.read} />}
        </section>

        {/* ── Per-service drill-down ─────────────────────────────────────── */}
        <section className="space-y-3 border-t border-border pt-4">
          <p className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
            <Timer className="h-3 w-3" />
            Service Detail
          </p>

          {catalogLoading && <p className="text-xs text-muted-foreground">Reading service catalog…</p>}

          {!catalogLoading && services.length === 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-3">
              <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">No service registered</p>
                <p className="text-xs text-muted-foreground">
                  {catalogState?.readDetail ??
                    'service_status holds no row for this brokerage, so there is nothing to drill into.'}
                </p>
              </div>
            </div>
          )}

          {services.length > 0 && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {services.map((s) => (
                  <Button
                    key={s.service_key}
                    size="sm"
                    variant={selected === s.service_key ? 'default' : 'outline'}
                    onClick={() => setSelected(s.service_key)}
                  >
                    {s.service_name}
                  </Button>
                ))}
              </div>

              {/* Recent checks */}
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground">Recent checks</p>
                {checks.phase === 'loading' && (
                  <p className="text-xs text-muted-foreground">Reading…</p>
                )}
                {checks.phase === 'done' && checks.read.status === 'ok' && (
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {checks.read.data.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center justify-between rounded border border-border p-1.5 text-xs"
                      >
                        <span className="font-mono">{c.status}</span>
                        <span className="text-muted-foreground">
                          {c.response_time_ms ?? '—'} ms · {new Date(c.checked_at).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {checks.phase === 'done' && <ReadVerdict read={checks.read} />}
              </div>

              {/* Uptime history */}
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground">Daily uptime (7d)</p>
                {uptime.phase === 'loading' && (
                  <p className="text-xs text-muted-foreground">Reading…</p>
                )}
                {uptime.phase === 'done' && uptime.read.status === 'ok' && (
                  <div className="space-y-1">
                    {uptime.read.data.map((h) => (
                      <div
                        key={h.id}
                        className="flex items-center justify-between rounded border border-border p-1.5 text-xs"
                      >
                        <span>{h.snapshot_date}</span>
                        <span className="text-muted-foreground">
                          {Number(h.uptime_pct).toFixed(1)}% · {h.failed_checks} failed ·{' '}
                          {h.incidents} incident(s)
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {uptime.phase === 'done' && <ReadVerdict read={uptime.read} />}
              </div>

              {/* Latency samples */}
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground">
                  API latency samples (24h)
                </p>
                {latency.phase === 'loading' && (
                  <p className="text-xs text-muted-foreground">Reading…</p>
                )}
                {latency.phase === 'done' && latency.read.status === 'ok' && (
                  <p className="text-xs text-muted-foreground">
                    {latency.read.data.length} sample(s) · median{' '}
                    {(() => {
                      const sorted = latency.read.data
                        .map((r) => r.response_time_ms)
                        .sort((a, b) => a - b)
                      return sorted[Math.floor(sorted.length / 2)]
                    })()}{' '}
                    ms · {latency.read.data.filter((r) => r.is_error).length} error(s)
                  </p>
                )}
                {latency.phase === 'done' && <ReadVerdict read={latency.read} />}
              </div>
            </>
          )}
        </section>
      </CardContent>
    </Card>
  )
}
