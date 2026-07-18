'use client'

// GHL-parity white-glove migration: import a new subscriber's CSV contacts (or
// draft listings) into THIS tenant from the god console. Dry-run preview runs
// the SAME pure parser the server uses (lib/platform/tenant-import-parser), so
// what staff see below is exactly what the import will attempt. Staff-gated +
// audited server-side; per-row errors come back with file line numbers.
import { useMemo, useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Upload, Loader2 } from 'lucide-react'
import { parseContactsCsv, parseListingsCsv, type CsvRowError } from '@/lib/platform/tenant-import-parser'
import {
  importTenantContactsAction, importTenantListingsAction, type TenantImportActionResult,
} from '@/app/actions/superadmin/tenant-import'

type Mode = 'contacts' | 'listings'
const PREVIEW_ROWS = 5
const MAX_ERRORS_SHOWN = 20

function ErrorList({ errors }: { errors: CsvRowError[] }) {
  if (errors.length === 0) return null
  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 space-y-0.5">
      {errors.slice(0, MAX_ERRORS_SHOWN).map((e, i) => (
        <div key={i}><span className="font-mono">line {e.line}</span>: {e.problem}</div>
      ))}
      {errors.length > MAX_ERRORS_SHOWN && <div className="text-amber-700">…and {errors.length - MAX_ERRORS_SHOWN} more</div>}
    </div>
  )
}

export function TenantImportPanel({ brokerageId }: { brokerageId: string }) {
  const [mode, setMode] = useState<Mode>('contacts')
  const [csvText, setCsvText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [dedupe, setDedupe] = useState(true)
  const [result, setResult] = useState<TenantImportActionResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Dry-run preview — client-side parse with the server's own parser.
  const preview = useMemo(() => {
    if (!csvText.trim()) return null
    return mode === 'contacts' ? parseContactsCsv(csvText) : parseListingsCsv(csvText)
  }, [csvText, mode])

  function onFile(f: File | null) {
    if (!f) return
    setErr(null); setResult(null)
    const reader = new FileReader()
    reader.onload = () => { setCsvText(String(reader.result ?? '')); setFileName(f.name) }
    reader.onerror = () => setErr('Could not read the file')
    reader.readAsText(f)
  }

  function runImport() {
    setErr(null); setResult(null)
    startTransition(async () => {
      const r = mode === 'contacts'
        ? await importTenantContactsAction({ brokerageId, csvText, dedupe: dedupe ? 'email_phone' : 'none' })
        : await importTenantListingsAction({ brokerageId, csvText })
      setResult(r)
      if (!r.ok) setErr(r.error ?? 'Import failed')
    })
  }

  const previewRows: { line: number; cols: (string | null)[] }[] = useMemo(() => {
    if (!preview) return []
    if (mode === 'contacts') {
      return (preview as ReturnType<typeof parseContactsCsv>).rows.slice(0, PREVIEW_ROWS).map((r) => ({
        line: r.line,
        cols: [[r.firstName, r.lastName].filter(Boolean).join(' ') || null, r.email, r.phone, [r.city, r.state].filter(Boolean).join(', ') || null],
      }))
    }
    return (preview as ReturnType<typeof parseListingsCsv>).rows.slice(0, PREVIEW_ROWS).map((r) => ({
      line: r.line,
      cols: [r.address, [r.city, r.state].filter(Boolean).join(', ') || null, r.listPrice != null ? `$${r.listPrice.toLocaleString()}` : null, r.listingDate],
    }))
  }, [preview, mode])

  const previewHead = mode === 'contacts' ? ['Name', 'Email', 'Phone', 'City/State'] : ['Address', 'City/State', 'List price', 'List date']

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2"><Upload className="h-4 w-4 text-primary" />Import data</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground max-w-2xl">
          White-glove migration: paste or upload the subscriber&apos;s CSV export from their old CRM and land it in
          THIS tenant. Contacts are anchored to the tenant&apos;s owner agent, stamped source &quot;import&quot;, and consent
          flags are never imported as opted-in. Listings land as drafts. Every run is audit-logged.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <select className="rounded border px-2 py-1 text-sm" value={mode}
            onChange={(e) => { setMode(e.target.value as Mode); setResult(null); setErr(null) }}>
            <option value="contacts">Contacts</option>
            <option value="listings">Listings (drafts)</option>
          </select>
          <input type="file" accept=".csv,text/csv,text/plain" className="text-xs"
            onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
          {mode === 'contacts' && (
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} />
              Skip duplicates (existing email or phone)
            </label>
          )}
        </div>

        <textarea
          className="w-full rounded border px-2 py-1.5 font-mono text-xs min-h-28"
          placeholder={mode === 'contacts'
            ? 'Paste CSV — headers like: first_name,last_name,email,phone,address,city,state,zip,source,notes,tags'
            : 'Paste CSV — headers like: address,city,state,zip,list_price,listing_date,mls_number'}
          value={csvText}
          onChange={(e) => { setCsvText(e.target.value); setFileName(null); setResult(null); setErr(null) }}
        />
        {fileName && <p className="text-[11px] text-muted-foreground -mt-2">Loaded from {fileName}</p>}

        {/* Dry-run preview — nothing is written until Import is clicked. */}
        {preview && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline">{preview.rows.length} importable row{preview.rows.length === 1 ? '' : 's'}</Badge>
              {preview.errors.length > 0 && <Badge className="bg-amber-100 text-amber-800">{preview.errors.length} row{preview.errors.length === 1 ? '' : 's'} with problems</Badge>}
              {preview.unmappedHeaders.length > 0 && (
                <span className="text-muted-foreground">Ignored columns: {preview.unmappedHeaders.join(', ')}</span>
              )}
            </div>
            {previewRows.length > 0 && (
              <div className="overflow-x-auto rounded border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/10">
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Line</th>
                      {previewHead.map((h) => <th key={h} className="text-left px-2 py-1.5 font-medium text-muted-foreground">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((r) => (
                      <tr key={r.line} className="border-b last:border-0">
                        <td className="px-2 py-1.5 font-mono text-muted-foreground">{r.line}</td>
                        {r.cols.map((c, i) => <td key={i} className="px-2 py-1.5">{c ?? '—'}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.rows.length > PREVIEW_ROWS && (
              <p className="text-[11px] text-muted-foreground">Showing first {PREVIEW_ROWS} of {preview.rows.length} rows.</p>
            )}
            <ErrorList errors={preview.errors} />
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button size="sm" className="gap-1.5" disabled={pending || !preview || preview.rows.length === 0} onClick={runImport}>
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Import {preview?.rows.length ?? 0} {mode === 'listings' ? 'listings' : 'contacts'}
          </Button>
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>

        {/* Post-import summary — honest counts, per-line failures included. */}
        {result?.ok && (
          <div className="space-y-2">
            <p className="text-xs text-emerald-700">
              Imported <span className="font-semibold">{result.inserted}</span> of {result.totalDataRows} row{result.totalDataRows === 1 ? '' : 's'}
              {result.skippedDuplicates > 0 && <> · {result.skippedDuplicates} skipped as duplicates</>}
              {result.errors.length > 0 && <> · {result.errors.length} failed</>}
            </p>
            <ErrorList errors={result.errors} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
