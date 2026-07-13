"use client"

/**
 * ADDRESSING MEMORY card — "call me Bill." Three small fields on the contact
 * card (preferred name, pronunciation, formal/casual) that every AI draft,
 * the shared team note, and the morning-briefing nudges honor from then on.
 * The live preview shows exactly the greeting the client will see.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, Check, Ear } from "lucide-react"
import { updateContactAddressingAction } from "@/app/actions/contacts/update-addressing"
import { resolveAddressing } from "@/lib/kernel/addressing"

export function AddressingCard({
  contactId,
  firstName,
  lastName,
  initialPreferredName,
  initialPronunciation,
  initialSalutationStyle,
}: {
  contactId: string
  firstName: string | null
  lastName: string | null
  initialPreferredName: string | null
  initialPronunciation: string | null
  initialSalutationStyle: string | null
}) {
  const [preferred, setPreferred] = useState(initialPreferredName ?? "")
  const [pron, setPron] = useState(initialPronunciation ?? "")
  const [style, setStyle] = useState<string>(initialSalutationStyle ?? "")
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const preview = resolveAddressing({
    firstName, lastName,
    preferredName: preferred || null,
    namePronunciation: pron || null,
    salutationStyle: style || null,
  })

  const save = () => {
    setSaved(false)
    setError(null)
    startTransition(async () => {
      const r = await updateContactAddressingAction({
        contactId,
        preferredName: preferred || null,
        namePronunciation: pron || null,
        salutationStyle: style || null,
      })
      if (r.ok) setSaved(true)
      else setError(r.error)
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Ear className="h-4 w-4 text-amber-600" /> How they like to be addressed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-3">
          <Input
            value={preferred}
            onChange={(e) => { setPreferred(e.target.value); setSaved(false) }}
            placeholder={`Goes by… (e.g. "Bill")`}
            className="h-8 text-sm"
          />
          <Input
            value={pron}
            onChange={(e) => { setPron(e.target.value); setSaved(false) }}
            placeholder={`Pronounced… (e.g. "SHIV-on")`}
            className="h-8 text-sm"
          />
          <div className="flex gap-1">
            {["casual", "formal"].map((s) => (
              <button
                key={s}
                onClick={() => { setStyle(style === s ? "" : s); setSaved(false) }}
                className={`flex-1 rounded-md border px-2 py-1 text-xs capitalize ${style === s ? "border-amber-300 bg-amber-50 font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            Every message will open: <span className="font-mono text-foreground">{preview.greeting}</span>
            {preview.pronunciationNote ? <span className="ml-2">{preview.pronunciationNote}</span> : null}
          </p>
          <Button size="sm" className="h-7 text-xs ml-auto" onClick={save} disabled={pending}>
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : saved ? <Check className="h-3 w-3" /> : null}
            {saved ? "Remembered" : "Remember this"}
          </Button>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </CardContent>
    </Card>
  )
}
