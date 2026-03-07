"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { createClient } from "@/lib/supabase/client"

interface IDXCred {
  id?: string
  api_key: string
  account_name: string
  config: Record<string, any>
  is_active: boolean
  last_synced_at?: string
}

interface UsageRow {
  date: string
  alerts_run: number
  properties_matched: number
  emails_sent: number
}

const DEFAULT_DEFAULTS = {
  frequency: "daily",
  max_results: "10",
  include_coming_soon: true,
  include_price_reductions: true,
  price_reduction_min_percent: "2",
  delivery_channels: ["email", "in_app"] as string[],
}

export default function IDXBrokerSettingsPage() {
  const supabase = createClient()

  const [role, setRole]           = useState<string | null>(null)
  const [brokerageId, setBrokerageId] = useState<string | null>(null)
  const [cred, setCred]           = useState<IDXCred | null>(null)
  const [apiKey, setApiKey]       = useState("")
  const [partnerKey, setPartnerKey] = useState("")
  const [accountLabel, setAccountLabel] = useState("")
  const [saving, setSaving]       = useState(false)
  const [testing, setTesting]     = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  const [defaults, setDefaults]   = useState(DEFAULT_DEFAULTS)
  const [savingDefaults, setSavingDefaults] = useState(false)

  const [usage, setUsage]         = useState<{ activeAlerts: number; todayApiCalls: number; monthSent: number; rows: UsageRow[] } | null>(null)
  const [loadingUsage, setLoadingUsage] = useState(false)

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // Get role + brokerage_id from users table
      const { data: profile } = await supabase
        .from("users")
        .select("role, brokerage_id")
        .eq("id", user.id)
        .maybeSingle()

      setRole(profile?.role ?? null)
      setBrokerageId(profile?.brokerage_id ?? null)

      if (!profile?.brokerage_id) return

      // Load existing credential
      const { data: existing } = await supabase
        .from("platform_credentials")
        .select("*")
        .eq("brokerage_id", profile.brokerage_id)
        .eq("platform", "idxbroker")
        .maybeSingle()

      if (existing) {
        setCred(existing)
        setApiKey(existing.api_key ?? "")
        setPartnerKey((existing.config as any)?.partner_key ?? "")
        setAccountLabel(existing.account_name ?? "")
      }

      // Load global settings defaults
      const { data: gs } = await supabase
        .from("global_settings")
        .select("additional_settings")
        .eq("brokerage_id", profile.brokerage_id)
        .maybeSingle()

      if (gs?.additional_settings?.idx_alert_defaults) {
        setDefaults({ ...DEFAULT_DEFAULTS, ...gs.additional_settings.idx_alert_defaults })
      }

      loadUsage(profile.brokerage_id)
    }
    init()
  }, [])

  const loadUsage = async (bid: string) => {
    setLoadingUsage(true)
    const { count: activeAlerts } = await supabase
      .from("property_alerts")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", bid)
      .eq("is_active", true)

    const today = new Date().toISOString().slice(0, 10)
    const { count: todayApiCalls } = await supabase
      .from("property_alert_delivery_log")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", bid)
      .eq("idx_api_called", true)
      .gte("created_at", `${today}T00:00:00Z`)

    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0)
    const { data: monthRows } = await supabase
      .from("property_alert_delivery_log")
      .select("properties_sent")
      .eq("brokerage_id", bid)
      .gte("created_at", monthStart.toISOString())

    const monthSent = (monthRows ?? []).reduce((s, r) => s + (r.properties_sent ?? 0), 0)

    // 7-day rows
    const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const { data: logRows } = await supabase
      .from("property_alert_delivery_log")
      .select("created_at, properties_matched, properties_sent, idx_api_called")
      .eq("brokerage_id", bid)
      .gte("created_at", sevenDaysAgo.toISOString())
      .order("created_at", { ascending: false })

    const dayMap = new Map<string, UsageRow>()
    for (const row of logRows ?? []) {
      const d = row.created_at.slice(0, 10)
      const existing = dayMap.get(d) ?? { date: d, alerts_run: 0, properties_matched: 0, emails_sent: 0 }
      existing.alerts_run++
      existing.properties_matched += row.properties_matched ?? 0
      existing.emails_sent        += row.properties_sent    ?? 0
      dayMap.set(d, existing)
    }

    setUsage({
      activeAlerts:  activeAlerts ?? 0,
      todayApiCalls: todayApiCalls ?? 0,
      monthSent,
      rows: Array.from(dayMap.values()),
    })
    setLoadingUsage(false)
  }

  const handleSave = async () => {
    if (!brokerageId) return
    setSaving(true)
    const config: any = {}
    if (partnerKey) config.partner_key = partnerKey

    await supabase.from("platform_credentials").upsert(
      {
        brokerage_id: brokerageId,
        platform:     "idxbroker",
        scope:        "brokerage",
        api_key:      apiKey,
        account_name: accountLabel || "IDX Broker",
        config,
        is_active:    true,
        updated_at:   new Date().toISOString(),
      },
      { onConflict: "brokerage_id,platform" }
    )
    setSaving(false)
    setTestResult(null)
  }

  const handleTest = async () => {
    if (!brokerageId) return
    setTesting(true)
    setTestResult(null)
    const { testIdxConnection } = await import("@/app/actions/property-alerts/alert-actions")
    const res = await testIdxConnection(brokerageId)
    setTestResult({
      ok: res.success,
      message: res.success
        ? `Connected. ${res.resultCount ?? 0} test results returned.`
        : res.error ?? "Connection failed",
    })
    setTesting(false)
  }

  const handleDisconnect = async () => {
    if (!brokerageId || !confirm("Disconnect IDX Broker? All active alerts will be paused.")) return
    setDisconnecting(true)
    await supabase
      .from("platform_credentials")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("brokerage_id", brokerageId)
      .eq("platform", "idxbroker")

    // Pause all brokerage alerts
    await supabase
      .from("property_alerts")
      .update({ is_active: false, paused_by: "admin_disconnect", updated_at: new Date().toISOString() })
      .eq("brokerage_id", brokerageId)

    setDisconnecting(false)
    setCred(null)
    setApiKey("")
  }

  const handleSaveDefaults = async () => {
    if (!brokerageId) return
    setSavingDefaults(true)
    const { data: gs } = await supabase
      .from("global_settings")
      .select("id, additional_settings")
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    const merged = { ...(gs?.additional_settings ?? {}), idx_alert_defaults: defaults }
    if (gs?.id) {
      await supabase.from("global_settings").update({ additional_settings: merged }).eq("id", gs.id)
    }
    setSavingDefaults(false)
  }

  const toggleDefaultChannel = (ch: string) => {
    setDefaults(prev => ({
      ...prev,
      delivery_channels: prev.delivery_channels.includes(ch)
        ? prev.delivery_channels.filter(c => c !== ch)
        : [...prev.delivery_channels, ch],
    }))
  }

  // Role gate
  const canManage = role && ["superadmin", "admin", "broker"].includes(role)

  if (role && !canManage) {
    return (
      <div className="p-8 max-w-xl mx-auto">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              This setting is managed by your brokerage admin.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">IDX Broker Integration</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Configure IDX Broker for property alert searches across your brokerage.</p>
      </div>

      {/* Connection card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Connection</CardTitle>
            <Badge variant={cred?.is_active ? "default" : "secondary"}>
              {cred?.is_active ? "Connected" : "Not Connected"}
            </Badge>
          </div>
          <CardDescription>Enter your IDX Broker API credentials.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>API Key</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="••••••••••••••••"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label>Partner Key <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              type="password"
              value={partnerKey}
              onChange={e => setPartnerKey(e.target.value)}
              placeholder="••••••••••••••••"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label>Account Label</Label>
            <Input
              value={accountLabel}
              onChange={e => setAccountLabel(e.target.value)}
              placeholder="e.g. Main Brokerage IDX"
            />
          </div>

          {testResult && (
            <div className={`rounded-md px-3 py-2 text-sm ${testResult.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"}`}>
              {testResult.message}
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={saving || !apiKey}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="outline" onClick={handleTest} disabled={testing || !apiKey}>
              {testing ? "Testing…" : "Test Connection"}
            </Button>
            {cred?.is_active && (
              <Button variant="ghost" className="text-destructive ml-auto" onClick={handleDisconnect} disabled={disconnecting}>
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Alert engine defaults */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Alert Engine Defaults</CardTitle>
          <CardDescription>Default settings applied when agents create new alerts.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Default Frequency</Label>
              <Select value={defaults.frequency} onValueChange={v => setDefaults(p => ({...p, frequency: v}))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="instant">Every 15 min</SelectItem>
                  <SelectItem value="twice_daily">Twice Daily</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Max Results per Alert</Label>
              <Input type="number" value={defaults.max_results} onChange={e => setDefaults(p => ({...p, max_results: e.target.value}))} className="w-24" />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox id="d-cs" checked={defaults.include_coming_soon} onCheckedChange={v => setDefaults(p => ({...p, include_coming_soon: !!v}))} />
              <Label htmlFor="d-cs">Include Coming Soon by default</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="d-pr" checked={defaults.include_price_reductions} onCheckedChange={v => setDefaults(p => ({...p, include_price_reductions: !!v}))} />
              <Label htmlFor="d-pr">Include Price Reductions by default</Label>
            </div>
          </div>

          {defaults.include_price_reductions && (
            <div className="space-y-1">
              <Label>Min Price Reduction %</Label>
              <Input type="number" value={defaults.price_reduction_min_percent} onChange={e => setDefaults(p => ({...p, price_reduction_min_percent: e.target.value}))} className="w-24" />
            </div>
          )}

          <div className="space-y-2">
            <Label>Default Delivery Channels</Label>
            {(["email", "sms", "in_app"] as const).map(ch => (
              <div key={ch} className="flex items-center gap-2">
                <Checkbox id={`dc-${ch}`} checked={defaults.delivery_channels.includes(ch)} onCheckedChange={() => toggleDefaultChannel(ch)} />
                <Label htmlFor={`dc-${ch}`} className="capitalize">{ch.replace("_", "-")}</Label>
              </div>
            ))}
          </div>

          <Button onClick={handleSaveDefaults} disabled={savingDefaults} size="sm">
            {savingDefaults ? "Saving…" : "Save Defaults"}
          </Button>
        </CardContent>
      </Card>

      {/* Usage stats */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Usage</CardTitle>
          <CardDescription>Read-only. Based on delivery log data.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadingUsage ? (
            <div className="h-16 bg-muted/40 rounded animate-pulse" />
          ) : usage ? (
            <>
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: "Active Alerts",     value: usage.activeAlerts },
                  { label: "Today's API Calls",  value: usage.todayApiCalls },
                  { label: "This Month Sent",    value: usage.monthSent },
                ].map(({ label, value }) => (
                  <div key={label} className="border rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold tabular-nums">{value}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                  </div>
                ))}
              </div>

              <Separator />

              <div>
                <p className="text-sm font-medium mb-2">7-Day Activity</p>
                {usage.rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No activity in the last 7 days.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b">
                        <th className="py-1.5 pr-4">Date</th>
                        <th className="py-1.5 pr-4">Alerts Run</th>
                        <th className="py-1.5 pr-4">Matched</th>
                        <th className="py-1.5">Emails Sent</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.rows.map(row => (
                        <tr key={row.date} className="border-b last:border-0">
                          <td className="py-1.5 pr-4 font-mono text-xs">{row.date}</td>
                          <td className="py-1.5 pr-4">{row.alerts_run}</td>
                          <td className="py-1.5 pr-4">{row.properties_matched}</td>
                          <td className="py-1.5">{row.emails_sent}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="rounded-md bg-muted/40 border px-3 py-2 text-xs text-muted-foreground">
                IDX Broker rate limits vary by tier. Contact IDX Broker support if you see API errors in the delivery log.
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
