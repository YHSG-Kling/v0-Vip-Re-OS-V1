"use client"

// app/dashboard/settings/integrations/lead-sources/acquisition-providers-panel.tsx
// TENANT-OWNED ACQUISITION PROVIDERS (wave 151, lane 151F — directive 151F route B). The tenant sees every catalogue provider
// with its HONEST derived state (unavailable / unsupported / unconfigured / sandbox / pending owner licensing / healthy /
// degraded / revoked), connects a SUPPORTED one with the provider's documented fields plus the agreement, territory, frequency
// and rate limit, is shown the push signing secret ONCE, and can disconnect. Never a token read back, never a platform secret.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  connectTenantAcquisitionProviderAction,
  disconnectTenantAcquisitionProviderAction,
  type TenantAcquisitionProviderStatus,
} from "@/app/actions/tenant-connections"

const STATE_LABEL: Record<TenantAcquisitionProviderStatus["state"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  unavailable: { label: "Unavailable", variant: "outline" },
  unsupported: { label: "Unsupported (no transport)", variant: "outline" },
  unconfigured: { label: "Not connected", variant: "secondary" },
  sandbox: { label: "Sandbox", variant: "secondary" },
  pending_owner_licensing: { label: "Pending owner licensing", variant: "outline" },
  healthy: { label: "Healthy", variant: "default" },
  degraded: { label: "Degraded", variant: "destructive" },
  revoked: { label: "Revoked", variant: "destructive" },
}

function ConnectForm({ p, onDone }: { p: TenantAcquisitionProviderStatus; onDone: (r: { webhookPath: string | null; webhookSecretOnce: string | null; state: string; reason: string }) => void }) {
  const [fields, setFields] = useState<Record<string, string>>({})
  const [scopes, setScopes] = useState<string[]>([...p.capabilities])
  const [retention, setRetention] = useState("365")
  const [aiProcessing, setAiProcessing] = useState(true)
  const [licenseAck, setLicenseAck] = useState(false)
  const [state, setState] = useState(p.connection?.territory?.state ?? "")
  const [zips, setZips] = useState((p.connection?.territory?.zip_codes ?? []).join(", "))
  const [city, setCity] = useState(p.connection?.territory?.city ?? "")
  const [frequency, setFrequency] = useState<"push" | "daily" | "weekly">(p.connection?.frequency ?? (p.transports.includes("signed_webhook") ? "push" : "daily"))
  const [rate, setRate] = useState(String(p.connection?.rateLimitPerDay ?? 500))
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  return (
    <form
      className="mt-3 space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        start(async () => {
          const r = await connectTenantAcquisitionProviderAction({
            provider: p.key, fields,
            agreement: { scopes, license_acknowledged: licenseAck, retention_days: Number(retention), ai_processing_permitted: aiProcessing, redistribution: "prohibited", cost_payer: "tenant" },
            territory: { state, zip_codes: zips.split(/[,\s]+/).filter(Boolean), city: city || null },
            frequency, rateLimitPerDay: Number(rate),
          })
          if (!r.ok) { setError(r.error); return }
          onDone({ webhookPath: r.webhookPath, webhookSecretOnce: r.webhookSecretOnce, state: r.state, reason: r.reason })
        })
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {p.fields.map((f) => (
          <label key={f.key} className="space-y-1 text-xs">
            <span>{f.label}{f.required ? " *" : ""}</span>
            <Input type={f.secret ? "password" : "text"} autoComplete="off" required={f.required} placeholder={f.placeholder} value={fields[f.key] ?? ""} onChange={(e) => setFields((v) => ({ ...v, [f.key]: e.target.value }))} />
          </label>
        ))}
      </div>
      <fieldset className="rounded-md border p-3 space-y-2">
        <legend className="px-1 text-xs font-medium">Your agreement with {p.label.replace(" (your own account)", "")}</legend>
        <div className="flex flex-wrap gap-3 text-xs">
          {p.capabilities.map((c) => (
            <label key={c} className="flex items-center gap-1">
              <input type="checkbox" checked={scopes.includes(c)} onChange={(e) => setScopes((s) => (e.target.checked ? [...s, c] : s.filter((x) => x !== c)))} />
              <span>{c.replace(/_/g, " ")}</span>
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={licenseAck} onChange={(e) => setLicenseAck(e.target.checked)} required />
          <span>I hold this account under the provider&apos;s own terms (LICENSE) and authorize this OS to call it on my brokerage&apos;s behalf. The provider bills my brokerage directly; records are never redistributed.</span>
        </label>
        <div className="grid gap-2 sm:grid-cols-3 text-xs">
          <label className="space-y-1"><span>Retention (days)</span><Input type="number" min={1} max={3650} value={retention} onChange={(e) => setRetention(e.target.value)} /></label>
          <label className="flex items-end gap-2 pb-2"><input type="checkbox" checked={aiProcessing} onChange={(e) => setAiProcessing(e.target.checked)} /><span>The AI managers may process these records</span></label>
          <div className="text-[11px] text-muted-foreground pt-4">Cost payer: <strong>your brokerage</strong> (never the platform)</div>
        </div>
      </fieldset>
      <fieldset className="rounded-md border p-3 space-y-2">
        <legend className="px-1 text-xs font-medium">Territory, frequency, limits</legend>
        <div className="grid gap-2 sm:grid-cols-4 text-xs">
          <label className="space-y-1"><span>State *</span><Input value={state} onChange={(e) => setState(e.target.value)} placeholder="FL" maxLength={2} required /></label>
          <label className="space-y-1 sm:col-span-2"><span>ZIP codes *</span><Input value={zips} onChange={(e) => setZips(e.target.value)} placeholder="32501, 32502" required /></label>
          <label className="space-y-1"><span>City</span><Input value={city} onChange={(e) => setCity(e.target.value)} /></label>
          <label className="space-y-1"><span>Frequency</span>
            <select className="w-full rounded-md border bg-background px-2 py-2" value={frequency} onChange={(e) => setFrequency(e.target.value as "push" | "daily" | "weekly")}>
              {p.transports.includes("signed_webhook") && <option value="push">Push (provider webhook, signed)</option>}
              <option value="daily">Daily poll</option>
              <option value="weekly">Weekly poll</option>
            </select>
          </label>
          <label className="space-y-1"><span>Records per day (0 = provider limits only)</span><Input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} /></label>
        </div>
      </fieldset>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Connecting and verifying…" : p.connection ? "Rotate and re-verify" : "Connect and verify"}</Button>
    </form>
  )
}

