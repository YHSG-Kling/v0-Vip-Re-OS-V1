'use client'

import React, { useCallback, useRef, useState, useTransition } from 'react'
import { CrmPullCard } from "./crm-pull-card"
import { createImportRecord, runImport, listImports } from '@/app/actions/lead-import/import-actions'

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'upload' | 'map' | 'importing' | 'summary'

type ImportResult = { created: number; merged: number; failed: number }

type ImportRecord = {
  id: string
  file_name: string
  status: string
  total_rows: number
  created_count: number
  merged_count: number
  failed_count: number
  created_at: string
  completed_at: string | null
}

// Known target fields — the Data Steward canonical set (identity + physical address +
// mailing breakdown + independently-gated secondary phone). Columns left unmapped are
// NOT dropped: the import routes them into the contact's notes.
const TARGET_FIELDS = [
  { value: 'first_name', label: 'First Name' },
  { value: 'last_name', label: 'Last Name' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'phone_secondary', label: 'Secondary Phone' },
  { value: 'address', label: 'Street Address' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'zip_code', label: 'Zip Code' },
  { value: 'mailing_address', label: 'Mailing Address' },
  { value: 'mailing_city', label: 'Mailing City' },
  { value: 'mailing_state', label: 'Mailing State' },
  { value: 'mailing_zip', label: 'Mailing Zip' },
  // Classification columns — imported VALUES are auto-normalized to our canonical
  // vocabulary (synonyms first, then one batched AI match); anything that can't be
  // confidently matched is preserved in the contact's notes, never guessed.
  { value: 'contact_type', label: 'Contact Type' },
  { value: 'lead_temperature', label: 'Lead Temperature' },
  { value: 'lender_status', label: 'Lender / Financing Status' },
  { value: 'preferred_channel', label: 'Preferred Contact Method' },
  { value: 'tcpa_consent', label: 'TCPA Consent' },
]

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return { headers: [], rows: [] }
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''))
  const rows = lines.slice(1).map((line) => {
    const vals = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''))
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    return row
  })
  return { headers, rows }
}

