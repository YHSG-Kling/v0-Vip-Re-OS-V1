'use client'

/**
 * EXTRACTED FACTS — the human loop on the document kernel's per-field
 * ledger. Every fact the AI read out of a scanned deal document, with a
 * one-click confirm / inline correct. Verifying a fact lifts it to high
 * confidence AND re-derives the document's deadlines — a medium-confidence
 * amber proposal becomes a green tracked deadline the moment the TC
 * confirms the date (the assisted→autonomous ladder, visible).
 */

import { useState, useEffect, useTransition } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScanSearch, Check, Pencil, Loader2 } from 'lucide-react'
import {
  listRecentExtractionsAction,
  verifyExtractionAction,
  type ExtractionRow,
} from '@/app/actions/document-extractions'

const CONFIDENCE_STYLE: Record<string, string> = {
  high: 'bg-green-100 text-green-800',
  medium: 'bg-amber-100 text-amber-900',
  low: 'bg-red-100 text-red-800',
}

export function ExtractedFactsPanel() {
  const [rows, setRows] = useState<ExtractionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  useEffect(() => {
    listRecentExtractionsAction({ limit: 25 })
      .then((r) => { if (r.ok && r.rows) setRows(r.rows) })
      .finally(() => setLoading(false))
  }, [])

  const verify = (id: string, correctedValue?: string) => {
    setBusy(id)
    startTransition(async () => {
      try {
        const r = await verifyExtractionAction({ extractionId: id, correctedValue })
        if (r.ok) {
          setRows((prev) => prev.map((row) =>
            row.id === id
              ? { ...row, verified: true, confidence: 'high', value: correctedValue ?? row.value }
              : row,
          ))
          setEditing(null)
        }
      } finally {
        setBusy(null)
      }
    })
  }

  const unverified = rows.filter((r) => !r.verified).length
  const fmt = (v: unknown) =>
    typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '—' : JSON.stringify(v)

  return (
    <Card className="border-l-4 border-l-teal-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Extracted Facts</CardTitle>
            <CardDescription>
              What the AI read from your deal documents — confirm or correct each fact
            </CardDescription>
          </div>
          <ScanSearch className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {unverified > 0 && (
          <p className="text-xs text-amber-700">
            {unverified} fact{unverified !== 1 ? 's' : ''} awaiting your confirmation — a confirmed date can start tracking a deadline automatically.
          </p>
        )}
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading extracted facts…</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No scanned document facts yet</div>
          ) : (
            rows.map((r) => (
              <div key={r.id} className="rounded-lg border p-3 space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{r.fieldKey.replace(/_/g, ' ')}</span>
                  <Badge className={`text-[10px] ${CONFIDENCE_STYLE[r.confidence] ?? 'bg-gray-100 text-gray-700'}`}>
                    {r.confidence}
                  </Badge>
                  {r.verified && <Badge className="text-[10px] bg-green-100 text-green-800">✓ verified</Badge>}
                  {r.classification && (
                    <span className="ml-auto text-[11px] text-muted-foreground capitalize">
                      {r.classification.replace(/_/g, ' ')}
                    </span>
                  )}
                </div>
                {editing === r.id ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="h-8 text-sm"
                      aria-label="Corrected value"
                    />
                    <Button size="sm" className="h-8" disabled={busy === r.id || !editValue.trim()} onClick={() => verify(r.id, editValue)}>
                      {busy === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-muted-foreground break-all">{fmt(r.value)}</p>
                    {!r.verified && (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" disabled={busy === r.id} onClick={() => verify(r.id)}>
                          {busy === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Confirm
                        </Button>
                        <Button
                          size="sm" variant="ghost" className="h-7 text-xs gap-1"
                          onClick={() => { setEditing(r.id); setEditValue(typeof r.value === 'string' ? r.value : fmt(r.value)) }}
                        >
                          <Pencil className="h-3 w-3" /> Correct
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
