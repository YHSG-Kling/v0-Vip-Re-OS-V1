"use client"

/**
 * THE ONBOARDING DECISION ROOM — "here's what your AI team already
 * prepared; approve it" as the first-week surface, beside the setup
 * checklist. Every card carries the preloaded EVIDENCE (real counts)
 * and routes to a rail that already runs; the assistant-identity card
 * adopts in place (principal-gated server-side).
 */

import { useState, useTransition } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Sparkles, CheckCircle2, Clock } from "lucide-react"
import { adoptAssistantIdentityAction } from "@/app/actions/onboarding-decisions"
import type { OnboardingDecision } from "@/lib/onboarding/onboarding-decisions"

const STATE_BADGE: Record<string, { className: string; label: string }> = {
  ready: { className: "bg-emerald-100 text-emerald-800", label: "ready for you" },
  waiting: { className: "bg-slate-100 text-slate-600", label: "waiting" },
  done: { className: "bg-green-50 text-green-700", label: "done" },
}

export function DecisionRoom({ decisions: initial }: { decisions: OnboardingDecision[] }) {
  const [decisions, setDecisions] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const openCount = decisions.filter((d) => d.state === "ready").length
  if (decisions.length === 0) return null

  const adopt = () => {
    setBusy(true)
    setError(null)
    startTransition(async () => {
      try {
        const r = await adoptAssistantIdentityAction()
        if (r.ok) {
          setDecisions((prev) => prev.map((d) => d.key === "meet_your_assistant"
            ? { ...d, state: "done" as const, adoptable: false, title: "Your AI assistant", evidence: `${r.assistantName} is live — it fronts your site chat, calls, and briefings.`, recommendation: "Nothing waiting here." }
            : d))
        } else setError(r.error)
      } finally {
        setBusy(false)
      }
    })
  }

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-emerald-600" />
        <h3 className="text-base font-semibold">Decisions waiting on you</h3>
        {openCount > 0 && <span className="text-xs text-muted-foreground">{openCount} prepared by your AI team</span>}
      </div>
      <ul className="mt-3 space-y-2">
        {decisions.map((d) => {
          const badge = STATE_BADGE[d.state]
          return (
            <li key={d.key} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                {d.state === "done" ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : d.state === "waiting" ? <Clock className="h-4 w-4 text-slate-400" /> : <Sparkles className="h-4 w-4 text-emerald-600" />}
                <span className="text-sm font-medium">{d.title}</span>
                <Badge className={`text-[10px] ${badge.className}`}>{badge.label}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{d.evidence}</p>
              {d.state !== "done" && <p className="mt-0.5 text-xs">{d.recommendation}</p>}
              <div className="mt-2 flex items-center gap-2">
                {d.adoptable && (
                  <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={adopt}>
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Adopt the proposed identity
                  </Button>
                )}
                <Link href={d.action.href} className="text-xs font-medium text-indigo-700 hover:underline">
                  {d.action.label} →
                </Link>
              </div>
            </li>
          )
        })}
      </ul>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  )
}
