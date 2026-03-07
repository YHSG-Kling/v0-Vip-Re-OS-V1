"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import {
  AlertTriangle,
  AlertCircle,
  Eye,
  CheckCircle,
  ChevronRight,
  Filter,
  RefreshCw,
  X,
} from "lucide-react"

// ─── Types ────────────────────────────────────────────────────────────────────

type RiskLevel = "critical" | "at_risk" | "watch" | "healthy"

interface HealthScore {
  id: string
  transaction_id: string
  overall_score: number
  risk_level: RiskLevel
  ai_narrative: string | null
  calculated_at: string
  transactions: {
    id: string
    property_address: string | null
    stage: string | null
    contract_price: number | null
    closing_date: string | null
    contact_id: string | null
    agent_user_id: string | null
    contacts: { first_name: string | null; last_name: string | null } | null
    profiles: { first_name: string | null; last_name: string | null } | null
  } | null
}

interface Intervention {
  id: string
  intervention_type: string
  title: string
  description: string | null
  status: string
  created_at: string
  transaction_id: string | null
}

interface Summary {
  critical: number
  at_risk: number
  watch: number
  healthy: number
  total: number
}

interface Props {
  healthScores: HealthScore[]
  interventions: Intervention[]
  summary: Summary
  brokerageId: string
}

// ─── Risk Level Config ────────────────────────────────────────────────────────

const RISK_CONFIG: Record<RiskLevel, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
  critical: { label: "Critical", color: "text-red-600", bgColor: "bg-red-50 border-red-200", icon: AlertTriangle },
  at_risk:  { label: "At Risk",  color: "text-amber-600", bgColor: "bg-amber-50 border-amber-200", icon: AlertCircle },
  watch:    { label: "Watch",    color: "text-yellow-600", bgColor: "bg-yellow-50 border-yellow-200", icon: Eye },
  healthy:  { label: "Healthy",  color: "text-green-600", bgColor: "bg-green-50 border-green-200", icon: CheckCircle },
}

const STAGE_OPTIONS = [
  "UNDER_CONTRACT",
  "INSPECTION",
  "APPRAISAL",
  "FINANCING",
  "TITLE_ESCROW",
  "FINAL_WALKTHROUGH",
  "CLOSING",
]

// ─── Component ────────────────────────────────────────────────────────────────

