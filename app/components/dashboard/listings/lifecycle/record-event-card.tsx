"use client"

/**
 * RECORD WHAT ACTUALLY HAPPENED.
 *
 * The lifecycle page could show a listing's progress but the agent had no way to
 * tell it what had occurred. Twelve governed recorders — the repair loop, the
 * media shoot, showing feedback, the seller's decision, MLS readiness, and all
 * three ways a listing ends — existed, wrote the kernel stage transition and the
 * activity history, and had no caller anywhere. Several more were reachable only
 * by speaking to the voice assistant.
 *
 * The controls are derived from the listing's CURRENT stage, so this card cannot
 * offer something that could not honestly have happened yet, and the server
 * re-checks the same rule rather than trusting what the screen chose to render.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, CircleCheck, ClipboardCheck, TriangleAlert } from "lucide-react"
import {
  recordableEventsForStage,
  type RecordableAction,
  type RecordableEvent,
} from "@/lib/listing-lifecycle/recordable-events"
import { recordLifecycleEventAction } from "@/app/actions/seller-listing/record-lifecycle-event"

interface RecordEventCardProps {
  listingId: string
  currentStage: string
}

export function RecordEventCard({ listingId, currentStage }: RecordEventCardProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState<RecordableAction | null>(null)
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const events = recordableEventsForStage(currentStage)
  if (events.length === 0) return null

  const active = events.find((e) => e.action === open) ?? null

  function choose(evt: RecordableEvent) {
    setError(null)
    setDone(null)
    setValues({})
    setOpen(evt.action === open ? null : evt.action)
  }

  function submit(evt: RecordableEvent) {
    setError(null)
    startTransition(async () => {
      const res = await recordLifecycleEventAction({
        listingId,
        action: evt.action,
        values,
      })
      if (!res.success) {
        // Say what is actually wrong. "Something went wrong" on a record of what
        // happened is worse than useless — the agent cannot tell whether it saved.
        if (res.error === "missing_required_fields" && res.missing?.length) {
          const labels = res.missing.map(
            (k) => evt.fields.find((f) => f.key === k)?.label ?? k,
          )
          setError(`Still needed: ${labels.join(", ")}.`)
        } else if (res.error?.startsWith("not_recordable_from_stage")) {
          setError("The listing has moved on since this page loaded — refresh and try again.")
        } else {
          setError(res.error ?? "Could not record that.")
        }
        return
      }
      setDone(evt.label)
      setOpen(null)
      setValues({})
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5" />
          Record what happened
        </CardTitle>
        <CardDescription>
          Tell the OS what actually took place, so the listing's history is what occurred
          rather than what was assumed. Only what could have happened at this stage is offered.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {done && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
            <CircleCheck className="h-4 w-4 shrink-0" />
            <span>Recorded: {done}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {events.map((evt) => (
            <Button
              key={evt.action}
              size="sm"
              variant={evt.terminal ? "outline" : open === evt.action ? "default" : "secondary"}
              className={evt.terminal ? "border-red-300 text-red-700 hover:bg-red-50" : undefined}
              onClick={() => choose(evt)}
              disabled={pending}
            >
              {evt.label}
            </Button>
          ))}
        </div>

        {active && (
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{active.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{active.effect}</p>
              </div>
              {active.terminal && (
                <Badge variant="outline" className="border-red-300 text-red-700 shrink-0">
                  Ends the listing lifecycle
                </Badge>
              )}
            </div>

            {active.fields.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {active.fields.map((f) => (
                  <label key={f.key} className={`text-sm ${f.type === "longtext" ? "sm:col-span-2" : ""}`}>
                    <span className="block text-xs font-medium mb-1">
                      {f.label}
                      {f.required && <span className="text-red-600"> *</span>}
                    </span>
                    {f.type === "choice" ? (
                      <select
                        className="w-full border rounded px-2 py-1.5 text-sm bg-background"
                        value={String(values[f.key] ?? "")}
                        onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        disabled={pending}
                      >
                        <option value="">Choose…</option>
                        {f.options?.map((o) => (
                          <option key={o} value={o}>{o.replace(/_/g, " ")}</option>
                        ))}
                      </select>
                    ) : f.type === "boolean" ? (
                      <span className="flex items-center gap-2 h-8">
                        <input
                          type="checkbox"
                          checked={values[f.key] === true}
                          onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))}
                          disabled={pending}
                        />
                        <span className="text-xs text-muted-foreground">Yes</span>
                      </span>
                    ) : f.type === "longtext" ? (
                      <textarea
                        className="w-full border rounded px-2 py-1.5 text-sm bg-background"
                        rows={2}
                        value={String(values[f.key] ?? "")}
                        onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        disabled={pending}
                      />
                    ) : (
                      <input
                        type={f.type === "number" ? "number" : "text"}
                        className="w-full border rounded px-2 py-1.5 text-sm bg-background"
                        value={String(values[f.key] ?? "")}
                        onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        disabled={pending}
                      />
                    )}
                    {f.help && <span className="block text-[11px] text-muted-foreground mt-1">{f.help}</span>}
                  </label>
                ))}
              </div>
            )}

            {error && (
              <p className="text-xs text-red-600 flex items-start gap-1.5">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
                <span>{error}</span>
              </p>
            )}

            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => submit(active)} disabled={pending}>
                {pending && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                {active.terminal ? `Confirm — ${active.label}` : "Record it"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(null)} disabled={pending}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
