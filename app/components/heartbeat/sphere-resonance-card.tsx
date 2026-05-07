"use client"

import { useEffect, useState } from "react"
import { Heart } from "lucide-react"
import { HeartbeatCard } from "./heartbeat-card"
import { getSphereResonanceSurface, type SphereSurface } from "@/app/actions/predictive-surfaces"

/**
 * Sphere Resonance — surfaces contacts whose engagement has dropped and
 * proposes drafted touchpoints. Backend (cron + scoring) is built; this
 * is the missing dashboard surface.
 */
export function SphereResonanceCard() {
  const [data, setData] = useState<SphereSurface | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getSphereResonanceSurface()
      .then(setData)
      .finally(() => setLoading(false))
  }, [])

  if (loading || !data || data.candidates.length === 0) return null

  const status =
    data.totalAtRisk >= 10 ? "critical" :
    data.totalAtRisk >= 5 ? "attention" :
    data.totalAtRisk > 0 ? "neutral" : "ok"

  return (
    <HeartbeatCard
      icon={<Heart className="h-4 w-4" />}
      title="Sphere Resonance"
      subtitle="Relationships that need attention before they go cold"
      status={status}
      metrics={[
        { label: "At-risk", value: data.totalAtRisk, trend: data.totalAtRisk > 0 ? "down" : "flat" },
        { label: "Top risk", value: data.topRiskName ?? "—" },
      ]}
      statusLine={
        data.candidates.length > 0
          ? `${data.candidates[0].contactName} hasn't heard from you in ${data.candidates[0].daysSinceLastInteraction} days. AI can draft a contextual touchpoint.`
          : undefined
      }
      ctas={[
        {
          label: `Draft touch for ${data.candidates[0]?.contactName.split(" ")[0]}`,
          href: data.candidates[0]
            ? `/crm?contact=${data.candidates[0].contactId}&action=draft_followup`
            : "/lifetime-customers",
        },
        { label: "View all", href: "/lifetime-customers" },
      ]}
    />
  )
}
