"use client"

// TENANT → PLATFORM NPS survey card — the small dismissible "how likely are
// you to recommend us?" card on the tenant dashboard home.
//
// Shows only when the server says the user is eligible (once per QUARTER,
// 30+ days of tenancy — lib/platform/nps.ts). Dismiss stores NOTHING server-
// side: a sessionStorage flag hides it for this browser session only, so the
// user is honestly re-promptable next visit and definitely next quarter.
// Submitting records score + optional one-liner for the current month; the
// UNIQUE(user_id, period) constraint makes double-clicks harmless.

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { X, Loader2 } from "lucide-react"
import { shouldPromptNpsAction, submitNpsAction } from "@/app/actions/nps"

const DISMISS_KEY = "platform-nps-dismissed"

export function NpsSurveyCard() {
  const [visible, setVisible] = useState(false)
  const [score, setScore] = useState<number | null>(null)
  const [verbatim, setVerbatim] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    try {
      if (sessionStorage.getItem(DISMISS_KEY)) return
    } catch {
      /* storage unavailable — fall through and ask the server */
    }
    let cancelled = false
    shouldPromptNpsAction()
      .then((r) => {
        if (!cancelled && r.prompt) setVisible(true)
      })
      .catch(() => {
        /* never break the dashboard over a survey */
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!visible) return null

  function dismiss() {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1")
    } catch {
      /* session-only anyway */
    }
    setVisible(false)
  }

  function submit() {
    if (score === null || pending) return
    setError(null)
    startTransition(async () => {
      const r = await submitNpsAction({ score, verbatim: verbatim.trim() || undefined })
      if (r.ok) {
        setSubmitted(true)
        setTimeout(() => setVisible(false), 3500)
      } else {
        setError(r.error)
      }
    })
  }

  if (submitted) {
    return (
      <Card className="border-emerald-200 bg-emerald-50/60">
        <CardContent className="py-3 text-sm text-emerald-800">
          Thanks — your feedback goes straight to the team building this platform.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              How likely are you to recommend this platform to another agent or broker?
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              0 = not at all likely · 10 = extremely likely. One question, once a quarter.
            </p>
          </div>
          <button
            type="button"
            aria-label="Dismiss survey"
            onClick={dismiss}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {Array.from({ length: 11 }, (_, n) => (
            <button
              key={n}
              type="button"
              onClick={() => setScore(n)}
              className={
                "h-8 w-8 rounded-md border text-sm font-medium tabular-nums transition-colors " +
                (score === n
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-muted")
              }
            >
              {n}
            </button>
          ))}
        </div>

        {score !== null && (
          <div className="mt-3 flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={verbatim}
              onChange={(e) => setVerbatim(e.target.value)}
              maxLength={1000}
              placeholder="One line on why (optional)"
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <Button size="sm" onClick={submit} disabled={pending} className="shrink-0">
              {pending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Send
            </Button>
          </div>
        )}

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </CardContent>
    </Card>
  )
}
