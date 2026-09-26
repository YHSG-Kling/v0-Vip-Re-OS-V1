"use client"

// ═══════════════════════════════════════════════════════════════════════════════
// TransactionFormEsignFlow
//
// Reusable Sheet-based flow: form prefill → draft → signer config → launchEsign.
// Called from the transaction Forms tab, listing lifecycle FormsPanel, and
// offer initiation flow. All data mutations delegate to forms-kernel.ts actions.
//
// Kernel OS: no DB calls here — all calls go through server actions.
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from "react"
import { toast } from "sonner"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  FileText,
  Loader2,
  Plus,
  Trash2,
  Send,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  User,
  Mail,
  Pencil,
  ExternalLink,
} from "lucide-react"
import {
  prefillFormAction,
  saveFormDraftAction,
  loadFormDraftAction,
  launchEsignAction,
  getFormFieldsAction,
} from "@/app/actions/forms-kernel"
import type { FormContextType } from "@/lib/kernel/forms"
import type { FormFieldDef } from "@/app/actions/forms-kernel"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FormTemplate {
  id: string
  name: string
  category: string
  form_type: string
  is_required: boolean
  description?: string
}

export interface DefaultSigner {
  name: string
  email: string
  role: string
}

interface Signer {
  name: string
  email: string
  role: string
}

interface TransactionFormEsignFlowProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  formTemplate: FormTemplate
  contextType: FormContextType
  contextId: string                // transaction ID, listing ID, or "pending" for offer pre-creation
  defaultSigners?: DefaultSigner[]
  providerName?: string            // e.g. "dotloop", "skyslope" — used for external link fallback
  onSuccess?: (formSubmissionId: string) => void
}

type Step = "prefill" | "signers" | "review" | "success"

const SIGNER_ROLES = [
  "buyer",
  "seller",
  "buyer_agent",
  "listing_agent",
  "lender",
  "title_officer",
  "escrow_officer",
  "other",
]

// ─── Component ───────────────────────────────────────────────────────────────

