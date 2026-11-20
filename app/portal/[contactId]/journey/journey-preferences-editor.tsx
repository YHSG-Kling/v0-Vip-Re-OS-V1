"use client"

// app/portal/[contactId]/journey/journey-preferences-editor.tsx
//
// The client's own MUST-HAVES — the one thing on the "What we're looking for"
// card the client may edit. Everything else on that card (price, beds, areas) is
// the AGENT's record, written from the CRM search page; this island writes only
// must_have_features through saveClientJourneyPreferences, which is gated on the
// contact's own portal session and leaves the agent's columns untouched.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, Plus, X } from "lucide-react"
import { saveClientJourneyPreferences } from "@/app/actions/multi-persona"

interface Props {
  contactId: string
  initialMustHaves: string[]
}

export default function JourneyPreferencesEditor({ contactId, initialMustHaves }: Props) {
  const router = useRouter()
  const [items, setItems] = useState<string[]>(initialMustHaves)
  const [draft, setDraft] = useState("")
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  function add() {
    const v = draft.trim()
    if (!v) return
    if (items.some((i) => i.toLowerCase() === v.toLowerCase())) { setDraft(""); return }
    setItems((prev) => [...prev, v].slice(0, 25))
    setDraft("")
    setDirty(true)
    setSaved(false)
  }

  function remove(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx))
    setDirty(true)
    setSaved(false)
  }

  function save() {
    setError(null)
    startTransition(async () => {
      const res = await saveClientJourneyPreferences({ contactId, mustHaveFeatures: items })
      if (!res.success) {
        // The server's refusal, verbatim — never an optimistic "Saved".
        setError(res.error)
        return
      }
      setItems(res.mustHaveFeatures)
      setDirty(false)
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <div className="rounded-xl border p-4">
      <h3 className="font-semibold">Your must-haves</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        What a home has to have for you. Your agent sees this on your record; price, size and areas
        stay with them.
      </p>
      <div className="flex flex-wrap gap-2 mb-3">
        {items.length === 0 && (
          <span className="text-xs text-muted-foreground">Nothing yet — add your first must-have below.</span>
        )}
        {items.map((item, idx) => (
          <span
            key={`${item}-${idx}`}
            className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-1 text-xs"
          >
            {item}
            <button
              type="button"
              aria-label={`Remove ${item}`}
              onClick={() => remove(idx)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); add() }
          }}
          placeholder="e.g. fenced yard, home office, one-level"
          maxLength={80}
        />
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={!draft.trim()}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={!dirty || pending}>
          {pending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
          Save
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {saved && !dirty && <p className="mt-2 text-xs text-emerald-700">Saved — your agent can see these now.</p>}
    </div>
  )
}
