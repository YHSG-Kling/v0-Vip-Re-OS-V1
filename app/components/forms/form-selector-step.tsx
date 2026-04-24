"use client"

/**
 * FormSelectorStep
 *
 * Reusable two-phase form wizard step:
 *   Phase 1 — "select":  checkbox list of available forms (state-required + brokerage + provider)
 *   Phase 2 — "fill":    inline field fill for each selected form via FormFieldRenderer
 *
 * On completion, calls onComplete with selected form IDs and a map of
 * { [formId]: { [fieldKey]: string } } so the parent can persist / submit.
 *
 * Usage (listing):
 *   <FormSelectorStep contextType="listing" state="TX"
 *     onComplete={(ids, vals) => { setSelectedForms(ids); setFormValues(vals) }}
 *     onBack={() => setStep("pricing")} />
 *
 * Usage (offer):
 *   <FormSelectorStep contextType="offer" state={property?.state}
 *     onComplete={(ids, vals) => { ... }} onBack={() => setFlowStep("strategy")} />
 */

import { useState, useEffect } from "react"
import { loadAvailableFormsAction } from "@/app/actions/forms-kernel"
import { FormFieldRenderer } from "./form-field-renderer"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  Check,
  ChevronRight,
  ChevronLeft,
  FileText,
  Loader2,
  AlertCircle,
  Sparkles,
} from "lucide-react"
import type { FormContextType } from "@/lib/kernel/forms"

// ── Types ──────────────────────────────────────────────────────────────────────

interface AvailableForm {
  id:       string
  name:     string
  category: string
  required: boolean
  description?: string
  state?: string
}

export type FormFieldValues = Record<string, Record<string, string>>

interface FormSelectorStepProps {
  contextType: FormContextType
  /** US state for state-required form filtering */
  state?: string
  /** Pass true to auto-load forms immediately on mount */
  autoLoad?: boolean
  onComplete: (selectedFormIds: string[], fieldValues: FormFieldValues) => void
  onBack: () => void
  /** Label for the primary action button */
  nextLabel?: string
}

// ── Component ──────────────────────────────────────────────────────────────────

