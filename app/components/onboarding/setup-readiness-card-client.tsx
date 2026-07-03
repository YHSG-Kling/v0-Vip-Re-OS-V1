"use client"

import { useEffect, useState } from "react"
import { getMySetupReadiness } from "@/app/actions/setup-readiness"
import { SetupReadinessCardView } from "./setup-readiness-view"
import type { SetupReadiness } from "@/lib/onboarding/setup-readiness"

/** Client setup-readiness card — fetches readiness via the server action on mount. For CLIENT dashboards. */
export function SetupReadinessCardClient() {
  const [readiness, setReadiness] = useState<SetupReadiness | null>(null)
  useEffect(() => { getMySetupReadiness().then(setReadiness).catch(() => setReadiness(null)) }, [])
  if (!readiness) return null
  return <SetupReadinessCardView readiness={readiness} />
}
