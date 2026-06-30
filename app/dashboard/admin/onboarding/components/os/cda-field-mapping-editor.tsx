"use client"

/**
 * CdaFieldMappingEditor — the autonomous-AI auto-binding review UI.
 *
 * A brokerage's CDA PDF has its OWN fillable fields. This editor:
 *   1. "Auto-detect with AI" → extracts the PDF's AcroForm fields and suggests a
 *      source binding for each (waterfall / transaction / agent input / static).
 *   2. The broker reviews + edits each row (one-click confirm, full control).
 *   3. Save → persists the bindings so the agent's CDA auto-fills from the live
 *      commission waterfall instead of hand-typing every number.
 *
 * Writes go through the existing actions in app/actions/cda-template-field-actions.ts
 * (autoBindCdaTemplateAction / getCdaTemplateFieldDefsAction / saveCdaTemplateFieldDefsAction).
 */

import { useEffect, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sparkles, Save, Loader2, Lock, X } from "lucide-react"
import {
  autoBindCdaTemplateAction,
  getCdaTemplateFieldDefsAction,
  saveCdaTemplateFieldDefsAction,
} from "@/app/actions/cda-template-field-actions"
import { toast } from "sonner"

type Source = "waterfall" | "transaction" | "agent_input" | "static"
type FieldType = "currency" | "percent" | "date" | "text"

type Row = {
  field_key: string
  label: string
  source: Source
  source_key: string | null
  field_type: FieldType
  static_value?: string | null
  required: boolean
  display_order: number
  pdf_field?: string
  confidence?: number
}

const WATERFALL_OPTS: Array<{ key: string; label: string; type: FieldType }> = [
  { key: "gross_commission", label: "Gross Commission", type: "currency" },
  { key: "agent_net", label: "Agent Net Commission", type: "currency" },
  { key: "brokerage_net", label: "Brokerage Net Commission", type: "currency" },
  { key: "agent_split_percent", label: "Agent Split %", type: "percent" },
  { key: "fees", label: "Fees", type: "currency" },
  { key: "team_split", label: "Team Split", type: "currency" },
  { key: "revenue_share", label: "Revenue Share", type: "currency" },
]
const TRANSACTION_OPTS: Array<{ key: string; label: string; type: FieldType }> = [
  { key: "property_address", label: "Property Address", type: "text" },
  { key: "close_date", label: "Closing Date", type: "date" },
  { key: "sale_price", label: "Sale Price", type: "currency" },
]

function defaultsForSource(source: Source): { source_key: string | null; field_type: FieldType } {
  if (source === "waterfall") return { source_key: WATERFALL_OPTS[0].key, field_type: WATERFALL_OPTS[0].type }
  if (source === "transaction") return { source_key: TRANSACTION_OPTS[0].key, field_type: TRANSACTION_OPTS[0].type }
  return { source_key: null, field_type: "text" }
}