export function TransactionFormEsignFlow({
  open,
  onOpenChange,
  formTemplate,
  contextType,
  contextId,
  defaultSigners = [],
  providerName,
  onSuccess,
}: TransactionFormEsignFlowProps) {
  const [step, setStep] = useState<Step>("prefill")
  const [prefilling, setPrefilling] = useState(false)
  const [prefillData, setPrefillData] = useState<Record<string, any>>({})
  const [templateFields, setTemplateFields] = useState<FormFieldDef[]>([])
  const [formSubmissionId, setFormSubmissionId] = useState<string | null>(null)
  const [signers, setSigners] = useState<Signer[]>(
    defaultSigners.length > 0
      ? defaultSigners.map(s => ({ ...s }))
      : [{ name: "", email: "", role: "buyer" }]
  )
  const [esignMessage, setEsignMessage] = useState("")
  const [launching, setLaunching] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const [draftRestoredAt, setDraftRestoredAt] = useState<string | null>(null)

  // Reset state when sheet opens
  useEffect(() => {
    if (open) {
      setStep("prefill")
      setPrefillData({})
      setFormSubmissionId(null)
      setLaunching(false)
      setDraftSaved(false)
      setDraftRestoredAt(null)
      setSigners(
        defaultSigners.length > 0
          ? defaultSigners.map(s => ({ ...s }))
          : [{ name: "", email: "", role: "buyer" }]
      )
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load form template fields + attempt prefill when sheet opens
  useEffect(() => {
    if (!open || step !== "prefill") return
    // Always load template field schema
    getFormFieldsAction(formTemplate.id).then(res => {
      if (res.success && res.fields) setTemplateFields(res.fields)
    }).catch(() => {})
    // Prefill from context when we have a real context ID
    if (contextId === "pending") return
    let cancelled = false
    setPrefilling(true)
    ;(async () => {
      let fields: Record<string, any> = {}
      try {
        const res = await prefillFormAction({
          form_name: formTemplate.name,
          context_type: contextType,
          context_id: contextId,
        })
        if (res.success && res.data) fields = res.data.prefill?.fields ?? {}
      } catch {/* prefill is best-effort */}

      // RESTORE THE SAVED DRAFT. "Save Draft" below has always written to
      // form_submissions, but nothing ever read it back — a draft was
      // write-only, so an agent who saved and closed lost every edit and got
      // the raw context prefill again on reopen. The draft is the NEWER truth
      // (it is the agent's own corrections), so it wins over the context
      // prefill, and its id is adopted as the submission id so the next save
      // updates that row instead of racing a second draft.
      try {
        const draftRes: any = await loadFormDraftAction({
          form_name:  formTemplate.name,
          context_id: contextId,
        })
        const draft = draftRes?.success ? draftRes?.data?.draft : null
        if (draft && !cancelled) {
          fields = { ...fields, ...(draft.field_values ?? {}) }
          if (draft.id) setFormSubmissionId(draft.id as string)
          setDraftRestoredAt((draft.updated_at ?? draft.created_at) ?? null)
        }
      } catch {/* no draft is the normal case, not an error */}

      if (!cancelled) {
        setPrefillData(fields)
        setPrefilling(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, step, formTemplate.id, formTemplate.name, contextType, contextId])

  // Debounced draft save
  const saveDraft = useCallback(async () => {
    if (contextId === "pending" || Object.keys(prefillData).length === 0) return
    setSavingDraft(true)
    const res = await saveFormDraftAction({
      form_name: formTemplate.name,
      context_type: contextType,
      context_id: contextId,
      field_values: prefillData,
    })
    if (res.success && (res as any).data?.id) {
      setFormSubmissionId((res as any).data.id)
      setDraftSaved(true)
    }
    setSavingDraft(false)
  }, [prefillData, formTemplate.name, contextType, contextId])

  const handleLaunchEsign = async () => {
    if (!signers.every(s => s.name && s.email)) {
      toast.error("All signers must have a name and email")
      return
    }
    setLaunching(true)
    try {
      // Save draft first if we don't have a submission ID
      let submissionId = formSubmissionId
      if (!submissionId && contextId !== "pending") {
        const draftRes = await saveFormDraftAction({
          form_name: formTemplate.name,
          context_type: contextType,
          context_id: contextId,
          field_values: prefillData,
        })
        if (draftRes.success && (draftRes as any).data?.id) {
          submissionId = (draftRes as any).data.id
          setFormSubmissionId(submissionId)
        }
      }

      if (!submissionId) {
        toast.error("Could not save form draft. Try again.")
        return
      }

      const res = await launchEsignAction({
        form_submission_id: submissionId,
        external_transaction_id: contextId,
        signers,
        message: esignMessage || undefined,
      })

      if (res.success) {
        setStep("success")
        toast.success("Sent for e-signature")
        onSuccess?.(submissionId)
      } else {
        toast.error((res as any).error ?? "Failed to send for signature")
      }
    } catch {
      toast.error("Failed to send for signature")
    } finally {
      setLaunching(false)
    }
  }

  const addSigner = () => {
    setSigners(prev => [...prev, { name: "", email: "", role: "buyer" }])
  }

  const removeSigner = (idx: number) => {
    setSigners(prev => prev.filter((_, i) => i !== idx))
  }

  const updateSigner = (idx: number, field: keyof Signer, value: string) => {
    setSigners(prev => prev.map((s, i) => i === idx ? { ...s, [field]: value } : s))
  }

  const providerUrls: Record<string, string> = {
    dotloop:        "https://www.dotloop.com/",
    skyslope:       "https://app.skyslope.com/",
    formsimplicity: "https://www.formsimplicity.com/",
    brokermint:     "https://brokermint.com/",
    authentisign:   "https://authentisign.com/",
    docusign:       "https://www.docusign.com/",
  }

  // ─── Step: prefill ────────────────────────────────────────────────────────

  const renderPrefillStep = () => (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-3 bg-muted/40 rounded-lg border">
        <FileText className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{formTemplate.name}</p>
          <p className="text-xs text-muted-foreground capitalize">
            {formTemplate.category.replace(/_/g, " ")} &middot; {formTemplate.form_type}
          </p>
          {formTemplate.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{formTemplate.description}</p>
          )}
        </div>
        {formTemplate.is_required && (
          <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4 shrink-0">Required</Badge>
        )}
      </div>

      {draftRestoredAt && !prefilling && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
          <Pencil className="h-3.5 w-3.5 text-amber-600 shrink-0" />
          <p className="text-xs text-amber-900">
            Restored your saved draft from {new Date(draftRestoredAt).toLocaleString()} — your edits are below, not the raw transaction values.
          </p>
        </div>
      )}

      {prefilling ? (
        <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Pre-filling form fields from transaction data...</span>
        </div>
      ) : (
        <div className="space-y-3">
          {Object.keys(prefillData).length > 0 ? (
            <>
              <p className="text-xs text-muted-foreground">
                The following fields were pre-filled from your transaction. Review and edit as needed.
              </p>
              {Object.entries(prefillData).map(([key, value]) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`field-${key}`} className="text-xs capitalize">
                    {key.replace(/_/g, " ")}
                  </Label>
                  <Input
                    id={`field-${key}`}
                    value={String(value ?? "")}
                    onChange={e => setPrefillData(prev => ({ ...prev, [key]: e.target.value }))}
                    className="text-sm h-8"
                  />
                </div>
              ))}
            </>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Enter the form details below. Fields are sourced from the form template and are editable before sending for signatures.
              </p>
              {templateFields.length > 0 ? (
                // Group fields by section and render categorized
                Object.entries(
                  templateFields.reduce<Record<string, FormFieldDef[]>>((acc, f) => {
                    const s = f.section ?? "Details"
                    ;(acc[s] = acc[s] ?? []).push(f)
                    return acc
                  }, {})
                ).map(([section, fields]) => (
                  <div key={section} className="space-y-2">
                    <div className="flex items-center gap-2 pb-1 border-b border-border/60">
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        {section}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {fields.map(field => (
                        <div key={field.key} className={`space-y-1 ${field.type === "textarea" ? "col-span-2" : ""}`}>
                          <Label htmlFor={`field-${field.key}`} className="text-xs flex items-center gap-1">
                            {field.label}
                            {field.required && <span className="text-destructive text-[10px]">*</span>}
                          </Label>
                          {field.type === "textarea" ? (
                            <Textarea
                              id={`field-${field.key}`}
                              value={String(prefillData[field.key] ?? "")}
                              onChange={e => setPrefillData(prev => ({ ...prev, [field.key]: e.target.value }))}
                              className="text-sm resize-none"
                              rows={3}
                              placeholder={field.placeholder ?? field.label}
                            />
                          ) : (
                            <Input
                              id={`field-${field.key}`}
                              type={field.type}
                              value={String(prefillData[field.key] ?? "")}
                              onChange={e => setPrefillData(prev => ({ ...prev, [field.key]: e.target.value }))}
                              className="text-sm h-8"
                              placeholder={field.placeholder ?? field.label}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                // Loading state for template fields
                <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-xs">Loading form fields...</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <div className="flex gap-2">
          {Object.keys(prefillData).length > 0 && contextId !== "pending" && (
            <Button
              variant="outline"
              size="sm"
              onClick={saveDraft}
              disabled={savingDraft}
              className="gap-1.5"
            >
              {savingDraft ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {draftSaved ? "Saved" : "Save Draft"}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => setStep("signers")}
            disabled={prefilling}
            className="gap-1.5"
          >
            Configure Signers
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )

  // ─── Step: signers ────────────────────────────────────────────────────────

  const renderSignersStep = () => (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">Who needs to sign?</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Add all parties who need to sign this document. Order determines signing sequence.
        </p>
      </div>

      <div className="space-y-3">
        {signers.map((signer, idx) => (
          <div key={idx} className="rounded-lg border p-3 space-y-2 bg-muted/20">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Signer {idx + 1}</span>
              {signers.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => removeSigner(idx)}
                >
                  <Trash2 className="h-3 w-3 text-destructive" />
                </Button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs flex items-center gap-1">
                  <User className="h-3 w-3" /> Name
                </Label>
                <Input
                  value={signer.name}
                  onChange={e => updateSigner(idx, "name", e.target.value)}
                  placeholder="Full name"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs flex items-center gap-1">
                  <Mail className="h-3 w-3" /> Email
                </Label>
                <Input
                  type="email"
                  value={signer.email}
                  onChange={e => updateSigner(idx, "email", e.target.value)}
                  placeholder="email@example.com"
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Role</Label>
              <Select value={signer.role} onValueChange={v => updateSigner(idx, "role", v)}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIGNER_ROLES.map(role => (
                    <SelectItem key={role} value={role} className="capitalize text-sm">
                      {role.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ))}
      </div>

      <Button variant="outline" size="sm" onClick={addSigner} className="w-full gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        Add Signer
      </Button>

      <Separator />

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Message to signers (optional)</Label>
        <Textarea
          value={esignMessage}
          onChange={e => setEsignMessage(e.target.value)}
          placeholder="Please review and sign the attached document at your earliest convenience..."
          className="text-sm min-h-[72px] resize-none"
        />
      </div>

      <div className="flex justify-between pt-2">
        <Button variant="outline" size="sm" onClick={() => setStep("prefill")} className="gap-1.5">
          <ChevronLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <Button
          size="sm"
          onClick={() => setStep("review")}
          disabled={signers.some(s => !s.name || !s.email)}
          className="gap-1.5"
        >
          Review & Send
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )

  // ─── Step: review ─────────────────────────────────────────────────────────

  const renderReviewStep = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-medium">Review Before Sending</p>

        <div className="rounded-lg border p-3 space-y-1 bg-muted/30">
          <p className="text-xs text-muted-foreground">Form</p>
          <p className="text-sm font-medium">{formTemplate.name}</p>
        </div>

        <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
          <p className="text-xs text-muted-foreground">Signers ({signers.length})</p>
          {signers.map((s, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <div className="flex h-5 w-5 rounded-full bg-primary/10 items-center justify-center text-[10px] font-medium text-primary shrink-0">
                {idx + 1}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{s.name}</p>
                <p className="text-xs text-muted-foreground truncate">{s.email} &middot; {s.role.replace(/_/g, " ")}</p>
              </div>
            </div>
          ))}
        </div>

        {esignMessage && (
          <div className="rounded-lg border p-3 bg-muted/30">
            <p className="text-xs text-muted-foreground mb-1">Message</p>
            <p className="text-sm">{esignMessage}</p>
          </div>
        )}

        {providerName && (
          <div className="rounded-lg border p-3 bg-muted/30">
            <p className="text-xs text-muted-foreground mb-1">E-sign provider</p>
            <p className="text-sm capitalize">{providerName}</p>
          </div>
        )}
      </div>

      <div className="flex justify-between pt-2">
        <Button variant="outline" size="sm" onClick={() => setStep("signers")} className="gap-1.5">
          <ChevronLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <Button
          size="sm"
          onClick={handleLaunchEsign}
          disabled={launching}
          className="gap-1.5"
        >
          {launching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          {launching ? "Sending..." : "Send for Signature"}
        </Button>
      </div>
    </div>
  )

  // ─── Step: success ────────────────────────────────────────────────────────

  const renderSuccessStep = () => (
    <div className="space-y-4 py-4 text-center">
      <CheckCircle2 className="h-14 w-14 text-green-500 mx-auto" />
      <div>
        <p className="text-lg font-semibold">Sent for Signature</p>
        <p className="text-sm text-muted-foreground mt-1">
          {signers.length > 1
            ? `${signers.length} signers have been notified via email.`
            : `${signers[0]?.name ?? "The signer"} has been notified via email.`}
        </p>
        {providerName && (
          <p className="text-xs text-muted-foreground mt-1">
            Track progress in your{" "}
            <a
              href={providerUrls[providerName] ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-2 hover:underline inline-flex items-center gap-0.5"
            >
              {providerName.charAt(0).toUpperCase() + providerName.slice(1)} portal
              <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2 pt-2">
        <Button onClick={() => onOpenChange(false)} size="sm">
          Done
        </Button>
        {providerName && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(providerUrls[providerName] ?? "#", "_blank")}
            className="gap-1.5"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open {providerName.charAt(0).toUpperCase() + providerName.slice(1)}
          </Button>
        )}
      </div>
    </div>
  )

  // ─── Step indicator ───────────────────────────────────────────────────────

  const stepLabels: Record<Step, string> = {
    prefill: "Form Fields",
    signers: "Signers",
    review: "Review",
    success: "Complete",
  }
  const steps: Step[] = ["prefill", "signers", "review"]
  const stepIndex = steps.indexOf(step)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg flex flex-col p-0"
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b shrink-0">
          <SheetTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Use This Form
          </SheetTitle>
          <SheetDescription className="text-xs line-clamp-1">
            {formTemplate.name}
          </SheetDescription>
          {step !== "success" && (
            <div className="flex items-center gap-1 pt-1">
              {steps.map((s, i) => (
                <div key={s} className="flex items-center gap-1">
                  <div
                    className={`flex h-5 items-center gap-1 rounded px-2 text-[10px] font-medium transition-colors ${
                      i <= stepIndex
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {i + 1}. {stepLabels[s]}
                  </div>
                  {i < steps.length - 1 && (
                    <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                  )}
                </div>
              ))}
            </div>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {step === "prefill" && renderPrefillStep()}
          {step === "signers" && renderSignersStep()}
          {step === "review" && renderReviewStep()}
          {step === "success" && renderSuccessStep()}
        </div>
      </SheetContent>
    </Sheet>
  )
}
