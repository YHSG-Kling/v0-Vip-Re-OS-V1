"use client"

/**
 * ACCESSIBILITY PREFERENCES — the settings form for what a contact SAID they need (wave 145, lane 145H; owner ruling
 * 18). Rendered in two places, one component:
 *   · the client portal settings (mode "self") — the person sets their own;
 *   · the CRM contact page (mode "staff") — an agent records them AT THE CONTACT'S REQUEST, and must tick that the
 *     contact asked (the door refuses otherwise).
 * Options and the current values come from the server page (lib/contacts/accessibility-preferences.ts), so this file
 * never retypes the vocabulary. Nothing here guesses a need: an unset field stays unset.
 *
 * Accessible by construction (plugins/ecc/skills/accessibility — WCAG 2.2 AA): every control has a visible <label>,
 * groups are a <fieldset> with a <legend>, choices are native radios / checkboxes (keyboard + screen reader for free),
 * the save result is announced through an aria-live region, and nothing relies on colour alone.
 */

import { useId, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Accessibility, Loader2 } from "lucide-react"
import { saveContactAccessibilityPreferences, saveMyAccessibilityPreferences } from "@/app/actions/contacts/accessibility-preferences"
import type { AccessibilityOptionLists, AccessibilityPreferences } from "@/lib/contacts/accessibility-preferences"

type Mode = "self" | "staff"

export function AccessibilityPreferencesCard({
  contactId,
  mode,
  initial,
  options,
  unavailable,
}: {
  contactId: string
  mode: Mode
  initial: AccessibilityPreferences
  options: AccessibilityOptionLists
  /** Set when the preferences could not be read (e.g. the column is not applied yet) — the form is shown read-only. */
  unavailable?: string | null
}) {
  const uid = useId()
  const [prefs, setPrefs] = useState<AccessibilityPreferences>(initial)
  const [contactRequested, setContactRequested] = useState(false)
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const setField = <K extends keyof AccessibilityPreferences>(k: K, v: AccessibilityPreferences[K] | undefined) => {
    setStatus(null)
    setPrefs((p) => {
      const next = { ...p }
      if (v === undefined) delete next[k]
      else next[k] = v
      return next
    })
  }

  const save = () => {
    setStatus(null)
    // Every field the form shows is sent: a cleared choice is sent as null so the stored value is cleared too.
    const payload: Record<string, unknown> = {
      communication_format: prefs.communication_format ?? null,
      text_size: prefs.text_size ?? null,
      portal_modality: prefs.portal_modality ?? null,
    }
    for (const f of options.flags) payload[f.value] = prefs[f.value] === true ? true : null
    startTransition(async () => {
      const r = mode === "self"
        ? await saveMyAccessibilityPreferences({ contactId, preferences: payload })
        : await saveContactAccessibilityPreferences({ contactId, preferences: payload, contactRequested })
      if (r.ok) {
        setPrefs(r.preferences)
        setStatus({ kind: "ok", text: r.changed.length ? "Saved." : "Nothing changed." })
      } else {
        setStatus({ kind: "error", text: r.error })
      }
    })
  }

  const disabled = !!unavailable || pending

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Accessibility className="h-4 w-4" aria-hidden="true" /> Accessibility preferences
        </CardTitle>
        <CardDescription>
          {mode === "self"
            ? "Tell us how you would like information to reach you. Only what you choose here is used — nothing is assumed."
            : "Record only what the client asked for. These are the client's own choices — never assumed from anything else."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {unavailable && <p className="text-sm text-amber-900 bg-amber-50 rounded px-2 py-1">{unavailable}</p>}

        <fieldset className="space-y-1" disabled={disabled}>
          <legend className="text-sm font-medium">Preferred format</legend>
          <div className="flex flex-wrap gap-3">
            {options.formats.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm min-h-6">
                <input type="radio" name={`${uid}-format`} value={o.value}
                  checked={prefs.communication_format === o.value}
                  onChange={() => setField("communication_format", o.value)} />
                {o.label}
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm min-h-6">
              <input type="radio" name={`${uid}-format`} value=""
                checked={!prefs.communication_format}
                onChange={() => setField("communication_format", undefined)} />
              No preference
            </label>
          </div>
        </fieldset>

        <fieldset className="space-y-1" disabled={disabled}>
          <legend className="text-sm font-medium">Captions, transcripts and display</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {options.flags.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm min-h-6">
                <input type="checkbox" checked={prefs[o.value] === true}
                  onChange={(e) => setField(o.value, e.target.checked ? true : undefined)} />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${uid}-text-size`} className="text-sm font-medium">Text size in the portal</label>
            <select id={`${uid}-text-size`} disabled={disabled} className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={prefs.text_size ?? ""}
              onChange={(e) => setField("text_size", (e.target.value || undefined) as AccessibilityPreferences["text_size"])}>
              <option value="">No preference</option>
              {options.textSizes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${uid}-modality`} className="text-sm font-medium">How you use the portal</label>
            <select id={`${uid}-modality`} disabled={disabled} className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={prefs.portal_modality ?? ""}
              onChange={(e) => setField("portal_modality", (e.target.value || undefined) as AccessibilityPreferences["portal_modality"])}>
              <option value="">No preference</option>
              {options.modalities.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">Language is set with your preferred language{mode === "self" ? " under Personal Information" : " on the contact card"}.</p>

        {mode === "staff" && (
          <label className="flex items-center gap-2 text-sm min-h-6">
            <input type="checkbox" checked={contactRequested} disabled={disabled}
              onChange={(e) => { setContactRequested(e.target.checked); setStatus(null) }} />
            The client asked me to record these
          </label>
        )}

        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={disabled || (mode === "staff" && !contactRequested)}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Save preferences
          </Button>
          <p role="status" aria-live="polite" className={`text-sm ${status?.kind === "error" ? "text-red-700" : "text-muted-foreground"}`}>
            {status ? (status.kind === "error" ? `Not saved: ${status.text}` : status.text) : ""}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