export function CdaFieldMappingEditor({
  templateId,
  templateName,
  onClose,
}: {
  templateId: string
  templateName: string
  onClose: () => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [detecting, setDetecting] = useState(false)
  const [saving, startSave] = useTransition()

  useEffect(() => {
    let cancelled = false
    getCdaTemplateFieldDefsAction({ templateId }).then((res) => {
      if (cancelled) return
      if (res.success) {
        setRows(
          res.fields.map((f, i) => ({
            field_key: f.field_key,
            label: f.label ?? f.field_key,
            source: f.source as Source,
            source_key: f.source_key ?? null,
            field_type: f.field_type as FieldType,
            static_value: f.static_value ?? null,
            required: !!f.required,
            display_order: f.display_order ?? i,
            pdf_field: f.pdf_field ?? undefined,
          })),
        )
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [templateId])

  async function autoDetect() {
    setDetecting(true)
    try {
      const res = await autoBindCdaTemplateAction({ templateId })
      if (!res.success) {
        toast.error(res.error === "no_pdf" ? "This template has no PDF to read" : `Detect failed: ${res.error}`)
        return
      }
      if (!res.hasAcroForm) {
        toast.warning("This PDF has no fillable form fields. Add AcroForm fields to the PDF, or add bindings manually.")
        return
      }
      setRows(
        res.suggestions.map((s, i) => ({
          field_key: s.field_key,
          label: s.label ?? s.field_key,
          source: s.source as Source,
          source_key: s.source_key ?? null,
          field_type: s.field_type as FieldType,
          static_value: s.static_value ?? null,
          required: !!s.required,
          display_order: s.display_order ?? i,
          pdf_field: s.pdf_field,
          confidence: s.confidence,
        })),
      )
      toast.success(`Detected ${res.pdfFieldCount} field${res.pdfFieldCount === 1 ? "" : "s"} — review the suggested mapping and save`)
    } finally {
      setDetecting(false)
    }
  }

  function patch(i: number, next: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...next } : r)))
  }

  function changeSource(i: number, source: Source) {
    patch(i, { source, ...defaultsForSource(source) })
  }

  function changeSourceKey(i: number, key: string, source: Source) {
    const opts = source === "waterfall" ? WATERFALL_OPTS : TRANSACTION_OPTS
    const match = opts.find((o) => o.key === key)
    patch(i, { source_key: key, field_type: match?.type ?? "text" })
  }

  function save() {
    startSave(async () => {
      const res = await saveCdaTemplateFieldDefsAction({
        templateId,
        fields: rows.map((r, i) => ({
          field_key: r.field_key,
          label: r.label,
          source: r.source,
          source_key: r.source_key,
          field_type: r.field_type,
          static_value: r.source === "static" ? r.static_value ?? null : null,
          required: r.required,
          display_order: i,
          pdf_field: r.pdf_field ?? null,
        })),
      })
      if (res.success) {
        toast.success(`Saved ${res.count} field binding${res.count === 1 ? "" : "s"}`)
        onClose()
      } else {
        toast.error("error" in res ? res.error : "Save failed")
      }
    })
  }

  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-semibold">Field mapping — {templateName}</Label>
          <p className="text-xs text-muted-foreground">
            Bind each form field to the live commission waterfall, the transaction, or the agent. Locked
            sources auto-fill; agent inputs are typed at closing.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void autoDetect()} disabled={detecting}>
          {detecting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
          Auto-detect with AI
        </Button>
        {rows.length > 0 && <Badge variant="outline">{rows.length} field{rows.length === 1 ? "" : "s"}</Badge>}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          No field bindings yet. Click <span className="font-medium">Auto-detect with AI</span> to read this
          CDA PDF's fillable fields and suggest a mapping.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => {
            const keyOpts = r.source === "waterfall" ? WATERFALL_OPTS : r.source === "transaction" ? TRANSACTION_OPTS : []
            const locked = r.source !== "agent_input"
            return (
              <div key={r.field_key} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center rounded-md border bg-background p-2">
                <div className="sm:col-span-3 min-w-0">
                  <div className="flex items-center gap-1 text-xs font-medium truncate" title={r.pdf_field ?? r.label}>
                    {locked && <Lock className="h-3 w-3 text-muted-foreground shrink-0" />}
                    {r.pdf_field ?? r.label}
                  </div>
                  {typeof r.confidence === "number" && (
                    <span className={`text-[10px] ${r.confidence >= 0.7 ? "text-emerald-600" : r.confidence >= 0.5 ? "text-amber-600" : "text-muted-foreground"}`}>
                      {Math.round(r.confidence * 100)}% match
                    </span>
                  )}
                </div>

                <div className="sm:col-span-3">
                  <Select value={r.source} onValueChange={(v) => changeSource(i, v as Source)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="waterfall">Commission waterfall</SelectItem>
                      <SelectItem value="transaction">Transaction</SelectItem>
                      <SelectItem value="agent_input">Agent fills in</SelectItem>
                      <SelectItem value="static">Static value</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="sm:col-span-4">
                  {keyOpts.length > 0 ? (
                    <Select value={r.source_key ?? ""} onValueChange={(v) => changeSourceKey(i, v, r.source)}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Pick a value" /></SelectTrigger>
                      <SelectContent>
                        {keyOpts.map((o) => <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : r.source === "static" ? (
                    <Input className="h-8 text-xs" placeholder="Fixed value" value={r.static_value ?? ""} onChange={(e) => patch(i, { static_value: e.target.value })} />
                  ) : (
                    <span className="text-xs text-muted-foreground">Typed by the agent at closing</span>
                  )}
                </div>

                <div className="sm:col-span-2 flex items-center justify-end gap-2">
                  <Badge variant="secondary" className="text-[10px]">{r.field_type}</Badge>
                  {r.source === "agent_input" && (
                    <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <input type="checkbox" checked={r.required} onChange={(e) => patch(i, { required: e.target.checked })} />
                      req
                    </label>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save mapping
          </Button>
        </div>
      )}
    </div>
  )
}
