"use client"

import { useState, useTransition } from "react"
import { captureFormSubmissionAction } from "@/app/actions/lead-magnets"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CheckCircle2, Loader2 } from "lucide-react"

// Normalized field definition matching the kernel's field schema
interface FormField {
  name: string
  label: string
  type: "text" | "email" | "tel" | "number" | "textarea" | "select" | "checkbox"
  required: boolean
  options?: string[]
  placeholder?: string
}

interface Props {
  formId: string
  brokerageId: string
  fields: FormField[]
  source?: string
  headline?: string
  subheadline?: string
  ctaText?: string
  tcpaText?: string
  thankYouMessage?: string
  onSubmitted?: (submissionId: string) => void
}

export function GenericCaptureForm({
  formId,
  brokerageId,
  fields,
  source = "landing_page",
  headline,
  subheadline,
  ctaText = "Submit",
  tcpaText = "By submitting, you consent to receive communications. You may opt out at any time.",
  thankYouMessage = "Thank you! We will be in touch shortly.",
  onSubmitted,
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tcpaChecked, setTcpaChecked] = useState(false)

  // Dynamic field values keyed by field.name
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, ""]))
  )

  function setValue(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }))
  }

  function validate(): string | null {
    for (const field of fields) {
      if (field.required && !values[field.name]?.trim()) {
        return `${field.label} is required`
      }
      if (field.type === "email" && values[field.name] && !values[field.name].includes("@")) {
        return `${field.label} must be a valid email address`
      }
    }
    if (!tcpaChecked) return "Please acknowledge the consent statement"
    return null
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const validationError = validate()
    if (validationError) { setError(validationError); return }
    setError(null)

    startTransition(async () => {
      // Build submission payload — only include non-empty values
      const submissionData: Record<string, unknown> = {}
      for (const field of fields) {
        const val = values[field.name]
        if (val !== undefined && val !== "") {
          submissionData[field.name] = field.type === "number" ? Number(val) : val
        }
      }

      const result = await captureFormSubmissionAction({
        formId,
        brokerageId,
        source,
        tcpaConsentGiven: tcpaChecked,
        submissionData,
      })

      if (!result.success) {
        setError(result.error ?? "Submission failed. Please try again.")
        return
      }

      setSubmitted(true)
      onSubmitted?.(result.submissionId!)
    })
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center gap-5 py-12 text-center">
        <div className="p-4 bg-green-100 rounded-full">
          <CheckCircle2 className="h-10 w-10 text-green-600" />
        </div>
        <div>
          <p className="text-xl font-semibold">Submitted!</p>
          <p className="text-muted-foreground mt-2 max-w-sm">{thankYouMessage}</p>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {(headline || subheadline) && (
        <div className="mb-2">
          {headline && <h2 className="text-xl font-semibold">{headline}</h2>}
          {subheadline && <p className="text-sm text-muted-foreground mt-1">{subheadline}</p>}
        </div>
      )}

      {fields.map((field) => (
        <div key={field.name} className="space-y-1">
          <Label htmlFor={`gcf-${field.name}`}>
            {field.label}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>

          {field.type === "textarea" ? (
            <Textarea
              id={`gcf-${field.name}`}
              value={values[field.name] ?? ""}
              onChange={(e) => setValue(field.name, e.target.value)}
              placeholder={field.placeholder}
              required={field.required}
              rows={3}
            />
          ) : field.type === "select" && field.options?.length ? (
            <Select value={values[field.name]} onValueChange={(v) => setValue(field.name, v)}>
              <SelectTrigger id={`gcf-${field.name}`}>
                <SelectValue placeholder={field.placeholder ?? "Select..."} />
              </SelectTrigger>
              <SelectContent>
                {field.options.map((opt) => (
                  <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : field.type === "checkbox" ? (
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                id={`gcf-${field.name}`}
                checked={values[field.name] === "true"}
                onCheckedChange={(v) => setValue(field.name, v ? "true" : "false")}
              />
              <span className="text-sm">{field.label}</span>
            </label>
          ) : (
            <Input
              id={`gcf-${field.name}`}
              type={field.type}
              value={values[field.name] ?? ""}
              onChange={(e) => setValue(field.name, e.target.value)}
              placeholder={field.placeholder}
              required={field.required}
            />
          )}
        </div>
      ))}

      {/* TCPA Consent */}
      <label className="flex items-start gap-3 cursor-pointer">
        <Checkbox
          checked={tcpaChecked}
          onCheckedChange={(v) => setTcpaChecked(Boolean(v))}
          className="mt-0.5 shrink-0"
        />
        <span className="text-xs text-muted-foreground leading-relaxed">{tcpaText}</span>
      </label>

      {error && (
        <p className="text-sm text-destructive font-medium" role="alert">{error}</p>
      )}

      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
        {ctaText}
      </Button>
    </form>
  )
}
