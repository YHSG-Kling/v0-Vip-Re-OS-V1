"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Megaphone, Loader2, AlertCircle } from "lucide-react"
import { toast } from "sonner"
import { getRecruitingPitch, setRecruitingPitch } from "@/app/actions/settings/recruiting-pitch"
import { RECRUITING_PITCH_MAX } from "@/lib/recruiting/recruiting-pitch-limits"

/**
 * THE RECRUITING PITCH EDITOR — the write half brokerages.recruiting_pitch never had.
 *
 * The column is read by the PUBLIC careers page (app/recruiting/[brokerageSlug]),
 * the hosted brokerage site, the agent referral hub, and the Recruiting Manager's
 * pitch kit (which skips any brokerage whose pitch is null). Nothing in the app
 * could set it, and the onboarding checklist item that asks for it
 * (lib/onboarding/setup-readiness.ts, key "recruiting_pitch") pointed at
 * /dashboard/recruiting — a path with no page. It points here now.
 *
 * Errors are SHOWN, never swallowed: a refused load renders as a refusal, not as
 * an empty pitch the broker would then overwrite.
 */
export function RecruitingPitchPanel() {
  const [pitch, setPitch] = useState("")
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    getRecruitingPitch()
      .then((r) => {
        if (cancelled) return
        if (r.ok) setPitch(r.pitch)
        else setLoadError(r.error)
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Could not load the pitch")
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSave = () => {
    startTransition(async () => {
      const r = await setRecruitingPitch(pitch)
      if (r.ok) toast.success("Recruiting pitch saved")
      else toast.error(r.error ?? "Could not save the pitch")
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Megaphone className="h-4 w-4 text-violet-600" />
          Recruiting pitch
        </CardTitle>
        <CardDescription>
          Why an agent should join your brokerage. This is the headline on your public careers page,
          on your hosted site, and in the one-pager the Recruiting Manager builds for outreach — until
          it is set, that one-pager is not generated at all.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loadError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Could not load your current pitch: {loadError}. Nothing has been changed.</span>
          </div>
        ) : (
          <>
            <Textarea
              value={pitch}
              onChange={(e) => setPitch(e.target.value)}
              disabled={!loaded || isPending}
              maxLength={RECRUITING_PITCH_MAX}
              placeholder={
                loaded
                  ? "e.g. Keep 90% of your commission, a full AI back office, and a broker who answers the phone."
                  : "Loading…"
              }
              className="min-h-[120px] text-sm"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {pitch.trim().length === 0
                  ? "Not set — your careers page falls back to a generic line."
                  : `${pitch.trim().length} / ${RECRUITING_PITCH_MAX} characters`}
              </p>
              <Button size="sm" onClick={handleSave} disabled={!loaded || isPending}>
                {isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                Save pitch
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
