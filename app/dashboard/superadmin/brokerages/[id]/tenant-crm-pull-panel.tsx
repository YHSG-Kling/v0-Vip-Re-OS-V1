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
//
// WAVE 141 (lane 141D) — the inbound chain is now visible and enforced here:
// save key → PREVIEW (the explicit vendor-key → canonical-field mapping, the
// ignored vendor keys, importable / problem / would-be-duplicate counts and a
// sample — a dry run of the real lane, nothing written) → IMPORT, which carries
// the preview's token; the server recomputes it from the first page it pulls
// and refuses a commit whose mapping differs from what was reviewed.
import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Download, Eye, Loader2 } from "lucide-react"
import {
  setCrmImportCredentialAction, runCrmImportAction, getCrmImportStatusAction, previewCrmImportAction,
  type CrmImportPreview,
} from "@/app/actions/lead-import/crm-pull-actions"
import type { CrmImportProvider } from "@/lib/crm/import-pull"

// TOMBSTONE (wave 72A, owner ruling verbatim: "hubspot is only sync out to
// hubspot."): HubSpot used to be listed here as a migration-import source
// (an inbound pull). It is retired — HubSpot is sync-OUT only. Survivor: the
// tenant's own HubSpot connection stays on app/settings/connections
// (connection-center-client.tsx), which pushes TO HubSpot via
// lib/crm/providers/hubspot.ts:25 (`syncContactToHubSpot`) and never pulls.
const PROVIDERS: Array<{ key: CrmImportProvider; label: string; keyHint: string; extra?: "apiUrl" | "locationId" }> = [
  { key: "followupboss", label: "Follow Up Boss", keyHint: "FUB API key" },
  { key: "lofty", label: "Lofty / Chime", keyHint: "Lofty API token", extra: "apiUrl" },
  { key: "gohighlevel", label: "GoHighLevel", keyHint: "GHL API key", extra: "locationId" },
]

