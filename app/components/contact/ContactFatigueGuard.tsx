"use client"

/**
 * Contact reach-out fatigue guard — compact, read-only island for the contact detail
 * surface. Tells an agent at a glance whether this contact is over-contacted before they
 * fire an outreach quick-action.
 *
 * Data comes from the System 5.8 fatigue store via @/app/actions/fatigue:
 *   - getBuyerFatigueScore : current buyer_fatigue_scores row (ownership-checked server-side)
 *   - getBuyerFatigueAlert  : most recent undismissed fatigue_alerts row
 * Both are read-only (no writes), so we load on mount. The verdict (level + "safe to reach
 * out" + reason) is computed by the pure lib/fatigue/fatigue-display helper.
 *
 * Authorization is enforced INSIDE the server actions (brokerage resolved from session,
 * contact ownership verified) — a foreign contactId returns a structured Forbidden, not a row.
 */
import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { ShieldCheck, ShieldAlert } from "lucide-react"
import { getBuyerFatigueScore, getBuyerFatigueAlert } from "@/app/actions/buyer-fatigue"
import {
  buildReachoutGuard,
  type ReachoutGuard,
  type FatigueScoreInput,
  type FatigueAlertInput,
} from "@/lib/fatigue/fatigue-display"

interface Props {
  contactId: string
}

export function ContactFatigueGuard({ contactId }: Props) {
  const [guard, setGuard] = useState<ReachoutGuard | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      const [scoreRes, alertRes] = await Promise.all([
        getBuyerFatigueScore(contactId),
        getBuyerFatigueAlert(contactId),
      ])
      if (!active) return
      // buyer-fatigue's getBuyerFatigueScore returns the row as `data` (the retired
      // duplicate action module called it `score`).
      const score = scoreRes.success ? (scoreRes.data as FatigueScoreInput | null) : null
      const alert =
        alertRes.success && alertRes.alert ? (alertRes.alert as FatigueAlertInput) : null
      setGuard(buildReachoutGuard(score, alert))
      setLoaded(true)
    })()
    return () => {
      active = false
    }
  }, [contactId])

  // Until loaded, render nothing (the quick-action panel stays clean for non-buyer contacts
  // that will simply resolve to "Not scored").
  if (!loaded || !guard) return null

  const ok = guard.safeToReachOut
  const wrap = ok
    ? "border-emerald-200 bg-emerald-50/60 text-emerald-900"
    : "border-orange-200 bg-orange-50/70 text-orange-900"

  return (
    <div className={`flex items-start gap-2 rounded border p-3 ${wrap}`}>
      {ok ? (
        <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
      ) : (
        <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-orange-600" />
      )}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">Reach-out fatigue</span>
          <Badge variant={ok ? "outline" : "default"} className="text-[10px]">
            {guard.label}
          </Badge>
        </div>
        <p className="text-xs leading-relaxed">{guard.reason}</p>
      </div>
    </div>
  )
}
