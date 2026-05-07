"use client"

import { useEffect, useState } from "react"
import { Banknote } from "lucide-react"
import { HeartbeatCard } from "./heartbeat-card"
import { getWealthAdvisorSurface, type WealthSurface } from "@/app/actions/predictive-surfaces"

/**
 * Wealth Advisor — surfaces refi/equity/1031/downsize opportunities AI
 * detected across the agent's contacts. Backend already detects them;
 * this is the missing agent-side surface (lifetime portal already shows
 * them client-side).
 */

const TYPE_LABEL: Record<string, string> = {
  refinance: "refinance",
  rate_drop: "rate drop",
  equity_extraction: "equity",
  cash_out: "cash-out",
  downsize: "downsize",
  upgrade: "upgrade",
  "1031_exchange": "1031",
  investment: "investment",
}

function fmt(n: number | null): string {
  if (n == null || n === 0) return "—"
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function fmtTotal(n: number): string {
  if (n === 0) return "$0"
  return `$${(n / 1000).toFixed(1)}k`
}

export function WealthAdvisorCard() {
  const [data, setData] = useState<WealthSurface | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getWealthAdvisorSurface()
      .then(setData)
      .finally(() => setLoading(false))
  }, [])

  if (loading || !data || data.opportunities.length === 0) return null

  const top = data.opportunities[0]
  const topType = data.topOpportunityType ? (TYPE_LABEL[data.topOpportunityType] ?? data.topOpportunityType) : null

  return (
    <HeartbeatCard
      icon={<Banknote className="h-4 w-4" />}
      title="Wealth Advisor"
      subtitle="Refi · equity · 1031 · downsize opportunities your contacts qualify for"
      status="attention"
      metrics={[
        { label: "Open opportunities", value: data.totalOpen },
        { label: "Potential monthly savings", value: fmtTotal(data.totalPotentialMonthlySavings), trend: "up" },
        ...(topType
          ? [{ label: "Top category", value: topType }]
          : []),
      ]}
      statusLine={
        top
          ? `${top.contactName} qualifies for ${TYPE_LABEL[top.opportunityType] ?? top.opportunityType}. ${
              top.monthlySavingsEstimate
                ? `Could save ${fmt(top.monthlySavingsEstimate)}/mo.`
                : top.oneTimeProceedsEstimate
                ? `Estimated proceeds ${fmt(top.oneTimeProceedsEstimate)}.`
                : ""
            }`
          : undefined
      }
      ctas={[
        {
          label: `Review ${top?.contactName.split(" ")[0] ?? "opportunity"}`,
          href: top ? `/crm?contact=${top.contactId}` : "/lifetime-customers",
        },
        { label: "All opportunities", href: "/lifetime-customers?tab=wealth" },
      ]}
    />
  )
}
