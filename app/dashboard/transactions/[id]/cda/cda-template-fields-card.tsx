"use client"

// CdaTemplateFieldsCard — renders the brokerage's OWN CDA form fields, auto-filled
// from the live commission waterfall + the transaction (locked), with the agent
// filling only the agent-input fields. The differentiator: the brokerage's actual
// CDA form, populated by the waterfall — not a generic tally.

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, FileText, FileDown } from "lucide-react"
import { getCdaFormFieldsAction, saveCdaFieldInputsAction, generateFilledCdaPdfAction } from "@/app/actions/cda-template-field-actions"

interface ResolvedField {
  field_key: string
  label: string
  source: string
  value: string | number | null
  formatted: string
  editable: boolean
  field_type: string
}

export function CdaTemplateFieldsCard({ cdaId }: { cdaId: string }) {
  const [loading, setLoading] = useState(true)
  const [hasTemplate, setHasTemplate] = useState(false)
  const [fields, setFields] = useState<ResolvedField[]>([])
  const [missing, setMissing] = useState<string[]>([])
  const [inputs, setInputs] = useState<Record<string, string>>({})
  // The calculated defaults as loaded — we only persist fields the agent actually CHANGED,
  // so unchanged fields keep auto-filling from the live transaction money terms.
  const [initial, setInitial] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [genError, setGenError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getCdaFormFieldsAction({ cdaId }).then((res) => {
      if (cancelled) return
      if (res.success) {
        setHasTemplate(res.hasTemplate)
        setFields(res.resolution.fields as ResolvedField[])
        setMissing(res.resolution.missingRequired)
        const seed: Record<string, string> = {}
        for (const f of res.resolution.fields) if (f.value != null) seed[f.field_key] = String(f.value)
        setInputs(seed)
        setInitial(seed)
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [cdaId])

  function save() {
    setSaved(false)
    // Persist only the fields the agent actually changed from the calculated default.
    const changed: Record<string, string> = {}
    for (const [k, v] of Object.entries(inputs)) if ((v ?? "") !== (initial[k] ?? "")) changed[k] = v
    startTransition(async () => {
      const res = await saveCdaFieldInputsAction({ cdaId, agentInputs: changed })
      if (res.success) {
        setFields(res.resolution.fields as ResolvedField[])
        setMissing(res.resolution.missingRequired)
        const seed: Record<string, string> = {}
        for (const f of res.resolution.fields) if (f.value != null) seed[f.field_key] = String(f.value)
        setInputs(seed)
        setInitial(seed)
        setSaved(true)
      }
    })
  }

  async function generatePdf() {
    setGenError(null)
    setGenerating(true)
    try {
      const res = await generateFilledCdaPdfAction({ cdaId })
      if (res.success) {
        setPdfUrl(res.url)
      } else {
        setGenError(res.error)
      }
    } finally {
      setGenerating(false)
    }
  }

  if (loading) {
    return <Card><CardContent className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the brokerage CDA form…</CardContent></Card>
  }
  // No template-field bindings configured → nothing to render (the tally view still shows).
  if (!hasTemplate) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4 text-indigo-600" />
          Your brokerage&apos;s CDA form
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Pre-filled from your contracted terms and the final transaction money. Edit any field if needed, then save.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) => {
            const edited = (inputs[f.field_key] ?? "") !== (initial[f.field_key] ?? "")
            const autoFilled = f.source !== "agent_input"
            return (
              <div key={f.field_key} className="space-y-1">
                <Label className="text-xs flex items-center gap-1">
                  {f.label}
                  {autoFilled && !edited && <span className="text-[10px] text-muted-foreground">auto</span>}
                  {edited && <span className="text-[10px] text-amber-600">edited</span>}
                  {missing.includes(f.field_key) && <span className="text-destructive">*</span>}
                </Label>
                <Input
                  value={inputs[f.field_key] ?? ""}
                  onChange={(e) => setInputs((p) => ({ ...p, [f.field_key]: e.target.value }))}
                  placeholder={f.field_type === "currency" ? "$" : f.field_type === "percent" ? "%" : ""}
                  disabled={pending}
                  className={missing.includes(f.field_key) ? "border-destructive" : ""}
                />
              </div>
            )
          })}
        </div>
        {fields.length > 0 && (
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save form fields"}
            </Button>
            {missing.length > 0 && <span className="text-xs text-destructive">{missing.length} required field{missing.length === 1 ? "" : "s"} still empty</span>}
            {saved && missing.length === 0 && <span className="text-xs text-emerald-600">Saved</span>}
          </div>
        )}

        {/* Generate the brokerage's actual CDA PDF, filled from these values. */}
        <div className="flex items-center gap-3 border-t pt-3">
          <Button size="sm" variant="outline" onClick={generatePdf} disabled={generating || missing.length > 0}>
            {generating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileDown className="h-4 w-4 mr-2" />}
            Generate filled CDA PDF
          </Button>
          {missing.length > 0 && <span className="text-xs text-muted-foreground">Fill required fields first</span>}
          {pdfUrl && (
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 underline">
              Open filled CDA
            </a>
          )}
          {genError && <span className="text-xs text-destructive">{genError === "no_field_bindings" ? "No field mapping configured" : genError === "nothing_to_fill" ? "No mapped values to write" : genError}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