export function AcquisitionProvidersPanel({ providers, encryptionConfigured, stateLegend }: { providers: TenantAcquisitionProviderStatus[]; encryptionConfigured: boolean; stateLegend: readonly TenantAcquisitionProviderStatus["state"][] }) {
  const router = useRouter()
  const [open, setOpen] = useState<string | null>(null)
  const [once, setOnce] = useState<Record<string, { webhookPath: string | null; webhookSecretOnce: string | null; state: string; reason: string }>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [pending, start] = useTransition()
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Lead acquisition providers — your own account</CardTitle>
        <CardDescription className="text-xs">
          Acquisition is part of your subscription. If you also hold your own account with a supported data provider, connect it here: your
          token is stored encrypted, verified under your own account, and every record it brings enters the same intake and dedup as every
          other source. The provider bills you directly — nothing here is a platform lead charge. Only providers with a real transport in this
          OS can be connected; the others show their honest status.
        </CardDescription>
        <p className="text-[11px] text-muted-foreground">Connection states, in order: {stateLegend.map((st) => STATE_LABEL[st].label).join(" · ")}.</p>
        {!encryptionConfigured && <p className="text-xs text-destructive">Secret storage is not configured on this deployment — connections are refused until platform staff set it (nothing is ever stored in plaintext).</p>}
      </CardHeader>
      <CardContent className="space-y-3">
        {providers.map((p) => {
          const s = STATE_LABEL[p.state]
          const connectable = p.transports.length > 0 && !["unsupported", "pending_owner_licensing", "unavailable"].includes(p.state)
          const shown = once[p.key]
          return (
            <div key={p.key} className="rounded-md border p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.label}</span>
                  <Badge variant={s.variant}>{s.label}</Badge>
                  {p.connection?.accountLabel && <span className="text-xs text-muted-foreground">· {p.connection.accountLabel}</span>}
                </div>
                <div className="flex items-center gap-2">
                  {connectable && (
                    <Button size="sm" variant={open === p.key ? "secondary" : p.connection ? "outline" : "default"} disabled={!encryptionConfigured} onClick={() => setOpen((o) => (o === p.key ? null : p.key))}>
                      {p.connection && p.state !== "revoked" ? "Rotate" : "Connect"}
                    </Button>
                  )}
                  {p.connection && p.state !== "revoked" && (
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => {
                      const r = await disconnectTenantAcquisitionProviderAction(p.key)
                      if (!r.ok) { setRowError((e) => ({ ...e, [p.key]: r.error })); return }
                      router.refresh()
                    })}>Disconnect</Button>
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{p.reason}{p.actionable ? ` — ${p.actionable}` : ""}</p>
              {p.connection && (
                <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                  {p.connection.territory && <span>Territory: {p.connection.territory.state} · {p.connection.territory.zip_codes.join(", ")}</span>}
                  {p.connection.frequency && <span>Frequency: {p.connection.frequency}</span>}
                  {p.connection.rateLimitPerDay !== null && <span>Records/day: {p.connection.rateLimitPerDay || "provider limits only"}</span>}
                  {p.connection.agreement && <span>Scopes: {p.connection.agreement.scopes.join(", ")} · retention {p.connection.agreement.retention_days}d · AI processing {p.connection.agreement.ai_processing_permitted ? "on" : "off"} · payer: your brokerage</span>}
                  {p.connection.lastHealth && <span>Last check: {p.connection.lastHealth.status} ({p.connection.lastHealth.kind}, {p.connection.lastHealth.at})</span>}
                  {p.webhookPath && <span>Push URL path: <code>{p.webhookPath}</code> (secret shown once at connect)</span>}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">{p.pricingNote} · docs: {p.docs}</p>
              {rowError[p.key] && <p className="text-xs text-destructive">{rowError[p.key]}</p>}
              {shown && (
                <div className="rounded-md border border-emerald-300 bg-emerald-50/50 p-3 text-xs space-y-1">
                  <p><strong>{STATE_LABEL[shown.state as TenantAcquisitionProviderStatus["state"]]?.label ?? shown.state}</strong> — {shown.reason}</p>
                  {shown.webhookPath && <p>Paste at the provider: <code>{shown.webhookPath}</code></p>}
                  {shown.webhookSecretOnce && <p>Signing secret (shown once — store it at the provider as the webhook secret header <code>x-webhook-secret</code>): <code>{shown.webhookSecretOnce}</code></p>}
                </div>
              )}
              {open === p.key && connectable && <ConnectForm p={p} onDone={(r) => { setOpen(null); setOnce((o) => ({ ...o, [p.key]: r })); router.refresh() }} />}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
