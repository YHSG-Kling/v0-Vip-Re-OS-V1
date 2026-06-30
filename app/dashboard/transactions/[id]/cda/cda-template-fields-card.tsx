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
import { Loader2, Lock, FileText } from "lucide-react"
import { getCdaFormFieldsAction, saveCdaFieldInputsAction } from "@/app/actions/cda-template-field-actions"

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
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    getCdaFormFieldsAction({ cdaId }).then((res) => {
      if (cancelled) return
      if (res.success) {
        setHasTemplate(res.hasTemplate)
        setFields(res.resolution.fields as ResolvedField[])
        setMissing(res.resolution.missingRequired)
        const seed: Record<string, string> = {}
        for (const f of res.resolution.fields) if (f.editable && f.value != null) seed[f.field_key] = String(f.value)
        setInputs(seed)
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [cdaId])

  function save() {
    setSaved(false)
    startTransition(async () => {
      const res = await saveCdaFieldInputsAction({ cdaId, agentInputs: inputs })
      if (res.success) {
        setFields(res.resolution.fields as ResolvedField[])
        setMissing(res.resolution.missingRequired)
        setSaved(true)
      }
    })
  }

  if (loading) {
    return <Card><CardContent className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the brokerage CDA form…</CardContent></Card>
  }
  // No template-field bindings configured → nothing to render (the tally view still shows).
  if (!hasTemplate) return null

  const editable = fields.filter((f) => f.editable)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4 text-indigo-600" />
          Your brokerage&apos;s CDA form
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Auto-filled from the commission waterfall and the transaction. Fill in any remaining fields, then save.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <div key={f.field_key} className="space-y-1">
              <Label className="text-xs flex items-center gap-1">
                {f.label}
                {!f.editable && <Lock className="h-3 w-3 text-muted-foreground" />}
                {missing.includes(f.field_key) && <span className="text-destructive">*</span>}
              </Label>
              {f.editable ? (
                <Input
                  value={inputs[f.field_key] ?? ""}
                  onChange={(e) => setInputs((p) => ({ ...p, [f.field_key]: e.target.value }))}
                  placeholder={f.field_type === "currency" ? "$" : ""}
                  disabled={pending}
                  className={missing.includes(f.field_key) ? "border-destructive" : ""}
                />
              ) : (
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{f.formatted || "—"}</p>
              )}
            </div>
          ))}
        </div>
        {editable.length > 0 && (
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save form fields"}
            </Button>
            {missing.length > 0 && <span className="text-xs text-destructive">{missing.length} required field{missing.length === 1 ? "" : "s"} still empty</span>}
            {saved && missing.length === 0 && <span className="text-xs text-emerald-600">Saved</span>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
