// app/components/features/admin/billing-diagnostics-panel.tsx
// Superadmin support drill-down: resolve ONE brokerage's subscription tier or
// ONE feature's entitlement reason, independent of whichever brokerage the
// rest of this page is currently showing (?brokerageId= drives the page; this
// panel lets a superadmin working a support ticket check a DIFFERENT tenant
// without navigating away).
//
// BUILT (wave 60B, handler-parity census): resolveSubscriptionTier and
// resolveFeatureEntitlement (lib/kernel/billing.ts) each had a real GET route
// — app/api/admin/billing/subscriptions/[brokerageId]/route.ts and
// app/api/admin/billing/entitlements/[brokerageId]/route.ts — with no in-tree
// caller. scripts/handler-parity-census.ts's own UNRESOLVED_METHODS comment
// named the missing half exactly: "a superadmin drill-down view that calls
// them one brokerage at a time has simply not been built." This is that view.
// It does not replace FeatureEntitlementList (which lists ALL features for
// the page's OWN brokerageId via /api/admin/billing/dashboard) — this panel
// answers "why is brokerage X blocked on feature Y" or "what tier/status is
// brokerage X on" for an ARBITRARY brokerage id typed in by support.

"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Badge } from "@/app/components/ui/badge"
import { AlertTriangle, Search } from "lucide-react"

interface BillingDiagnosticsPanelProps {
  defaultBrokerageId: string
}

interface TierResult {
  success: boolean
  tier?: { tierName: string; tierKey: string; priceMonthly: number }
  isCancelled: boolean
  error?: string
}

interface FeatureResult {
  success: boolean
  allowed?: boolean
  reason?: string
  expiresAt?: string
  error?: string
}

interface LiveAgentSessionsResult {
  success: boolean
  sessions?: Array<{
    id: string
    surface: string
    provider: string
    did_agent_id: string | null
    status: string
    started_at: string
    ended_at: string | null
    minutes_billed: number | null
  }>
  totals?: { sessions: number; minutesBilled: number; estimatedUsd: number; active: number }
  error?: string
}

