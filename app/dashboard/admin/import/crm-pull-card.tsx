"use client"

// "Bring your database with you" — pull contacts from the tenant's OLD CRM
// through the SAME gated pipeline as a CSV upload (field steward → notes for
// unknowns, enum normalizer, consent never fabricated). The switching-cost
// killer, gate intact.
import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  setCrmImportCredentialAction, runCrmImportAction, getCrmImportStatusAction,
} from "@/app/actions/lead-import/crm-pull-actions"
import type { CrmImportProvider } from "@/lib/crm/import-pull"

const PROVIDERS: Array<{ key: CrmImportProvider; label: string; keyHint: string; extra?: "apiUrl" | "locationId" }> = [
  { key: "followupboss", label: "Follow Up Boss", keyHint: "FUB API key" },
  { key: "lofty", label: "Lofty / Chime", keyHint: "Lofty API token", extra: "apiUrl" },
  { key: "hubspot", label: "HubSpot", keyHint: "Private-app token" },
  { key: "gohighlevel", label: "GoHighLevel", keyHint: "GHL API key", extra: "locationId" },
]

export function CrmPullCard() {
  const [connected, setConnected] = useState<string[]>([])
  const [provider, setProvider] = useState<CrmImportProvider>("followupboss")
  const [apiKey, setApiKey] = useState("")
  const [extra, setExtra] = useState("")
  const [cursor, setCursor] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => { getCrmImportStatusAction().then((r) => { if (r.ok) setConnected(r.connected) }) }, [])
  const meta = PROVIDERS.find((p) => p.key === provider)!

  function connect() {
    setMsg(null)
    start(async () => {
      const r = await setCrmImportCredentialAction({
        provider, apiKey,
        apiUrl: meta.extra === "apiUrl" ? extra || undefined : undefined,
        locationId: meta.extra === "locationId" ? extra || undefined : undefined,
      })
      if (!r.ok) { setMsg(r.error ?? "Failed"); return }
      setMsg(`${meta.label} connected — run the import when ready.`)
      setApiKey(""); setExtra("")
      getCrmImportStatusAction().then((s) => { if (s.ok) setConnected(s.connected) })
    })
  }

  function run(resume = false) {
    setMsg(null)
    start(async () => {
      const r = await runCrmImportAction({ provider, cursor: resume ? cursor : null })
      if (!r.ok && r.pagesPulled === 0) { setMsg(r.error ?? "Import failed"); return }
      setCursor(r.nextCursor)
      setMsg(
        `${meta.label}: ${r.created} created, ${r.merged} merged, ${r.failed} failed` +
        (r.error ? ` (stopped early: ${r.error})` : "") +
        (r.nextCursor ? " — more contacts remain, continue below." : " — all done. Everything unrecognized landed safely in notes; your AI team starts on the contacts tonight."),
      )
    })
  }

  return (
    <Card className="mt-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Pull from your old CRM</CardTitle>
        <CardDescription className="text-xs">
          Connect Follow Up Boss, Lofty, HubSpot, or GoHighLevel and import directly — through the same
          safeguards as a CSV: names, emails, phones and addresses land on contacts; anything else is kept
          in notes so your AI team&apos;s automations stay clean. Consent is never assumed from another system.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <button key={p.key} onClick={() => { setProvider(p.key); setMsg(null); setCursor(null) }}
              className={`rounded-md border px-3 py-1.5 text-sm ${provider === p.key ? "bg-slate-900 text-white" : ""}`}>
              {p.label}{connected.includes(p.key) ? " ✓" : ""}
            </button>
          ))}
        </div>
        {!connected.includes(provider) && (
          <div className="flex flex-wrap items-center gap-2">
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={meta.keyHint} className="w-64" />
            {meta.extra && (
              <Input value={extra} onChange={(e) => setExtra(e.target.value)}
                placeholder={meta.extra === "apiUrl" ? "API base URL (optional)" : "Location ID"} className="w-56" />
            )}
            <Button variant="outline" onClick={connect} disabled={pending || apiKey.trim().length < 10}>Connect</Button>
          </div>
        )}
        {connected.includes(provider) && (
          <div className="flex items-center gap-2">
            <Button onClick={() => run(false)} disabled={pending}>
              {pending ? "Importing…" : `Import from ${meta.label}`}
            </Button>
            {cursor && (
              <Button variant="outline" onClick={() => run(true)} disabled={pending}>Continue import</Button>
            )}
          </div>
        )}
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  )
}
