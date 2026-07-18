"use client"

// Brokerage-facing usage warning — works on ALL subscriber tiers (solo_agent, team,
// brokerage). Renders ONLY when the superadmin enabled the warning AND the brokerage
// is approaching/over its limit. Deliberately generic: never a vendor name or a
// dollar amount (that detail is platform-staff only). Client component so it can mount
// on both server (broker) and client (agent/team) dashboards.
//
// When sends have actually been PAUSED by the limit (the egress gate's refusal
// ledger), the banner says so with an honest 30-day count — a coarse count only,
// which stays inside the privacy contract (no vendors, no dollars).
import { useEffect, useState } from "react"
import { AlertTriangle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/app/components/ui/alert"
import { getBrokerageBudgetWarning, getBudgetBlockedSendCount30d } from "@/app/actions/vendor-budget"

export default function BudgetWarningBanner() {
  const [state, setState] = useState<{ show: boolean; paused: boolean }>({ show: false, paused: false })
  const [blocked30d, setBlocked30d] = useState(0)

  useEffect(() => {
    let active = true
    getBrokerageBudgetWarning()
      .then((view) => {
        if (!active || !view || view.scope !== "brokerage" || !view.showWarning) return
        setState({ show: true, paused: view.level === "paused" })
        // Only fetch the blocked-sends count once the warning surface is live.
        getBudgetBlockedSendCount30d()
          .then((n) => { if (active && n > 0) setBlocked30d(n) })
          .catch(() => {})
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  if (!state.show) return null
  return (
    <Alert variant={state.paused ? "destructive" : "default"} className="mb-4">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{state.paused ? "Usage limit reached" : "Approaching your usage limit"}</AlertTitle>
      <AlertDescription>
        {state.paused
          ? "Some AI-powered features are temporarily paused for this month. Contact support if you need them re-enabled."
          : "You're getting close to your monthly usage limit. Some AI-powered features may pause if it's reached."}
        {blocked30d > 0 && (
          <span className="block mt-1">
            {blocked30d === 1
              ? "1 outbound send was paused by the usage limit in the last 30 days."
              : `${blocked30d} outbound sends were paused by the usage limit in the last 30 days.`}
          </span>
        )}
      </AlertDescription>
    </Alert>
  )
}
