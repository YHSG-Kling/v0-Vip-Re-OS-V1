"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { saveTenantConnectionAction, type TenantConnectionStatus } from "@/app/actions/tenant-connections"
import { updateActiveListingSourcesSetting } from "@/app/actions/settings/active-listing-sources"
import type { ActiveListingSource } from "@/lib/buyer-search/listing-source-order"

const FIELD_LABEL: Record<string, string> = {
  api_key: "API key / token", api_secret: "API secret / client secret", api_url: "API base URL", account_id: "Account / publisher ID",
}

// Wave 68 — cost hints straight off docs/lead-acquisition-coverage-2026-09.md's worked example
// (3 markets, 200 active listings/market, daily refresh). Order in this array is the CHECKLIST
// display order, not the ranking — the ranking is whatever order the brokerage checks them in.
const SOURCE_INFO: Record<ActiveListingSource, { label: string; hint: string }> = {
  idx: { label: "IDX Broker feed", hint: "Free — your own MLS credential, never billed to the platform." },
  rentcast: { label: "RentCast", hint: "~$8–$74/mo for this workload — billed per API request." },
  batchdata_on_market: {
    label: "BatchData on-market pull",
    hint: "~$180–$900/mo for this workload — billed per property record, re-walked daily. Off by default for this reason.",
  },
}
const SOURCE_ORDER: ActiveListingSource[] = ["idx", "rentcast", "batchdata_on_market"]

function ActiveListingSourcesCard({ initial }: { initial: ActiveListingSource[] }) {
  const [checked, setChecked] = useState<Set<ActiveListingSource>>(new Set(initial))
  const [msg, setMsg] = useState<string>("")
  const [pending, start] = useTransition()

  function toggle(source: ActiveListingSource) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      return next
    })
    setMsg("")
  }

  function save() {
    // Preserve SOURCE_ORDER as the persisted order — the checklist's own display order IS the
    // ranking (idx first when checked, then rentcast, then batchdata_on_market last), matching
    // the owner-ruled default precedence.
    const ordered = SOURCE_ORDER.filter((s) => checked.has(s))
    start(async () => {
      const r = await updateActiveListingSourcesSetting(ordered)
      setMsg(r.success ? "Saved ✓" : (r.error ?? "Failed to save"))
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Active-listing sources for buyer smart search</CardTitle>
        <CardDescription className="text-xs">
          Which sources feed a regular buyer&apos;s &quot;on the market&quot; smart search, and in what order.
          IDX and RentCast run by default; the BatchData on-market pull is billed per property record and is
          off unless you opt in. (Investor-intent buyers are unaffected — they get off-market deals through a
          separate rail.)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {SOURCE_ORDER.map((source) => (
          <label key={source} className="flex items-start gap-2 text-sm">
            <Checkbox checked={checked.has(source)} onCheckedChange={() => toggle(source)} />
            <span>
              <span className="font-medium">{SOURCE_INFO[source].label}</span>
              <span className="block text-xs text-muted-foreground">{SOURCE_INFO[source].hint}</span>
            </span>
          </label>
        ))}
        <div className="flex items-center gap-2 pt-1">
          <Button variant="outline" onClick={save} disabled={pending}>Save</Button>
          {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

export function LeadSourcesClient({
  connections, portalLeads, initialActiveListingSources,
}: {
  connections: TenantConnectionStatus[]
  portalLeads: Array<{ portal: string; last30d: number }>
  initialActiveListingSources: ActiveListingSource[]
}) {
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [pending, start] = useTransition()

  function save(key: string) {
    const v = values[key] ?? {}
    start(async () => {
      const r = await saveTenantConnectionAction({
        platform: key, apiKey: v.api_key, apiSecret: v.api_secret, apiUrl: v.api_url, accountId: v.account_id,
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

      {/* Active-listing source order for buyer smart search (wave 68) */}
      <ActiveListingSourcesCard initial={initialActiveListingSources} />

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
                  type={f === "api_key" || f === "api_secret" ? "password" : "text"}
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
