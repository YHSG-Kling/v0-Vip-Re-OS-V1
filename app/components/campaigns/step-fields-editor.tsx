"use client"

/**
 * app/components/campaigns/step-fields-editor.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The inputs for whatever step type is selected, rendered from the shared spec.
 *
 * Before this, both builders rendered a FIXED set of inputs — subject and body,
 * plus a handful of per-channel extras one of them happened to know about. So a
 * broker could add a "Send Gift" step and have nowhere to say what the occasion
 * was, or an "Ad Campaign" step with no budget field. The step saved happily
 * (channel is the only CHECK on the table) and then failed at dispatch, in a
 * cron, days later, with "No ad platform configured".
 *
 * Rendering from lib/workflow/step-palette.ts closes that in both directions:
 * every field an adapter reads has an input, and missingRequiredFields() warns
 * before save rather than at dispatch.
 */

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
import { AlertTriangle } from "lucide-react"
import {
  invalidFields,
  isInvalidValue,
  missingRequiredFields,
  stepSpec,
  type StepFieldSpec,
} from "@/lib/workflow/step-palette"

export interface StepFieldsEditorProps {
  channel: string
  values: Record<string, unknown>
  onChange: (name: string, value: unknown) => void
  disabled?: boolean
  /**
   * Fields the caller renders itself with a richer control — the sequence
   * builder's body box carries a personalization-token picker and an AI assist
   * bar, which a generic <Textarea> cannot. Omitted fields are still counted in
   * the required-field warning, so skipping one cannot hide that it is missing.
   */
  omit?: readonly string[]
}

function FieldInput({
  field, value, onChange, disabled,
}: { field: StepFieldSpec; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const id = `step-field-${field.name}`

  switch (field.type) {
    case "textarea":
      return (
        <Textarea
          id={id}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
          rows={4}
        />
      )
    case "number":
      return (
        <Input
          id={id}
          type="number"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      )
    case "boolean":
      return (
        <Switch
          id={id}
          checked={!!value}
          onCheckedChange={(c) => onChange(c)}
          disabled={disabled}
        />
      )
    case "select":
      return (
        <Select
          value={(value as string) || undefined}
          onValueChange={(v) => onChange(v)}
          disabled={disabled}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case "csv":
      // Stored as an array; edited as a comma-separated line. Empty stays empty
      // rather than becoming [""], which would read downstream as one blank item.
      return (
        <Input
          id={id}
          value={Array.isArray(value) ? (value as string[]).join(", ") : ((value as string) ?? "")}
          onChange={(e) => {
            const parts = e.target.value.split(",").map((p) => p.trim()).filter(Boolean)
            onChange(parts)
          }}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      )
    default:
      return (
        <Input
          id={id}
          type={field.type === "url" ? "url" : "text"}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      )
  }
}

export function StepFieldsEditor({ channel, values, onChange, disabled, omit }: StepFieldsEditorProps) {
  const spec = stepSpec(channel)
  if (!spec) return null

  // Required-field warnings are computed over the FULL spec, never the rendered
  // subset — omitting a field must not make a missing value invisible.
  const missing = missingRequiredFields(channel, values)
  const invalid = invalidFields(channel, values)
  const omitted = new Set(omit ?? [])
  const shown = spec.fields.filter((f) => !omitted.has(f.name))

  if (shown.length === 0 && missing.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Nothing to configure — this step uses the delay above.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {shown.map((field) => (
        <div
          key={field.name}
          className={field.type === "boolean" ? "flex items-center justify-between gap-3" : "flex flex-col gap-1.5"}
        >
          <Label htmlFor={`step-field-${field.name}`} className="text-xs">
            {field.label}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>
          <FieldInput
            field={field}
            value={values[field.name]}
            onChange={(v) => onChange(field.name, v)}
            disabled={disabled}
          />
          {isInvalidValue(field, values[field.name]) ? (
            <p className="text-[11px] text-destructive">
              {field.type === "uuid" || field.type === "uuid_csv"
                ? "Needs an ID (a UUID). Pick one rather than typing a name."
                : "That value cannot be stored in this field."}
            </p>
          ) : (
            field.help && <p className="text-[11px] text-muted-foreground">{field.help}</p>
          )}
        </div>
      ))}

      {invalid.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            The database will reject {invalid.map((f) => f.label).join(", ")} as written.
            Saving now would fail.
          </span>
        </div>
      )}

      {missing.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            This step will fail when it runs until you fill in{" "}
            {missing.map((f) => f.label).join(", ")}.
          </span>
        </div>
      )}
    </div>
  )
}
