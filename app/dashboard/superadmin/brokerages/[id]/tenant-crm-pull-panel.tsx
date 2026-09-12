"use client"

// "Bring your database with you" — the API half of white-glove migration.
//
// Sits next to TenantImportPanel (the CSV half) because it is the same operation
// with a different row source: pull this subscriber's contacts out of their old
// CRM and land them in THIS tenant, through the same validation, the same
// owner-agent resolution, the same dedupe, and the same never-import-consent rule.
//
// Platform-staff surface. Pulling is taking a book of business out of another
// system; the tenant's own CRM link runs the other way (sync-OUT only) and lives
// on their Connections page.
import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Download, Loader2 } from "lucide-react"
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

export function TenantCrmPullPanel({ brokerageId }: { brokerageId: string }) {
  const [connected, setConnected] = useState<string[]>([])
  const [provider, setProvider] = useState<CrmImportProvider>("followupboss")
  const [apiKey, setApiKey] = useState("")
  const [extra, setExtra] = useState("")
  const [cursor, setCursor] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    getCrmImportStatusAction(brokerageId).then((r) => { if (r.ok) setConnected(r.connected) })
  }, [brokerageId])
  const meta = PROVIDERS.find((p) => p.key === provider)!

  function connect() {
    setMsg(null); setErr(null)
    start(async () => {
      const r = await setCrmImportCredentialAction({
        brokerageId, provider, apiKey,
        apiUrl: meta.extra === "apiUrl" ? extra || undefined : undefined,
        locationId: meta.extra === "locationId" ? extra || undefined : undefined,
      })
      if (!r.ok) { setErr(r.error ?? "Failed to save the key"); return }
      setMsg(`${meta.label} connected for this subscriber — run the import when ready.`)
      setApiKey(""); setExtra("")
      const s = await getCrmImportStatusAction(brokerageId)
      if (s.ok) setConnected(s.connected)
    })
  }

  function run(resume = false) {
    setMsg(null); setErr(null)
    start(async () => {
      const r = await runCrmImportAction({ brokerageId, provider, cursor: resume ? cursor : null })
      setCursor(r.nextCursor)
      if (!r.ok && r.pagesPulled === 0) { setErr(r.error ?? "Import failed"); return }
      setMsg(
        `${meta.label}: ${r.created} imported` +
        (r.skippedDuplicates > 0 ? `, ${r.skippedDuplicates} skipped as duplicates` : "") +
        (r.failed > 0 ? `, ${r.failed} failed` : "") +
        (r.error ? ` — stopped early: ${r.error}` : "") +
        (r.nextCursor ? " — more contacts remain, continue below." : " — all done."),
      )
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Download className="h-4 w-4 text-primary" />Pull from their old CRM
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground max-w-2xl">
          Connect this subscriber&apos;s Follow Up Boss, Lofty, HubSpot or GoHighLevel account and import
          their contacts straight into THIS tenant — the same safeguards as the CSV import above: names,
          emails, phones and addresses land on contacts, duplicates are skipped against the tenant&apos;s
          existing book, and consent is never imported as opted-in. Every run is audit-logged.
        </p>

        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <button key={p.key} onClick={() => { setProvider(p.key); setMsg(null); setErr(null); setCursor(null) }}
              className={`rounded-md border px-3 py-1.5 text-sm ${provider === p.key ? "bg-slate-900 text-white" : ""}`}>
              {p.label}{connected.includes(p.key) ? " ✓" : ""}
            </button>
          ))}
        </div>

        {!connected.includes(provider) && (
          <div className="flex flex-wrap items-center gap-2">
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={meta.keyHint} className="w-64" />
            {meta.extra && (
              <Input value={extra} onChange={(e) => setExtra(e.target.value)}
                placeholder={meta.extra === "apiUrl" ? "API base URL (optional)" : "Location ID"} className="w-56" />
            )}
            <Button variant="outline" size="sm" onClick={connect} disabled={pending || apiKey.trim().length < 10}>
              Save key
            </Button>
          </div>
        )}

        {connected.includes(provider) && (
          <div className="flex items-center gap-2">
            <Button size="sm" className="gap-1.5" onClick={() => run(false)} disabled={pending}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Import from {meta.label}
            </Button>
            {cursor && (
              <Button variant="outline" size="sm" onClick={() => run(true)} disabled={pending}>
                Continue import
              </Button>
            )}
            <Badge variant="outline" className="text-[11px]">key saved</Badge>
          </div>
        )}

        {msg && <p className="text-xs text-emerald-700">{msg}</p>}
        {err && <p className="text-xs text-red-600">{err}</p>}
      </CardContent>
    </Card>
  )
}
