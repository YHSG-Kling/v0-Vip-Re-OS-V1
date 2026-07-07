"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { saveTenantConnectionAction, type TenantConnectionStatus } from "@/app/actions/tenant-connections"

const FIELD_LABEL: Record<string, string> = {
  api_key: "API key / token", api_url: "API base URL", account_id: "Account / publisher ID",
}

export function LeadSourcesClient({
  connections, portalLeads,
}: {
  connections: TenantConnectionStatus[]
  portalLeads: Array<{ portal: string; last30d: number }>
}) {
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [pending, start] = useTransition()

  function save(key: string) {
    const v = values[key] ?? {}
    start(async () => {
      const r = await saveTenantConnectionAction({
        platform: key, apiKey: v.api_key, apiUrl: v.api_url, accountId: v.account_id,
      })
      setMsg((m) => ({ ...m, [key]: r.ok ? "Connected ✓" : (r.error ?? "Failed") }))
    })
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Lead Sources &amp; Listing Feeds</h1>
        <p className="text-muted-foreground text-sm mt-1">
          You bring the vendor relationships — your MLS board, ListHub, ShowingTime, and your portal lead
          sources. Finish each connection here and the AI team takes it from there.
        </p>
      </div>

      {/* Portal lead intake — Zillow / realtor.com / Opcity */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Zillow · realtor.com · Opcity leads</CardTitle>
          <CardDescription className="text-xs">
            Portal leads arrive by notification email. Set up an auto-forward from the inbox that receives
            your Zillow Tech Connect / realtor.com / ReadyConnect lead emails to your connected inbound
            email address (Settings → Email). Each forwarded lead is parsed, deduped, suppression-checked,
            and lands in your pipeline — speed-to-lead engages within a minute (email-first until consent).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {portalLeads.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No portal leads received in the last 30 days. Once forwarding is set up, counts appear here —
              that&apos;s your proof the intake is working.
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {portalLeads.map((p) => (
                <div key={p.portal} className="rounded-lg border px-4 py-2">
                  <div className="text-xl font-bold tabular-nums">{p.last30d}</div>
                  <div className="text-[11px] text-muted-foreground">{p.portal} · last 30 days</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Vendor credential slots */}
      {connections.map((c) => (
        <Card key={c.key}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{c.label} {c.connected && <span className="text-emerald-600 text-sm">✓ connected</span>}</CardTitle>
            <CardDescription className="text-xs">{c.note}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {c.fields.map((f) => (
                <Input
                  key={f}
                  type={f === "api_key" ? "password" : "text"}
                  placeholder={FIELD_LABEL[f] ?? f}
                  value={values[c.key]?.[f] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [c.key]: { ...(v[c.key] ?? {}), [f]: e.target.value } }))}
                  className="w-56"
                />
              ))}
              <Button variant="outline" onClick={() => save(c.key)} disabled={pending || !(values[c.key]?.api_key ?? "").trim()}>
                {c.connected ? "Update" : "Connect"}
              </Button>
            </div>
            {msg[c.key] && <p className="text-xs text-muted-foreground">{msg[c.key]}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
