"use client"

// app/dashboard/settings/integrations/lead-sources/acquisition-providers-panel.tsx
// TENANT-OWNED ACQUISITION PROVIDERS (wave 151, lane 151F — directive 151F route B). The tenant sees every catalogue provider
// with its honest derived state, connects a SUPPORTED one with the provider's documented fields plus the agreement, territory,
// frequency and rate limit, is shown the push signing secret ONCE, and can disconnect. Never a token read back, never a
// platform secret.
//
// Wave 152 (lane 152A): every sentence here is THE presenter's (lib/errors presentTenantConnection, composed on the server):
// the badge + message (availability), the credential line (who controls the account) and the cost line (who bills it —
// "your brokerage's" only for a tenant that IS a brokerage by its own plan tier). This panel no longer spells a state label,
// a payer, an internal probe code or a provider research note of its own.

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

const TONE_VARIANT: Record<TenantAcquisitionProviderStatus["view"]["tone"], "default" | "destructive" | "outline"> = {
  ok: "default",
  attention: "destructive",
  neutral: "outline",
}

/** What each capability means to the person choosing it (the route-table names stay on the server). */
const CAPABILITY_LABEL: Record<string, string> = {
  motivated_seller_list: "Motivated-seller lists",
  owner_contact: "Owner contact details",
  property_facts: "Property facts",
  dnc_tcpa: "Do-not-call checks",
  acquisition_preview: "List previews",
  seller_signal_score: "Seller signals",
  online_presence: "Online presence",
}
const capabilityLabel = (c: string) => CAPABILITY_LABEL[c] ?? c.replace(/_/g, " ")

/** Scheduled pulls under a tenant's own account are accepted as configuration but NOT scheduled yet (lane 151F blind spot;
 *  no cron reads them) — so the choice says so instead of promising data that never arrives. */
function frequencyLine(provider: string, frequency: "push" | "daily" | "weekly" | null): string | null {
  if (!frequency) return null
  if (frequency === "push") return `New data arrives when ${provider} sends it.`
  return `Scheduled ${frequency} pulls aren't running yet — new data arrives only when ${provider} sends it.`
}

type ConnectResult = { webhookPath: string | null; webhookSecretOnce: string | null; view: TenantAcquisitionProviderStatus["view"] }

