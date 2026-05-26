// app/components/shell/budget-warning-banner.tsx
// Brokerage-facing usage warning. Renders ONLY when the superadmin has enabled the
// warning AND the brokerage is approaching/over its limit. Deliberately generic:
// it never names a vendor or shows a dollar amount — that detail is platform-only.
import { AlertTriangle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/app/components/ui/alert"
import { getBrokerageBudgetWarning } from "@/app/actions/vendor-budget"

export default async function BudgetWarningBanner() {
  const view = await getBrokerageBudgetWarning()
  if (!view || view.scope !== "brokerage" || !view.showWarning) return null

  const paused = view.level === "paused"
  return (
    <Alert variant={paused ? "destructive" : "default"} className="mb-4">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{paused ? "Usage limit reached" : "Approaching your usage limit"}</AlertTitle>
      <AlertDescription>
        {paused
          ? "Some AI-powered features are temporarily paused for this month. Contact support if you need them re-enabled."
          : "You're getting close to your monthly usage limit. Some AI-powered features may pause if it's reached."}
      </AlertDescription>
    </Alert>
  )
}
