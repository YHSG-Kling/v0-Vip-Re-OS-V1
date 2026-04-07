"use client"

// app/components/forms/FormDraftWorkspace.tsx
// ═══════════════════════════════════════════════════════════════════════════════
// INLINE FORM DRAFT WORKSPACE
// ═══════════════════════════════════════════════════════════════════════════════
//
// EXPLICIT RULES:
//   • context_type is IMMUTABLE once set — passed in as prop, never changed by user
//   • AI prefill is triggered per-button — never runs automatically
//   • Draft save debounces 2s after last field change
//   • Send for E-Sign is disabled until form_submission_id exists (draft is saved)
//   • external_transaction_id is required to launch e-sign; shows inline input if missing
//   • All server calls go through app/actions/forms-kernel.ts — no direct DB
//
// EXPLICIT UI BEHAVIOR:
//   • Template selector → shows available forms for context_type
//   • Field grid → editable key/value pairs prefilled from kernel
//   • "Prefill with AI" button → calls prefillFormAction, merges into fields
//   • "Save Draft" button → saves to form_submissions
//   • "Send for Signature" button → launches esign envelope; disabled if no draft saved
//   • Success/error inline — no modals, no page reloads

import { useState, useCallback, useTransition, useRef, useEffect } from "react"
import {
  FileText, Wand2, Save, Send, ChevronDown, Check, AlertCircle, Loader2, Plus
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Badge } from "@/app/components/ui/badge"
import { Skeleton } from "@/app/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  loadAvailableFormsAction,
  prefillFormAction,
  saveFormDraftAction,
  loadFormDraftAction,
  launchEsignAction,
} from "@/app/actions/forms-kernel"
import type { FormContextType, FormTemplate } from "@/lib/kernel/forms"

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface Signer {
  name:  string
  email: string
  role:  string
}