function ConnectForm({ p, onDone }: { p: TenantAcquisitionProviderStatus; onDone: (r: ConnectResult) => void }) {
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
          onDone({ webhookPath: r.webhookPath, webhookSecretOnce: r.webhookSecretOnce, view: r.view })
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
        <legend className="px-1 text-xs font-medium">Your agreement with {p.label}</legend>
        <div className="flex flex-wrap gap-3 text-xs">
          {p.capabilities.map((c) => (
            <label key={c} className="flex items-center gap-1">
              <input type="checkbox" checked={scopes.includes(c)} onChange={(e) => setScopes((s) => (e.target.checked ? [...s, c] : s.filter((x) => x !== c)))} />
              <span>{capabilityLabel(c)}</span>
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={licenseAck} onChange={(e) => setLicenseAck(e.target.checked)} required />
          <span>{p.attestation}</span>
        </label>
        <div className="grid gap-2 sm:grid-cols-3 text-xs">
          <label className="space-y-1"><span>Keep records for (days)</span><Input type="number" min={1} max={3650} value={retention} onChange={(e) => setRetention(e.target.value)} /></label>
          <label className="flex items-end gap-2 pb-2"><input type="checkbox" checked={aiProcessing} onChange={(e) => setAiProcessing(e.target.checked)} /><span>The AI may work these records</span></label>
          {p.view.costLine && <div className="text-[11px] text-muted-foreground pt-4">{p.view.costLine}</div>}
        </div>
      </fieldset>
      <fieldset className="rounded-md border p-3 space-y-2">
        <legend className="px-1 text-xs font-medium">Area, delivery and limits</legend>
        <div className="grid gap-2 sm:grid-cols-4 text-xs">
          <label className="space-y-1"><span>State *</span><Input value={state} onChange={(e) => setState(e.target.value)} placeholder="FL" maxLength={2} required /></label>
          <label className="space-y-1 sm:col-span-2"><span>ZIP codes *</span><Input value={zips} onChange={(e) => setZips(e.target.value)} placeholder="32501, 32502" required /></label>
          <label className="space-y-1"><span>City</span><Input value={city} onChange={(e) => setCity(e.target.value)} /></label>
          <label className="space-y-1"><span>How new data arrives</span>
            <select className="w-full rounded-md border bg-background px-2 py-2" value={frequency} onChange={(e) => setFrequency(e.target.value as "push" | "daily" | "weekly")}>
              {p.transports.includes("signed_webhook") && <option value="push">When {p.label} sends it (recommended)</option>}
              <option value="daily">Daily pull — not running yet</option>
              <option value="weekly">Weekly pull — not running yet</option>
            </select>
          </label>
          <label className="space-y-1"><span>Records per day (0 = only {p.label}&apos;s own limits)</span><Input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} /></label>
        </div>
      </fieldset>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Connecting and checking…" : p.connection ? "Update and re-check" : "Connect and check"}</Button>
    </form>
  )
}

export function AcquisitionProvidersPanel({ providers, encryptionConfigured }: { providers: TenantAcquisitionProviderStatus[]; encryptionConfigured: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState<string | null>(null)
  const [once, setOnce] = useState<Record<string, ConnectResult>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [pending, start] = useTransition()
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Your own data provider accounts</CardTitle>
        <CardDescription className="text-xs">
          Lead acquisition is part of your subscription. If you also have your own account with a supported data provider, you
          can connect it here. What you enter is stored encrypted and checked against your provider account, and the records it
          brings in go through the same intake and duplicate checks as every other source. That provider bills its own account
          directly — it&apos;s separate from your subscription.
        </CardDescription>
        {!encryptionConfigured && <p className="text-xs text-destructive">Connecting your own provider account isn’t available yet — nothing you enter would be stored. Your other sources keep working.</p>}
      </CardHeader>
      <CardContent className="space-y-3">
        {providers.map((p) => {
          const connectable = p.transports.length > 0 && !["unsupported", "pending_owner_licensing", "unavailable"].includes(p.state)
          const shown = once[p.key]
          const freq = frequencyLine(p.label, p.connection?.frequency ?? null)
          return (
            <div key={p.key} className="rounded-md border p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.label}</span>
                  <Badge variant={TONE_VARIANT[p.view.tone]}>{p.view.label}</Badge>
                  {p.connection?.accountLabel && <span className="text-xs text-muted-foreground">· {p.connection.accountLabel}</span>}
                </div>
                <div className="flex items-center gap-2">
                  {connectable && (
                    <Button size="sm" variant={open === p.key ? "secondary" : p.connection ? "outline" : "default"} disabled={!encryptionConfigured} onClick={() => setOpen((o) => (o === p.key ? null : p.key))}>
                      {open === p.key ? "Close" : p.view.message.action?.label ?? (p.connection ? "Update connection" : "Connect provider")}
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
              <p className="text-xs text-muted-foreground">{p.view.message.text}</p>
              {(p.view.credentialLine || p.view.costLine) && (
                <p className="text-[11px] text-muted-foreground">{[p.view.credentialLine, p.view.costLine].filter(Boolean).join(" ")}</p>
              )}
              {p.connection && (
                <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                  {p.connection.territory && <span>Area: {p.connection.territory.state} · {p.connection.territory.zip_codes.join(", ")}</span>}
                  {freq && <span>{freq}</span>}
                  {p.connection.rateLimitPerDay !== null && <span>Records per day: {p.connection.rateLimitPerDay || `${p.label}'s own limits only`}</span>}
                  {p.connection.agreement && <span>Uses: {p.connection.agreement.scopes.map(capabilityLabel).join(", ")} · records kept {p.connection.agreement.retention_days} days · AI may work them: {p.connection.agreement.ai_processing_permitted ? "yes" : "no"}</span>}
                  {p.connection.lastCheckedAt && <span>Last checked {p.connection.lastCheckedAt.slice(0, 10)}</span>}
                  {p.webhookPath && <span>Delivery address at {p.label}: <code>{p.webhookPath}</code> (its signing value was shown once, when you connected)</span>}
                </div>
              )}
              {rowError[p.key] && <p className="text-xs text-destructive">{rowError[p.key]}</p>}
              {shown && (
                <div className="rounded-md border border-emerald-300 bg-emerald-50/50 p-3 text-xs space-y-1">
                  <p><strong>{shown.view.label}</strong> — {shown.view.message.text}</p>
                  {shown.webhookPath && <p>Paste this delivery address at {p.label}: <code>{shown.webhookPath}</code></p>}
                  {shown.webhookSecretOnce && <p>Signing value (shown once — save it at {p.label} as the <code>x-webhook-secret</code> header): <code>{shown.webhookSecretOnce}</code></p>}
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
