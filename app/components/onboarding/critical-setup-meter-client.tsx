"use client"

/**
 * Client fetch wrapper for THE SETUP METER — for CLIENT-component dashboards
 * (the agent dashboard is "use client"). Loads the session-scoped readiness
 * via the server action on mount; renders nothing while loading or when the
 * caller has no critical-setup role (contacts, platform staff).
 */

import { useEffect, useState } from "react"
import { getMyCriticalSetupReadiness } from "@/app/actions/critical-setup"
import { CriticalSetupMeter } from "./critical-setup-meter"
import type { CriticalSetupReadiness } from "@/lib/onboarding/critical-setup"

export function CriticalSetupMeterClient({ variant = "compact" }: { variant?: "full" | "compact" }) {
  const [readiness, setReadiness] = useState<CriticalSetupReadiness | null>(null)
  useEffect(() => {
    getMyCriticalSetupReadiness().then(setReadiness).catch(() => setReadiness(null))
  }, [])
  if (!readiness) return null
  return <CriticalSetupMeter readiness={readiness} variant={variant} />
}