export function BillingDiagnosticsPanel({ defaultBrokerageId }: BillingDiagnosticsPanelProps) {
  const [brokerageId, setBrokerageId] = useState(defaultBrokerageId)
  const [liveResult, setLiveResult] = useState<LiveAgentSessionsResult | null>(null)
  const [loadingLive, setLoadingLive] = useState(false)

  // Live view-agent minutes (D-ID) the tenant was metered for — the reader
  // for the m624 ledger columns; platform pays, tenant is billed (§5).
  const checkLiveSessions = async () => {
    if (!brokerageId.trim()) return
    setLoadingLive(true)
    setLiveResult(null)
    try {
      const res = await fetch(`/api/admin/billing/live-agent-sessions/${brokerageId.trim()}`)
      const data = await res.json()
      setLiveResult(data)
    } catch (err) {
      setLiveResult({ success: false, error: err instanceof Error ? err.message : "Unknown error" })
    } finally {
      setLoadingLive(false)
    }
  }
  const [featureKey, setFeatureKey] = useState("")
  const [tierResult, setTierResult] = useState<TierResult | null>(null)
  const [featureResult, setFeatureResult] = useState<FeatureResult | null>(null)
  const [loadingTier, setLoadingTier] = useState(false)
  const [loadingFeature, setLoadingFeature] = useState(false)

  const checkTier = async () => {
    if (!brokerageId.trim()) return
    setLoadingTier(true)
    setTierResult(null)
    try {
      const res = await fetch(`/api/admin/billing/subscriptions/${brokerageId.trim()}`)
      const data = await res.json()
      setTierResult(data)
    } catch (err) {
      setTierResult({
        success: false,
        isCancelled: false,
        error: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setLoadingTier(false)
    }
  }

  const checkFeature = async () => {
    if (!brokerageId.trim() || !featureKey.trim()) return
    setLoadingFeature(true)
    setFeatureResult(null)
    try {
      const res = await fetch(
        `/api/admin/billing/entitlements/${brokerageId.trim()}?featureKey=${encodeURIComponent(featureKey.trim())}`
      )
      const data = await res.json()
      setFeatureResult(data)
    } catch (err) {
      setFeatureResult({ success: false, error: err instanceof Error ? err.message : "Unknown error" })
    } finally {
      setLoadingFeature(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Billing Diagnostics</CardTitle>
        <p className="text-xs text-gray-500">
          Look up any brokerage&apos;s subscription tier or a single feature&apos;s entitlement reason —
          for support tickets, without changing which brokerage the page above shows.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="text-xs font-semibold text-gray-600">Brokerage ID</label>
          <Input
            value={brokerageId}
            onChange={(e) => setBrokerageId(e.target.value)}
            placeholder="brokerage uuid"
            className="mt-1 font-mono text-sm"
          />
        </div>

        <div className="space-y-2">
          <Button size="sm" variant="outline" onClick={checkTier} disabled={loadingTier || !brokerageId.trim()}>
            <Search className="w-3.5 h-3.5 mr-1.5" />
            {loadingTier ? "Checking…" : "Check subscription tier"}
          </Button>
          {tierResult && (
            <div className="text-sm p-2 rounded bg-gray-50 border">
              {tierResult.success && tierResult.tier ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="secondary">{tierResult.tier.tierName}</Badge>
                  <span className="text-xs text-gray-600">
                    ${(tierResult.tier.priceMonthly / 100).toFixed(2)}/mo
                  </span>
                  {tierResult.isCancelled && (
                    <Badge variant="destructive" className="text-xs">cancelled</Badge>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-red-700">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                  {tierResult.error || "No subscription found"}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-xs font-semibold text-gray-600">Feature key</label>
          <Input
            value={featureKey}
            onChange={(e) => setFeatureKey(e.target.value)}
            placeholder="e.g. ai_video_generation"
            className="font-mono text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={checkFeature}
            disabled={loadingFeature || !brokerageId.trim() || !featureKey.trim()}
          >
            <Search className="w-3.5 h-3.5 mr-1.5" />
            {loadingFeature ? "Checking…" : "Check feature entitlement"}
          </Button>
          {featureResult && (
            <div className="text-sm p-2 rounded bg-gray-50 border">
              {featureResult.success ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={featureResult.allowed ? "secondary" : "destructive"}>
                    {featureResult.allowed ? "allowed" : "blocked"}
                  </Badge>
                  <span className="text-xs text-gray-600">reason: {featureResult.reason}</span>
                  {featureResult.expiresAt && (
                    <span className="text-xs text-gray-500">
                      until {new Date(featureResult.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-red-700">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                  {featureResult.error || "Unknown error"}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2 border-t pt-4">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={checkLiveSessions} disabled={loadingLive || !brokerageId.trim()}>
              {loadingLive ? "Loading…" : "Live agent minutes (30d)"}
            </Button>
            {liveResult?.success && liveResult.totals && (
              <span className="text-xs text-gray-600">
                {liveResult.totals.sessions} sessions · {liveResult.totals.minutesBilled.toFixed(2)} min billed ·
                ≈ ${liveResult.totals.estimatedUsd.toFixed(2)} · {liveResult.totals.active} active
              </span>
            )}
          </div>
          {liveResult && !liveResult.success && (
            <div className="flex items-center gap-1.5 text-xs text-red-700">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              {liveResult.error || "Unknown error"}
            </div>
          )}
          {liveResult?.success && liveResult.sessions && liveResult.sessions.length > 0 && (
            <div className="max-h-56 overflow-auto rounded border text-xs">
              <table className="w-full">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-2 py-1">Started</th>
                    <th className="px-2 py-1">Surface</th>
                    <th className="px-2 py-1">Provider / agent</th>
                    <th className="px-2 py-1">Status</th>
                    <th className="px-2 py-1">Ended</th>
                    <th className="px-2 py-1 text-right">Min billed</th>
                  </tr>
                </thead>
                <tbody>
                  {liveResult.sessions.map((s) => (
                    <tr key={s.id} className="border-t">
                      <td className="px-2 py-1">{new Date(s.started_at).toLocaleString()}</td>
                      <td className="px-2 py-1"><Badge variant="outline">{s.surface}</Badge></td>
                      <td className="px-2 py-1">{s.provider}{s.did_agent_id ? ` · ${s.did_agent_id}` : ""}</td>
                      <td className="px-2 py-1">{s.status}</td>
                      <td className="px-2 py-1">{s.ended_at ? new Date(s.ended_at).toLocaleTimeString() : "—"}</td>
                      <td className="px-2 py-1 text-right">{s.minutes_billed == null ? "—" : Number(s.minutes_billed).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
