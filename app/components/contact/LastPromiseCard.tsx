"use client"

/**
 * "LAST PROMISE MADE" card (concierge A.3) — one line holding the last
 * explicit promise to this client. Set it when you make it; clear it when
 * you keep it. The morning briefing's aging guard will not let it slip.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Handshake, Loader2, Check } from "lucide-react"
import { setLastPromiseAction } from "@/app/actions/contacts/last-promise"

export function LastPromiseCard({
  contactId,
  initialPromise,
  initialPromiseAt,
}: {
  contactId: string
  initialPromise: string | null
  initialPromiseAt: string | null
}) {
  const [promise, setPromise] = useState(initialPromise ?? "")
  const [savedAt, setSavedAt] = useState<string | null>(initialPromiseAt)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const save = (text: string | null) => {
    setSaved(false)
    startTransition(async () => {
      const r = await setLastPromiseAction({ contactId, promise: text })
      if (r.ok) {
        setSaved(true)
        setSavedAt(text ? new Date().toISOString() : null)
        if (!text) setPromise("")
      }
    })
  }

  const ageDays = savedAt ? Math.floor((Date.now() - new Date(savedAt).getTime()) / 86_400_000) : null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Handshake className="h-4 w-4 text-emerald-700" /> Last promise made
          {ageDays != null && ageDays >= 3 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900">open {ageDays}d</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Input
          value={promise}
          onChange={(e) => { setPromise(e.target.value); setSaved(false) }}
          placeholder={`e.g. "I'll send updated comps by Friday"`}
          className="h-8 text-sm"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" className="h-7 text-xs" onClick={() => save(promise)} disabled={pending || !promise.trim()}>
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : saved ? <Check className="h-3 w-3" /> : null}
            {saved ? "Tracked" : "Track this promise"}
          </Button>
          {savedAt && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => save(null)} disabled={pending}>
              Promise kept — clear it
            </Button>
          )}
          <p className="ml-auto text-[11px] text-muted-foreground">The briefing won't let it slip.</p>
        </div>
      </CardContent>
    </Card>
  )
}