export function DealHealthDashboardClient({ healthScores, interventions, summary, brokerageId }: Props) {
  const [stageFilter, setStageFilter] = useState<string | null>(null)
  const [riskFilter, setRiskFilter] = useState<RiskLevel | null>(null)
  const [showInterventions, setShowInterventions] = useState(interventions.length > 0)

  const filteredScores = useMemo(() => {
    return healthScores.filter(score => {
      if (stageFilter && score.transactions?.stage !== stageFilter) return false
      if (riskFilter && score.risk_level !== riskFilter) return false
      return true
    })
  }, [healthScores, stageFilter, riskFilter])

  function formatPrice(price: number | null): string {
    if (!price) return "—"
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(price)
  }

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return "—"
    return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Deal Health Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Monitor health scores across {summary.total} active transactions
          </p>
        </div>
        <Link
          href="/dashboard/brokerage"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to Brokerage
        </Link>
      </div>

      {/* Interventions Banner */}
      {showInterventions && interventions.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-900">
                  {interventions.length} Unresolved Intervention{interventions.length > 1 ? "s" : ""}
                </p>
                <ul className="mt-1 space-y-1">
                  {interventions.slice(0, 3).map(i => (
                    <li key={i.id} className="text-sm text-amber-800">
                      {i.title}
                      {i.transaction_id && (
                        <Link
                          href={`/dashboard/transactions/${i.transaction_id}`}
                          className="ml-2 text-amber-600 hover:underline"
                        >
                          View Deal
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <button onClick={() => setShowInterventions(false)} className="text-amber-600 hover:text-amber-800">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        {(["critical", "at_risk", "watch", "healthy"] as RiskLevel[]).map(level => {
          const config = RISK_CONFIG[level]
          const Icon = config.icon
          const count = summary[level]
          return (
            <button
              key={level}
              onClick={() => setRiskFilter(riskFilter === level ? null : level)}
              className={cn(
                "p-4 rounded-lg border transition-all text-left",
                config.bgColor,
                riskFilter === level && "ring-2 ring-offset-2 ring-primary"
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <Icon className={cn("w-4 h-4", config.color)} />
                <span className={cn("text-sm font-medium", config.color)}>{config.label}</span>
              </div>
              <p className="text-2xl font-bold text-foreground">{count}</p>
            </button>
          )
        })}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Filter:</span>
        </div>

        <select
          value={stageFilter ?? ""}
          onChange={e => setStageFilter(e.target.value || null)}
          className="px-3 py-1.5 text-sm border rounded-md bg-background"
        >
          <option value="">All Stages</option>
          {STAGE_OPTIONS.map(stage => (
            <option key={stage} value={stage}>
              {stage.replace(/_/g, " ")}
            </option>
          ))}
        </select>

        {(stageFilter || riskFilter) && (
          <button
            onClick={() => { setStageFilter(null); setRiskFilter(null) }}
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" />
            Clear
          </button>
        )}

        <span className="ml-auto text-sm text-muted-foreground">
          Showing {filteredScores.length} of {healthScores.length} deals
        </span>
      </div>

      {/* Deals Table */}
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Property
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Stage
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Score
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Agent
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Closing
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredScores.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  No deals match the current filters
                </td>
              </tr>
            )}
            {filteredScores.map(score => {
              const config = RISK_CONFIG[score.risk_level]
              const Icon = config.icon
              const txn = score.transactions
              const agentName = txn?.profiles
                ? `${txn.profiles.first_name ?? ""} ${txn.profiles.last_name ?? ""}`.trim()
                : "Unassigned"

              return (
                <tr key={score.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium text-foreground text-sm truncate max-w-[200px]">
                        {txn?.property_address ?? "No Address"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatPrice(txn?.contract_price)}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded">
                      {txn?.stage?.replace(/_/g, " ") ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-12 h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            score.overall_score >= 85 ? "bg-green-500" :
                            score.overall_score >= 70 ? "bg-yellow-500" :
                            score.overall_score >= 40 ? "bg-amber-500" : "bg-red-500"
                          )}
                          style={{ width: `${score.overall_score}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium">{score.overall_score}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium", config.bgColor, config.color)}>
                      <Icon className="w-3 h-3" />
                      {config.label}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {agentName}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {formatDate(txn?.closing_date)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/dashboard/transactions/${score.transaction_id}`}
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      View
                      <ChevronRight className="w-4 h-4" />
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* AI Narratives Section */}
      {filteredScores.some(s => s.ai_narrative) && (
        <div className="space-y-3">
          <h2 className="text-lg font-medium text-foreground">AI Health Summaries</h2>
          <div className="grid gap-3">
            {filteredScores
              .filter(s => s.ai_narrative && (s.risk_level === "critical" || s.risk_level === "at_risk"))
              .slice(0, 5)
              .map(score => {
                const config = RISK_CONFIG[score.risk_level]
                return (
                  <div key={score.id} className={cn("p-4 rounded-lg border", config.bgColor)}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <p className="font-medium text-sm text-foreground mb-1">
                          {score.transactions?.property_address ?? "Unknown Property"}
                        </p>
                        <p className="text-sm text-muted-foreground">{score.ai_narrative}</p>
                      </div>
                      <Link
                        href={`/dashboard/transactions/${score.transaction_id}`}
                        className="shrink-0 text-sm text-primary hover:underline"
                      >
                        View Deal
                      </Link>
                    </div>
                  </div>
                )
              })}
          </div>
        </div>
      )}
    </div>
  )
}
