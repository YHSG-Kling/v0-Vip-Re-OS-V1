"use client"

// Superadmin control: toggle whether brokerage/subscriber users see the
// "approaching usage limit" warning. Vendor names + dollar amounts are never shown
// to brokerages regardless — this only governs the generic warning banner.
import { useState, useTransition } from "react"
import { Switch } from "@/app/components/ui/switch"
import { setBrokerageBudgetWarningVisibility } from "@/app/actions/vendor-budget"

export function BudgetWarningToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function onToggle(next: boolean) {
    setEnabled(next) // optimistic
    setError(null)
    startTransition(async () => {
      const res = await setBrokerageBudgetWarningVisibility(next)
      if (!res.ok) {
        setEnabled(!next) // revert
        setError(res.error)
      }
    })
  }

  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">Brokerage usage warning</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          When on, brokerages see a generic &ldquo;approaching usage limit&rdquo; banner.
          Vendor names and costs are never exposed to brokerages.
        </p>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
      <Switch checked={enabled} onCheckedChange={onToggle} disabled={pending} aria-label="Toggle brokerage usage warning" />
    </div>
  )
}
