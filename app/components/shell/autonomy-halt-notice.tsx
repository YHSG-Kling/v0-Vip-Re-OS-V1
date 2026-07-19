"use client"

// AUTONOMY-HALT NOTICE — dashboard-mountable wrapper around the Command Center's
// AutonomyHaltBanner. The per-tenant staff halt (feature_access_overrides 'autonomy'
// kill) previously surfaced ONLY inside /dashboard/admin/command-center, which had
// no nav entry — so a halted tenant could go days without seeing WHY their AI team
// went quiet. This mounts the same honest banner on the dashboards principals
// actually land on (broker + agent/solo/team-lead), following the same client
// self-fetch pattern as BudgetWarningBanner so it works on server AND client pages.
// Renders nothing unless the tenant is actually halted.

import { useEffect, useState } from "react"
import { getTenantAutonomyHaltAction } from "@/app/actions/autonomy-halt"
import { AutonomyHaltBanner } from "@/app/dashboard/admin/command-center/autonomy-halt-banner"

export default function AutonomyHaltNotice() {
  const [halt, setHalt] = useState<{ reason: string | null; haltedAt: string | null } | null>(null)

  useEffect(() => {
    let active = true
    getTenantAutonomyHaltAction()
      .then((h) => {
        if (active && h?.halted) setHalt({ reason: h.reason, haltedAt: h.haltedAt })
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  if (!halt) return null
  return (
    <div className="mb-4">
      <AutonomyHaltBanner reason={halt.reason} haltedAt={halt.haltedAt} />
    </div>
  )
}