function autoDetectMapping(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  const normalize = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '')
  const aliases: Record<string, string> = {
    firstname: 'first_name', fname: 'first_name',
    lastname: 'last_name', lname: 'last_name', surname: 'last_name',
    email: 'email', emailaddress: 'email',
    phone: 'phone', mobile: 'phone', phonenumber: 'phone', cell: 'phone', mobilephone: 'phone', cellphone: 'phone',
    secondaryphone: 'phone_secondary', homephone: 'phone_secondary', workphone: 'phone_secondary', phone2: 'phone_secondary',
    address: 'address', streetaddress: 'address', address1: 'address', street: 'address',
    city: 'city', state: 'state', province: 'state',
    zip: 'zip_code', zipcode: 'zip_code', postalcode: 'zip_code', postal: 'zip_code',
    mailingaddress: 'mailing_address', mailingcity: 'mailing_city',
    mailingstate: 'mailing_state', mailingzip: 'mailing_zip', mailingpostalcode: 'mailing_zip',
    contacttype: 'contact_type', leadtype: 'contact_type', type: 'contact_type', category: 'contact_type',
    temperature: 'lead_temperature', leadtemperature: 'lead_temperature', rating: 'lead_temperature',
    lenderstatus: 'lender_status', financing: 'lender_status', preapproval: 'lender_status',
    preferredcontact: 'preferred_channel', preferredcontactmethod: 'preferred_channel', contactmethod: 'preferred_channel',
    tcpaconsent: 'tcpa_consent', consent: 'tcpa_consent', optins: 'tcpa_consent',
  }
  for (const h of headers) {
    const matched = aliases[normalize(h)]
    if (matched) map[h] = matched
    else map[h] = ''
  }
  return map
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ImportPage() {
  const [step, setStep] = useState<Step>('upload')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [fileName, setFileName] = useState('')
  const [fieldMap, setFieldMap] = useState<Record<string, string>>({})
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<ImportRecord[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isPending, startTransition] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  // Load history on mount
  React.useEffect(() => {
    listImports()
      .then(setHistory)
      .catch(() => {})
      .finally(() => setHistoryLoaded(true))
  }, [])

  // ── File handling ────────────────────────────────────────────────────────────

  const handleFile = useCallback((file: File) => {
    setError(null)
    if (!file.name.endsWith('.csv')) {
      setError('Only .csv files are supported.')
      return
    }
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const { headers: h, rows: r } = parseCSV(text)
      if (h.length === 0) { setError('CSV has no headers or is empty.'); return }
      setHeaders(h)
      setRows(r)
      setFieldMap(autoDetectMapping(h))
      setStep('map')
    }
    reader.readAsText(file)
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  // ── Import ────────────────────────────────────────────────────────────────────

  const handleImport = () => {
    setError(null)
    startTransition(async () => {
      try {
        setStep('importing')
        const { importId } = await createImportRecord({
          fileName,
          totalRows: rows.length,
          fieldMap,
        })
        const res = await runImport({ importId, rows, fieldMap })
        setResult(res)
        setStep('summary')
        // Refresh history
        listImports().then(setHistory).catch(() => {})
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Import failed.')
        setStep('map')
      }
    })
  }

  const reset = () => {
    setStep('upload')
    setHeaders([])
    setRows([])
    setFileName('')
    setFieldMap({})
    setResult(null)
    setError(null)
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 font-sans">
      <h1 className="text-2xl font-semibold text-foreground mb-1">Lead Import</h1>
      <p className="text-sm text-muted-foreground mb-8">
        Bulk import contacts from a CSV. Each row goes through dedup, merge, enrich, and score.
      </p>

      {error && (
        <div className="mb-6 rounded-md bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* ── Step 1: Upload ─────────────────────────────────────────────────── */}
      {step === 'upload' && (
        <section className="mb-10">
          <div
            className={`rounded-xl border-2 border-dashed transition-colors cursor-pointer flex flex-col items-center justify-center gap-3 py-16 px-8 ${
              isDragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/30 hover:border-primary/50'
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Upload CSV file"
            onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
          >
            <svg className="w-10 h-10 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <p className="text-sm font-medium text-foreground">Drop your CSV here or click to browse</p>
            <p className="text-xs text-muted-foreground">Supports .csv files only</p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
            />
          </div>
        </section>
      )}

      {/* ── Step 2: Column Mapping ─────────────────────────────────────────── */}
      {step === 'map' && (
        <section className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Map Columns</h2>
              <p className="text-sm text-muted-foreground">{rows.length} rows in <span className="font-medium">{fileName}</span></p>
            </div>
            <button onClick={reset} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Start over
            </button>
          </div>

          {/* Mapping table */}
          <div className="rounded-lg border border-border overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">CSV Column</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Maps to</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Preview</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {headers.map((h) => (
                  <tr key={h} className="bg-background">
                    <td className="px-4 py-3 font-medium text-foreground">{h}</td>
                    <td className="px-4 py-3">
                      <select
                        value={fieldMap[h] ?? ''}
                        onChange={(e) => setFieldMap((prev) => ({ ...prev, [h]: e.target.value }))}
                        className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="">— skip —</option>
                        {TARGET_FIELDS.map((f) => (
                          <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground truncate max-w-xs">
                      {rows.slice(0, 3).map((r) => r[h]).filter(Boolean).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Preview */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-foreground mb-2">Preview (first 5 rows)</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    {headers.map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.slice(0, 5).map((r, i) => (
                    <tr key={i} className="bg-background">
                      {headers.map((h) => (
                        <td key={h} className="px-3 py-2 text-foreground truncate max-w-[120px]">{r[h] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <button
            onClick={handleImport}
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            Import {rows.length} rows
          </button>
        </section>
      )}

      {/* ── Step 3: Importing ──────────────────────────────────────────────── */}
      {step === 'importing' && (
        <section className="mb-10 flex flex-col items-center gap-6 py-16">
          <div className="w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin" aria-label="Importing..." />
          <p className="text-base font-medium text-foreground">Importing {rows.length} rows&hellip;</p>
          <p className="text-sm text-muted-foreground">Each contact is being deduped, merged, enriched, and scored.</p>
        </section>
      )}

      {/* ── Step 4: Summary ────────────────────────────────────────────────── */}
      {step === 'summary' && result && (
        <section className="mb-10">
          <h2 className="text-lg font-semibold text-foreground mb-4">Import Complete</h2>
          <div className="grid grid-cols-3 gap-4 mb-6">
            {[
              { label: 'Created', value: result.created, color: 'text-green-600 dark:text-green-400' },
              { label: 'Merged', value: result.merged, color: 'text-blue-600 dark:text-blue-400' },
              { label: 'Failed', value: result.failed, color: 'text-destructive' },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-border bg-card p-5 text-center">
                <p className={`text-3xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-sm text-muted-foreground mt-1">{s.label}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-3">
            <button onClick={reset} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
              Import another file
            </button>
            <a href="/crm/contacts" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
              View contacts
            </a>
          </div>
        </section>
      )}

      {/* ── History ───────────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-foreground mb-3">Import History</h2>
        {!historyLoaded ? (
          <p className="text-sm text-muted-foreground">Loading&hellip;</p>
        ) : history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No imports yet.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">File</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Total</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Created</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Merged</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Failed</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {history.map((imp) => (
                  <tr key={imp.id} className="bg-background hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground max-w-[200px] truncate">{imp.file_name}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        imp.status === 'completed'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                          : imp.status === 'processing'
                          ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
                          : 'bg-destructive/10 text-destructive'
                      }`}>
                        {imp.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{imp.total_rows}</td>
                    <td className="px-4 py-3 text-right text-green-600 dark:text-green-400 font-medium">{imp.created_count}</td>
                    <td className="px-4 py-3 text-right text-blue-600 dark:text-blue-400 font-medium">{imp.merged_count}</td>
                    <td className="px-4 py-3 text-right text-destructive font-medium">{imp.failed_count}</td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {new Date(imp.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Bring your database with you — old-CRM pull through the SAME gate */}
      <CrmPullCard />
    </main>
  )
}
