"use client"

/**
 * FormFieldRenderer
 *
 * Renders a single transaction form's fields inline for in-app completion.
 * Loads field schema via getFormFieldsAction(formId), groups by section,
 * and calls onChange on every keystroke so the parent can collect values.
 *
 * Usage:
 *   <FormFieldRenderer
 *     formId={selectedForm.id}
 *     formName={selectedForm.name}
 *     values={fieldValues[selectedForm.id] ?? {}}
 *     onChange={(key, value) => setFieldValue(selectedForm.id, key, value)}
 *   />
 */

import { useState, useEffect } from "react"
import { getFormFieldsAction, type FormFieldDef } from "@/app/actions/forms-kernel"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, AlertCircle } from "lucide-react"

interface FormFieldRendererProps {
  formId:   string
  formName: string
  /** Current field values — key = field.key, value = string */
  values:   Record<string, string>
  onChange: (key: string, value: string) => void
}

export function FormFieldRenderer({ formId, formName, values, onChange }: FormFieldRendererProps) {
  const [fields, setFields]     = useState<FormFieldDef[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    getFormFieldsAction(formId)
      .then(res => {
        if (res.success && res.fields) {
          setFields(res.fields)
        } else {
          setError(res.error ?? "Could not load form fields")
        }
      })
      .catch(() => setError("Could not load form fields"))
      .finally(() => setLoading(false))
  }, [formId])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading {formName} fields…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    )
  }

  // Group fields by section
  const sections = fields.reduce<Record<string, FormFieldDef[]>>((acc, field) => {
    const key = field.section || "General"
    if (!acc[key]) acc[key] = []
    acc[key].push(field)
    return acc
  }, {})

  return (
    <div className="space-y-6">
      {Object.entries(sections).map(([section, sectionFields]) => (
        <div key={section} className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1">
            {section}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {sectionFields.map(field => (
              <div
                key={field.key}
                className={field.type === "textarea" ? "sm:col-span-2" : ""}
              >
                <Label className="text-xs mb-1 block">
                  {field.label}
                  {field.required && <span className="text-destructive ml-0.5">*</span>}
                </Label>

                {field.type === "textarea" ? (
                  <Textarea
                    value={values[field.key] ?? ""}
                    onChange={e => onChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    rows={3}
                    className="text-sm resize-none"
                  />
                ) : (
                  <Input
                    type={field.type}
                    value={values[field.key] ?? ""}
                    onChange={e => onChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="h-8 text-sm"
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
