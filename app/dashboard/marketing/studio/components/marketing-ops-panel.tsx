"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, Clock, CheckCircle2, Zap, Radio, Link2, Loader2 } from "lucide-react"
import { getMarketingOpsSnapshot, type MarketingOpsSnapshot } from "@/app/actions/marketing-ops"

/**
 * Marketing OPS tab — the brokerage marketing-health view consolidated INTO
 * Marketing Studio from the retired standalone "Ops Center" page. Self-loading
 * (server action), read-only; every action links back into the Studio/social/
 * mail surfaces. Preserves the four functions the Ops Center uniquely had:
 * health strip, needs-attention triage (incl. stale-draft detection), direct-
 * mail pipeline, and connected-channel health.
 */
export function MarketingOpsPanel() {
  const [snapshot, setSnapshot] = useState<MarketingOpsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    getMarketingOpsSnapshot()
      .then((res) => {
        if (!alive) return
        if (res.ok) setSnapshot(res.snapshot)
        else setError(res.error)
      })
      .catch(() => alive && setError("Could not load marketing ops."))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading marketing health…
      </div>
    )
  }
  if (error || !snapshot) {
    return <p className="py-10 text-sm text-muted-foreground text-center">{error ?? "No data."}</p>
  }

  const { counts, passRateError, needsAttention, failedPublishes, pendingApproval, neverLaunched, mailCampaigns, integrations } = snapshot

  return (
    <div className="space-y-6">
      {/* Health summary strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card><CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2 mb-1"><Radio className="h-4 w-4 text-green-600" /><span className="text-xs text-muted-foreground font-medium">Active Campaigns</span></div>
          <p className="text-2xl font-bold">{counts.active}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2 mb-1"><Clock className="h-4 w-4 text-amber-500" /><span className="text-xs text-muted-foreground font-medium">Pending Approval</span></div>
          <p className="text-2xl font-bold">{counts.pendingApproval}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2 mb-1"><AlertTriangle className="h-4 w-4 text-red-500" /><span className="text-xs text-muted-foreground font-medium">Failed Publishes</span></div>
          <p className="text-2xl font-bold">{counts.failedPublishes}</p>
        </CardContent></Card>
        {/* Readiness Pass Rate. A rate that could NOT be computed renders "—"
            and says why — never 0%. supabase-js resolves a refused query, so an
            aggregate over a refusal is otherwise indistinguishable from a real
            zero, and "0% of your campaign content is publishable" is a claim
            about the brokerage that a failed read does not support. */}
        <Card><CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2 mb-1">
            {passRateError ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : <CheckCircle2 className="h-4 w-4 text-indigo-600" />}
            <span className="text-xs text-muted-foreground font-medium">Readiness Pass Rate</span>
          </div>
          <p className="text-2xl font-bold">{counts.passRate != null ? `${Math.round(counts.passRate)}%` : "—"}</p>
          {passRateError ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5 leading-tight" title={passRateError}>
              Not computed — {passRateError}
            </p>
          ) : counts.passRate == null ? (
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">No evaluations recorded yet</p>
          ) : null}
        </CardContent></Card>
      </div>

      {/* Section 1 — Needs Attention */}
      {needsAttention && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><Zap className="h-4 w-4" /> Needs Attention</h2>

          {failedPublishes.length > 0 && (
            <Card className="border-red-200 bg-red-50/40">
              <CardHeader className="pb-2 pt-4"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-red-500" /> Failed Social Publishes ({failedPublishes.length})</CardTitle></CardHeader>
              <CardContent className="pb-3 space-y-1">
                {failedPublishes.map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded px-2 py-1.5 bg-white border border-red-100 text-sm">
                    <span className="text-muted-foreground truncate max-w-xs"><span className="font-medium text-foreground capitalize">{p.platform}</span>{p.content ? ` · ${p.content.substring(0, 60)}…` : ""}</span>
                    <Link href={`/dashboard/social?post=${p.id}`} className="ml-3 shrink-0 text-xs text-red-600 hover:underline font-medium">Retry →</Link>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {pendingApproval.length > 0 && (
            <Card className="border-amber-200 bg-amber-50/40">
              <CardHeader className="pb-2 pt-4"><CardTitle className="text-sm flex items-center gap-2"><Clock className="h-4 w-4 text-amber-500" /> Awaiting Approval ({pendingApproval.length})</CardTitle></CardHeader>
              <CardContent className="pb-3 space-y-1">
                {pendingApproval.map((c) => (
                  <div key={c.id} className="flex items-center justify-between rounded px-2 py-1.5 bg-white border border-amber-100 text-sm">
                    <span className="font-medium truncate max-w-xs">{c.campaign_name}</span>
                    <Link href={`/dashboard/marketing/studio?campaign=${c.id}`} className="ml-3 shrink-0 text-xs text-amber-700 hover:underline font-medium">Review →</Link>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {neverLaunched.length > 0 && (
            <Card className="border-gray-200">
              <CardHeader className="pb-2 pt-4"><CardTitle className="text-sm flex items-center gap-2"><Clock className="h-4 w-4 text-gray-400" /> Stale Drafts — 7+ days, never launched ({neverLaunched.length})</CardTitle></CardHeader>
              <CardContent className="pb-3 space-y-1">
                {neverLaunched.map((c) => (
                  <div key={c.id} className="flex items-center justify-between rounded px-2 py-1.5 bg-white border border-gray-100 text-sm">
                    <span className="truncate max-w-xs"><span className="font-medium">{c.campaign_name}</span><span className="text-muted-foreground ml-2 text-xs">{formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}</span></span>
                    <Link href={`/dashboard/marketing/studio?campaign=${c.id}`} className="ml-3 shrink-0 text-xs text-indigo-600 hover:underline font-medium">Launch →</Link>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Section 2 — Direct Mail Pipeline */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Direct Mail Pipeline</h2>
        {mailCampaigns.length === 0 ? (
          <p className="text-sm text-muted-foreground py-3">No active mail campaigns.</p>
        ) : (
          <div className="space-y-2">
            {mailCampaigns.map((mc) => (
              <div key={mc.id} className="flex items-center gap-3 border rounded-md px-3 py-2.5 bg-card">
                <Badge variant="outline" className="capitalize shrink-0">{mc.status.replace(/_/g, " ")}</Badge>
                <span className="text-sm font-medium truncate flex-1">{mc.campaign_name}</span>
                {mc.quantity != null && (<span className="text-xs text-muted-foreground shrink-0">{mc.quantity.toLocaleString()} pieces</span>)}
                <Link href={`/dashboard/campaigns/mail?campaign=${mc.id}`} className="text-xs text-indigo-600 hover:underline shrink-0 font-medium">View →</Link>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Section 3 — Connected Channels */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><Link2 className="h-4 w-4" /> Connected Channels</h2>
        {integrations.length === 0 ? (
          <p className="text-sm text-muted-foreground py-3">No channel integrations found. Connect channels in <Link href="/dashboard/settings/integrations" className="underline">Settings → Integrations</Link>.</p>
        ) : (
          <div className="rounded-md border overflow-hidden divide-y">
            {integrations.map((intg) => {
              const isHealthy = intg.status === "active" || intg.status === "connected"
              const isError = intg.status === "error" || intg.status === "failed"
              return (
                <div key={intg.id} className="flex items-center gap-3 px-3 py-2.5 bg-card text-sm">
                  <Badge variant={isError ? "destructive" : isHealthy ? "default" : "secondary"} className="capitalize shrink-0 text-xs">{intg.status}</Badge>
                  <span className="font-medium flex-1 truncate">{intg.provider_name}</span>
                  <span className="text-xs text-muted-foreground capitalize shrink-0">{intg.provider_type}</span>
                  {intg.last_health_check_at && (<span className="text-xs text-muted-foreground shrink-0">checked {formatDistanceToNow(new Date(intg.last_health_check_at), { addSuffix: true })}</span>)}
                  {isError && intg.last_error && (<span className="text-xs text-red-600 truncate max-w-xs shrink-0" title={intg.last_error}>{intg.last_error.substring(0, 40)}…</span>)}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
