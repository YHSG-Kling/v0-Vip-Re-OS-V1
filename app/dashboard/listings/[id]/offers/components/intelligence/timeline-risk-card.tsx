"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, CheckCircle2, Clock, Banknote, FileSearch, User } from "lucide-react"

interface TimelineRiskCardProps {
  offer: {
    financing_type: string | null
    financing_contingency_days: number | null
    appraisal_contingency_days: number | null
    inspection_period_days: number | null
    closing_date: string | null
    down_payment_percent: number | null
    earnest_money_amount: number | null
    appraisal_gap: number | null
    contingencies: string[] | null
  }
  listPrice: number
}

type RiskLevel = "low" | "medium" | "high"

interface RiskItem {
  label: string
  level: RiskLevel
  description: string
  icon: typeof AlertTriangle
}

function assessRisks(offer: TimelineRiskCardProps["offer"], listPrice: number): RiskItem[] {
  const risks: RiskItem[] = []
  const isCash = offer.financing_type?.toLowerCase() === "cash"

  // Financing Risk
  if (isCash) {
    risks.push({
      label: "Financing Risk",
      level: "low",
      description: "Cash offer eliminates financing risk entirely.",
      icon: Banknote,
    })
  } else {
    const downPercent = offer.down_payment_percent ?? 0
    if (downPercent >= 25) {
      risks.push({
        label: "Financing Risk",
        level: "low",
        description: `Strong ${downPercent}% down payment indicates well-qualified buyer.`,
        icon: Banknote,
      })
    } else if (downPercent >= 15) {
      risks.push({
        label: "Financing Risk",
        level: "medium",
        description: `${downPercent}% down is adequate but watch for lender issues.`,
        icon: Banknote,
      })
    } else {
      risks.push({
        label: "Financing Risk",
        level: "high",
        description: `Low ${downPercent}% down payment increases financing fall-through risk.`,
        icon: Banknote,
      })
    }
  }

  // Appraisal Risk
  const appraisalDays = offer.appraisal_contingency_days
  const hasAppraisalGap = (offer.appraisal_gap ?? 0) > 0
  if (appraisalDays === null || appraisalDays === 0 || isCash) {
    risks.push({
      label: "Appraisal Risk",
      level: "low",
      description: hasAppraisalGap
        ? `Buyer will cover appraisal gap up to $${offer.appraisal_gap!.toLocaleString()}.`
        : "No appraisal contingency or cash purchase.",
      icon: FileSearch,
    })
  } else if (hasAppraisalGap) {
    risks.push({
      label: "Appraisal Risk",
      level: "low",
      description: `${appraisalDays}-day appraisal contingency with gap coverage up to $${offer.appraisal_gap!.toLocaleString()}.`,
      icon: FileSearch,
    })
  } else {
    risks.push({
      label: "Appraisal Risk",
      level: "medium",
      description: `${appraisalDays}-day appraisal contingency with no gap coverage — buyer may renegotiate if appraisal comes in low.`,
      icon: FileSearch,
    })
  }

  // Inspection / Contingency Risk
  const inspectionDays = offer.inspection_period_days ?? 0
  const contingencyCount = offer.contingencies?.length ?? 0
  if (contingencyCount === 0 && inspectionDays === 0) {
    risks.push({
      label: "Contingency Risk",
      level: "low",
      description: "No inspection or additional contingencies — clean offer.",
      icon: AlertTriangle,
    })
  } else if (contingencyCount <= 2 && inspectionDays <= 10) {
    risks.push({
      label: "Contingency Risk",
      level: "medium",
      description: `${contingencyCount} contingencies, ${inspectionDays}-day inspection period — standard terms.`,
      icon: AlertTriangle,
    })
  } else {
    risks.push({
      label: "Contingency Risk",
      level: "high",
      description: `${contingencyCount} contingencies with ${inspectionDays}-day inspection — multiple exit points for buyer.`,
      icon: AlertTriangle,
    })
  }

  // Close Speed
  const closingDate = offer.closing_date ? new Date(offer.closing_date) : null
  const daysToClose = closingDate
    ? Math.ceil((closingDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null
  if (daysToClose !== null) {
    if (daysToClose <= 21) {
      risks.push({
        label: "Close Speed",
        level: "low",
        description: `Fast ${daysToClose}-day close reduces market exposure and carrying costs.`,
        icon: Clock,
      })
    } else if (daysToClose <= 45) {
      risks.push({
        label: "Close Speed",
        level: "medium",
        description: `${daysToClose}-day close is standard for financed transactions.`,
        icon: Clock,
      })
    } else {
      risks.push({
        label: "Close Speed",
        level: "high",
        description: `Extended ${daysToClose}-day timeline increases market risk and carrying costs.`,
        icon: Clock,
      })
    }
  }

  // Buyer Strength (earnest money as proxy)
  const earnest = offer.earnest_money_amount ?? 0
  const earnestPercent = listPrice > 0 ? (earnest / listPrice) * 100 : 0
  if (earnestPercent >= 3) {
    risks.push({
      label: "Buyer Commitment",
      level: "low",
      description: `Strong ${earnestPercent.toFixed(1)}% earnest money ($${earnest.toLocaleString()}) shows serious commitment.`,
      icon: User,
    })
  } else if (earnestPercent >= 1) {
    risks.push({
      label: "Buyer Commitment",
      level: "medium",
      description: `Standard ${earnestPercent.toFixed(1)}% earnest money ($${earnest.toLocaleString()}).`,
      icon: User,
    })
  } else if (earnest > 0) {
    risks.push({
      label: "Buyer Commitment",
      level: "high",
      description: `Low ${earnestPercent.toFixed(1)}% earnest money ($${earnest.toLocaleString()}) — buyer has less at stake.`,
      icon: User,
    })
  }

  return risks
}

const levelConfig: Record<RiskLevel, { color: string; bgColor: string; label: string }> = {
  low: { color: "text-green-700", bgColor: "bg-green-50", label: "Low Risk" },
  medium: { color: "text-amber-700", bgColor: "bg-amber-50", label: "Medium" },
  high: { color: "text-red-700", bgColor: "bg-red-50", label: "High Risk" },
}

export function TimelineRiskCard({ offer, listPrice }: TimelineRiskCardProps) {
  const risks = assessRisks(offer, listPrice)
  const overallRisk = risks.some(r => r.level === "high")
    ? "high"
    : risks.some(r => r.level === "medium")
    ? "medium"
    : "low"

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">Timeline & Risk Assessment</CardTitle>
          <Badge variant="outline" className={`${levelConfig[overallRisk].color} border-current text-xs`}>
            {levelConfig[overallRisk].label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {risks.map((risk, idx) => {
          const Icon = risk.icon
          const config = levelConfig[risk.level]
          return (
            <div key={idx} className={`p-3 rounded-lg ${config.bgColor} flex items-start gap-2`}>
              <Icon className={`h-4 w-4 ${config.color} mt-0.5 shrink-0`} />
              <div className="min-w-0">
                <p className={`text-xs font-medium ${config.color}`}>{risk.label}</p>
                <p className="text-xs text-muted-foreground">{risk.description}</p>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