interface FormDraftWorkspaceProps {
  context_type:            FormContextType
  context_id:              string
  external_transaction_id?: string
  default_signers?:        Signer[]
  className?:              string
  onDraftSaved?:           (draft_id: string) => void
  onEsignLaunched?:        () => void
}

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export function FormDraftWorkspace({
  context_type,
  context_id,
  external_transaction_id: initialExternalTxId,
  default_signers = [],
  className,
  onDraftSaved,
  onEsignLaunched,
}: FormDraftWorkspaceProps) {
  const [templates, setTemplates]               = useState<FormTemplate[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<FormTemplate | null>(null)
  const [fieldValues, setFieldValues]           = useState<Record<string, any>>({})
  const [draftId, setDraftId]                   = useState<string | null>(null)
  const [externalTxId, setExternalTxId]         = useState(initialExternalTxId ?? "")
  const [signers, setSigners]                   = useState<Signer[]>(default_signers)

  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false)
  const [isPrefilling, startPrefill]               = useTransition()
  const [isSaving, startSave]                      = useTransition()
  const [isLaunching, startLaunch]                 = useTransition()

  const [saveStatus, setSaveStatus]   = useState<"idle" | "saved" | "error">("idle")
  const [launchStatus, setLaunchStatus] = useState<"idle" | "sent" | "error">("idle")
  const [launchError, setLaunchError]   = useState<string | null>(null)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load templates on mount
  useEffect(() => {
    setIsLoadingTemplates(true)
    loadAvailableFormsAction({ context_type })
      .then((result) => {
        if (result.success && result.data) {
          setTemplates(result.data.forms)
        }
      })
      .finally(() => setIsLoadingTemplates(false))
  }, [context_type])

  // Auto-select first template and load existing draft
  useEffect(() => {
    if (templates.length > 0 && !selectedTemplate) {
      const first = templates[0]
      setSelectedTemplate(first)
      // Try to load an existing draft
      loadFormDraftAction({ form_name: first.id, context_id }).then((result) => {
        if (result.success && result.data?.draft) {
          setFieldValues(result.data.draft.field_values)
          setDraftId(result.data.draft.id)
          setSaveStatus("saved")
        }
      })
    }
  }, [templates, selectedTemplate, context_id])

  // ── Handle template selection ─────────────────────────────────────────────
  const handleSelectTemplate = useCallback(
    (template: FormTemplate) => {
      setSelectedTemplate(template)
      setFieldValues({})
      setDraftId(null)
      setSaveStatus("idle")

      // Try to load existing draft for this template
      loadFormDraftAction({ form_name: template.id, context_id }).then((result) => {
        if (result.success && result.data?.draft) {
          setFieldValues(result.data.draft.field_values)
          setDraftId(result.data.draft.id)
          setSaveStatus("saved")
        }
      })
    },
    [context_id]
  )

  // ── AI Prefill ────────────────────────────────────────────────────────────
  const handlePrefill = useCallback(() => {
    if (!selectedTemplate) return
    startPrefill(async () => {
      const result = await prefillFormAction({
        form_name:    selectedTemplate.id,
        context_type,
        context_id,
      })
      if (result.success && result.data) {
        // Merge prefill into current fields (prefill wins for empty fields only)
        setFieldValues((prev) => {
          const merged: Record<string, any> = { ...result.data!.prefill.fields }
          // Keep any user-edited non-empty values
          Object.entries(prev).forEach(([k, v]) => {
            if (v !== null && v !== "" && v !== undefined) merged[k] = v
          })
          return merged
        })
      }
    })
  }, [selectedTemplate, context_type, context_id])

  // ── Field change with debounced auto-save ─────────────────────────────────
  const handleFieldChange = useCallback(
    (key: string, value: string) => {
      setFieldValues((prev) => ({ ...prev, [key]: value }))
      setSaveStatus("idle")

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        if (!selectedTemplate) return
        startSave(async () => {
          const result = await saveFormDraftAction({
            form_name:    selectedTemplate.id,
            context_type,
            context_id,
            field_values: { ...fieldValues, [key]: value },
          })
          if (result.success && result.data) {
            setDraftId(result.data.draft_id)
            setSaveStatus("saved")
            onDraftSaved?.(result.data.draft_id)
          } else {
            setSaveStatus("error")
          }
        })
      }, 2000)
    },
    [selectedTemplate, context_type, context_id, fieldValues, onDraftSaved]
  )

  // ── Manual save ───────────────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    if (!selectedTemplate) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)

    startSave(async () => {
      const result = await saveFormDraftAction({
        form_name:    selectedTemplate.id,
        context_type,
        context_id,
        field_values: fieldValues,
      })
      if (result.success && result.data) {
        setDraftId(result.data.draft_id)
        setSaveStatus("saved")
        onDraftSaved?.(result.data.draft_id)
      } else {
        setSaveStatus("error")
      }
    })
  }, [selectedTemplate, context_type, context_id, fieldValues, onDraftSaved])

  // ── Launch E-Sign ─────────────────────────────────────────────────────────
  const handleLaunchEsign = useCallback(() => {
    if (!draftId || !externalTxId || signers.length === 0) return

    startLaunch(async () => {
      setLaunchError(null)
      const result = await launchEsignAction({
        form_submission_id:      draftId,
        external_transaction_id: externalTxId,
        signers,
      })
      if (result.success) {
        setLaunchStatus("sent")
        onEsignLaunched?.()
      } else {
        setLaunchStatus("error")
        setLaunchError(result.error ?? "Failed to launch e-sign")
      }
    })
  }, [draftId, externalTxId, signers, onEsignLaunched])

  // ── Add signer ────────────────────────────────────────────────────────────
  const addSigner = () => {
    setSigners((prev) => [...prev, { name: "", email: "", role: "buyer" }])
  }
  const updateSigner = (index: number, field: keyof Signer, value: string) => {
    setSigners((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }
  const removeSigner = (index: number) => {
    setSigners((prev) => prev.filter((_, i) => i !== index))
  }

  const fieldEntries = Object.entries(fieldValues)

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Form Workspace
              <Badge variant="outline" className="text-xs capitalize">{context_type}</Badge>
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Select a form, prefill with AI, then send for signature.
            </CardDescription>
          </div>

          {/* Save status indicator */}
          <div className="flex items-center gap-1.5 text-xs">
            {isSaving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            {saveStatus === "saved" && !isSaving && (
              <span className="text-green-600 flex items-center gap-1">
                <Check className="h-3 w-3" /> Saved
              </span>
            )}
            {saveStatus === "error" && !isSaving && (
              <span className="text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> Save failed
              </span>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ── Template selector ─────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Form Template</Label>
          {isLoadingTemplates ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="w-full justify-between font-normal" size="sm">
                  <span className="truncate">
                    {selectedTemplate ? selectedTemplate.name : "Select a form…"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 ml-2 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80 max-h-64 overflow-y-auto">
                {templates.map((t) => (
                  <DropdownMenuItem
                    key={t.id}
                    onSelect={() => handleSelectTemplate(t)}
                    className="flex items-center justify-between"
                  >
                    <span className="truncate">{t.name}</span>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      {t.is_required && (
                        <Badge variant="destructive" className="text-[10px] py-0 px-1">Required</Badge>
                      )}
                      {selectedTemplate?.id === t.id && <Check className="h-3.5 w-3.5 text-primary" />}
                    </div>
                  </DropdownMenuItem>
                ))}
                {templates.length === 0 && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">No templates available</div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* ── AI Prefill button ─────────────────────────────────────────── */}
        {selectedTemplate && (
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrefill}
            disabled={isPrefilling}
            className="w-full border-dashed"
          >
            {isPrefilling ? (
              <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5 mr-2" />
            )}
            Prefill with AI
          </Button>
        )}

        {/* ── Field grid ────────────────────────────────────────────────── */}
        {fieldEntries.length > 0 && (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wide">Fields</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {fieldEntries.map(([key, value]) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`field-${key}`} className="text-xs capitalize">
                    {key.replace(/_/g, " ")}
                  </Label>
                  <Input
                    id={`field-${key}`}
                    value={value ?? ""}
                    onChange={(e) => handleFieldChange(key, e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Action row: Save + Send ──────────────────────────────────── */}
        {selectedTemplate && (
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={handleSave}
              disabled={isSaving || fieldEntries.length === 0}
            >
              {isSaving ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              Save Draft
            </Button>

            <Button
              size="sm"
              onClick={handleLaunchEsign}
              disabled={!draftId || isLaunching || launchStatus === "sent"}
            >
              {isLaunching ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : launchStatus === "sent" ? (
                <Check className="h-3.5 w-3.5 mr-1.5" />
              ) : (
                <Send className="h-3.5 w-3.5 mr-1.5" />
              )}
              {launchStatus === "sent" ? "Sent for Signature" : "Send for Signature"}
            </Button>
          </div>
        )}

        {/* ── External transaction ID (if not pre-supplied) ─────────────── */}
        {selectedTemplate && draftId && !initialExternalTxId && (
          <div className="space-y-1.5 pt-1 border-t">
            <Label htmlFor="ext-tx-id" className="text-xs text-muted-foreground">
              External Transaction ID (e.g. Dotloop Loop ID)
            </Label>
            <Input
              id="ext-tx-id"
              value={externalTxId}
              onChange={(e) => setExternalTxId(e.target.value)}
              placeholder="e.g. 12345678"
              className="h-8 text-sm"
            />
          </div>
        )}

        {/* ── Signers ──────────────────────────────────────────────────── */}
        {selectedTemplate && draftId && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">Signers</Label>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={addSigner}>
                <Plus className="h-3 w-3 mr-1" /> Add
              </Button>
            </div>
            {signers.length === 0 && (
              <p className="text-xs text-muted-foreground">Add at least one signer to launch e-sign.</p>
            )}
            {signers.map((signer, index) => (
              <div key={index} className="grid grid-cols-3 gap-2 items-end">
                <div>
                  <Label className="text-[10px] text-muted-foreground">Name</Label>
                  <Input
                    value={signer.name}
                    onChange={(e) => updateSigner(index, "name", e.target.value)}
                    placeholder="Full name"
                    className="h-7 text-xs"
                  />
                </div>
                <div>
                  <Label className="text-[10px] text-muted-foreground">Email</Label>
                  <Input
                    type="email"
                    value={signer.email}
                    onChange={(e) => updateSigner(index, "email", e.target.value)}
                    placeholder="email@example.com"
                    className="h-7 text-xs"
                  />
                </div>
                <div className="flex gap-1">
                  <div className="flex-1">
                    <Label className="text-[10px] text-muted-foreground">Role</Label>
                    <Input
                      value={signer.role}
                      onChange={(e) => updateSigner(index, "role", e.target.value)}
                      placeholder="buyer"
                      className="h-7 text-xs"
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 self-end text-muted-foreground hover:text-destructive"
                    onClick={() => removeSigner(index)}
                    aria-label="Remove signer"
                  >
                    ×
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Launch error ─────────────────────────────────────────────── */}
        {launchStatus === "error" && launchError && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/5 rounded-md px-3 py-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {launchError}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