export function FormSelectorStep({
  contextType,
  state,
  autoLoad = true,
  onComplete,
  onBack,
  nextLabel = "Continue",
}: FormSelectorStepProps) {
  // Phase: "select" → checkbox list; "fill" → field fill per form
  const [phase, setPhase] = useState<"select" | "fill">("select")

  // Available forms
  const [forms, setForms]       = useState<AvailableForm[]>([])
  const [loading, setLoading]   = useState(false)
  const [loaded, setLoaded]     = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Selection
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // Field values per form: { formId: { fieldKey: value } }
  const [fieldValues, setFieldValues] = useState<FormFieldValues>({})

  // Active tab in fill phase
  const [activeTab, setActiveTab] = useState<string>("")

  // ── Load forms ───────────────────────────────────────────────────────────────

  function loadForms() {
    if (loading || loaded) return
    setLoading(true)
    setLoadError(null)
    loadAvailableFormsAction({ context_type: contextType, state })
      .then(res => {
        if (res.success && (res as any).data?.forms) {
          const templates = (res as any).data.forms as AvailableForm[]
          setForms(templates)
          // Auto-select required forms
          const requiredIds = templates.filter(f => f.required).map(f => f.id)
          setSelectedIds(requiredIds)
        } else {
          setLoadError("Could not load forms — you can continue without them")
        }
        setLoaded(true)
      })
      .catch(() => {
        setLoadError("Could not load forms — you can continue without them")
        setLoaded(true)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (autoLoad) loadForms()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function toggleForm(id: string, required: boolean) {
    if (required) return
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  function handleProceedToFill() {
    if (selectedIds.length === 0) {
      // No forms selected → skip fill phase entirely
      onComplete([], {})
      return
    }
    setActiveTab(selectedIds[0])
    setPhase("fill")
  }

  function handleFieldChange(formId: string, key: string, value: string) {
    setFieldValues(prev => ({
      ...prev,
      [formId]: { ...(prev[formId] ?? {}), [key]: value },
    }))
  }

  function handleComplete() {
    onComplete(selectedIds, fieldValues)
  }

  // ── Selected form objects (preserving order) ──────────────────────────────────

  const selectedForms = selectedIds
    .map(id => forms.find(f => f.id === id))
    .filter(Boolean) as AvailableForm[]

  // ── Render — Select phase ─────────────────────────────────────────────────────

  if (phase === "select") {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-base font-semibold">
            {contextType === "listing" ? "Listing Documents" : "Offer Forms"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Select the forms to include. Required forms are pre-selected and cannot be deselected.
            You will fill in the fields before sending for signatures.
          </p>
        </div>

        {/* Load button (if not auto-loaded) */}
        {!autoLoad && !loaded && !loading && (
          <Button variant="outline" size="sm" onClick={loadForms}>
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            Load Available Forms
          </Button>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading forms…
          </div>
        )}

        {loadError && (
          <div className="flex items-center gap-2 text-sm text-amber-600">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {loadError}
          </div>
        )}

        {loaded && forms.length === 0 && !loadError && (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No forms configured for your brokerage.
            You can add forms in <strong>Settings → Forms</strong> and continue here later.
          </div>
        )}

        {loaded && forms.length > 0 && (
          <div className="space-y-2">
            {forms.map(f => {
              const selected = selectedIds.includes(f.id)
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => toggleForm(f.id, f.required)}
                  className={cn(
                    "w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    selected
                      ? "border-primary bg-primary/5"
                      : "border-border bg-background hover:bg-muted/40",
                    f.required && "cursor-default",
                  )}
                  aria-pressed={selected}
                >
                  <FileText
                    className={cn(
                      "h-4 w-4 shrink-0",
                      selected ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{f.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {f.category}
                      {f.state ? ` · ${f.state}` : ""}
                      {f.description ? ` — ${f.description}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {f.required && (
                      <Badge variant="secondary" className="text-xs">Required</Badge>
                    )}
                    {!f.required && selected && (
                      <Check className="h-3.5 w-3.5 text-primary" />
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        <div className="flex gap-2 justify-between pt-2">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
          <Button onClick={handleProceedToFill} disabled={loading}>
            {selectedIds.length > 0
              ? `Fill ${selectedIds.length} Form${selectedIds.length !== 1 ? "s" : ""}`
              : nextLabel}
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </div>
    )
  }

  // ── Render — Fill phase ───────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Fill Form Fields</h2>
        <p className="text-sm text-muted-foreground">
          Complete the fields below. All information will be included when forms are sent for
          e-signature.
        </p>
      </div>

      {selectedForms.length === 1 ? (
        /* Single form — no tabs needed */
        <FormFieldRenderer
          formId={selectedForms[0].id}
          formName={selectedForms[0].name}
          values={fieldValues[selectedForms[0].id] ?? {}}
          onChange={(key, value) => handleFieldChange(selectedForms[0].id, key, value)}
        />
      ) : (
        /* Multiple forms — tabbed */
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex-wrap h-auto gap-1 mb-4">
            {selectedForms.map(f => (
              <TabsTrigger key={f.id} value={f.id} className="text-xs">
                {f.name}
              </TabsTrigger>
            ))}
          </TabsList>
          {selectedForms.map(f => (
            <TabsContent key={f.id} value={f.id}>
              <FormFieldRenderer
                formId={f.id}
                formName={f.name}
                values={fieldValues[f.id] ?? {}}
                onChange={(key, value) => handleFieldChange(f.id, key, value)}
              />
            </TabsContent>
          ))}
        </Tabs>
      )}

      <div className="flex gap-2 justify-between pt-2">
        <Button variant="outline" onClick={() => setPhase("select")}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to Selection
        </Button>
        <Button onClick={handleComplete}>
          {nextLabel}
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  )
}