export function TenantCrmPullPanel({ brokerageId }: { brokerageId: string }) {
  const [connected, setConnected] = useState<string[]>([])
  const [provider, setProvider] = useState<CrmImportProvider>("followupboss")
  const [apiKey, setApiKey] = useState("")
  const [extra, setExtra] = useState("")
  const [cursor, setCursor] = useState<string | null>(null)
  const [preview, setPreview] = useState<CrmImportPreview | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    getCrmImportStatusAction(brokerageId).then((r) => { if (r.ok) setConnected(r.connected) })
  }, [brokerageId])
  const meta = PROVIDERS.find((p) => p.key === provider)!

  function pickProvider(p: CrmImportProvider) {
    setProvider(p); setMsg(null); setErr(null); setCursor(null); setPreview(null)
  }

  function connect() {
    setMsg(null); setErr(null)
    start(async () => {
      const r = await setCrmImportCredentialAction({
        brokerageId, provider, apiKey,
        apiUrl: meta.extra === "apiUrl" ? extra || undefined : undefined,
        locationId: meta.extra === "locationId" ? extra || undefined : undefined,
      })
      if (!r.ok) { setErr(r.error ?? "Failed to save the key"); return }
      setMsg(`${meta.label} connected for this subscriber — preview the import when ready.`)
      setApiKey(""); setExtra("")
      const s = await getCrmImportStatusAction(brokerageId)
      if (s.ok) setConnected(s.connected)
    })
  }

  function runPreview() {
    setMsg(null); setErr(null); setPreview(null); setCursor(null)
    start(async () => {
      const r = await previewCrmImportAction({ brokerageId, provider })
      if (!r.ok) { setErr(r.error ?? "Preview failed"); if (r.previewToken) setPreview(r); return }
      setPreview(r)
    })
  }

  function run(resume = false) {
    if (!preview?.previewToken) { setErr("Preview the import first."); return }
    setMsg(null); setErr(null)
    start(async () => {
      const r = await runCrmImportAction({ brokerageId, provider, cursor: resume ? cursor : null, previewToken: preview.previewToken })
      setCursor(r.nextCursor)
      if (!r.ok && r.pagesPulled === 0) { setErr(r.error ?? "Import failed"); return }
      setMsg(
        `${meta.label}: ${r.created} imported` +
        (r.skippedDuplicates > 0 ? `, ${r.skippedDuplicates} skipped as duplicates` : "") +
        (r.failed > 0 ? `, ${r.failed} failed` : "") +
        (r.error ? ` — stopped early: ${r.error}` : "") +
        (r.evidenceImportId ? ` — recorded in the tenant's import history (${r.evidenceImportId.slice(0, 8)}…).` : "") +
        (r.nextCursor ? " More contacts remain, continue below." : " All done."),
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
          Connect this subscriber&apos;s Follow Up Boss, Lofty or GoHighLevel account and import
          their contacts straight into THIS tenant — the same safeguards as the CSV import above: names,
          emails, phones and addresses land on contacts, duplicates are skipped against the tenant&apos;s
          existing book, and consent is never imported as opted-in. Preview the field mapping first;
          the import is bound to the mapping you reviewed. Every preview and run is audit-logged.
        </p>

        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <button key={p.key} onClick={() => pickProvider(p.key)}
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
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={runPreview} disabled={pending}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
              Preview from {meta.label}
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => run(false)} disabled={pending || !preview?.previewToken}>
              <Download className="h-3.5 w-3.5" />
              Import from {meta.label}
            </Button>
            {cursor && (
              <Button variant="outline" size="sm" onClick={() => run(true)} disabled={pending || !preview?.previewToken}>
                Continue import
              </Button>
            )}
            <Badge variant="outline" className="text-[11px]">key saved</Badge>
          </div>
        )}

        {/* PREVIEW — the explicit mapping + what a commit of the first page would do. Nothing written. */}
        {preview && (
          <div className="rounded-md border p-3 space-y-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{preview.pageRows} row{preview.pageRows === 1 ? "" : "s"} on the first page</Badge>
              <Badge variant="outline">{preview.wouldInsert} would import</Badge>
              {preview.wouldSkipDuplicates > 0 && <Badge variant="outline">{preview.wouldSkipDuplicates} already in this tenant (skipped)</Badge>}
              {preview.problemCount > 0 && <Badge className="bg-amber-100 text-amber-800">{preview.problemCount} row{preview.problemCount === 1 ? "" : "s"} with problems</Badge>}
              {preview.moreRemain && <span className="text-muted-foreground">more pages follow — the import paginates</span>}
            </div>
            <div>
              <div className="font-medium mb-1">Field mapping (their field → our contact field)</div>
              <table className="w-full text-[11px]">
                <tbody>
                  {preview.mapping.map((m) => (
                    <tr key={m.vendorKey} className="border-t">
                      <td className="py-0.5 pr-3 font-mono">{m.vendorKey}</td>
                      <td className="py-0.5 text-muted-foreground">→ {m.canonical}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.ignoredKeys.length > 0 && (
                <p className="mt-1 text-muted-foreground">Not imported (no matching contact field): {preview.ignoredKeys.join(", ")}</p>
              )}
            </div>
            {preview.sample.length > 0 && (
              <div>
                <div className="font-medium mb-1">Sample</div>
                <table className="w-full text-[11px]">
                  <thead><tr className="text-left text-muted-foreground"><th className="pr-3">Name</th><th className="pr-3">Email</th><th className="pr-3">Phone</th><th>City/State</th></tr></thead>
                  <tbody>
                    {preview.sample.map((s, i) => (
                      <tr key={i} className="border-t">
                        <td className="py-0.5 pr-3">{s.name}</td><td className="py-0.5 pr-3">{s.email ?? "—"}</td>
                        <td className="py-0.5 pr-3">{s.phone ?? "—"}</td><td className="py-0.5">{s.cityState ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.problems.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 space-y-0.5">
                {preview.problems.map((p, i) => (<div key={i}><span className="font-mono">row {p.line}</span>: {p.problem}</div>))}
                {preview.problemCount > preview.problems.length && <div className="text-amber-700">…and {preview.problemCount - preview.problems.length} more</div>}
              </div>
            )}
          </div>
        )}

        {msg && <p className="text-xs text-emerald-700">{msg}</p>}
        {err && <p className="text-xs text-red-600">{err}</p>}
      </CardContent>
    </Card>
  )
}
