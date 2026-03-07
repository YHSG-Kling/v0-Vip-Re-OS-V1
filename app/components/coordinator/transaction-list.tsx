"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ClipboardList, MapPin, Calendar, ChevronRight, AlertTriangle, CheckCircle2 } from "lucide-react"
import Link from "next/link"

interface Transaction {
  id: string
  property_address: string
  close_date: string
  status: string
  stage: string
  purchase_price: number
  health_score?: number
  deal_health?: {
    overall_score: number
    risk_level: string
    flags: string[]
    ai_narrative?: string
  }
  assignment_id?: string
  is_primary?: boolean
  assigned_at?: string
}

// Health Ring component
function HealthRing({ score, size = 40 }: { score: number; size?: number }) {
  const strokeWidth = 4
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const progress = (score / 100) * circumference
  const offset = circumference - progress

  const getColor = (score: number) => {
    if (score >= 80) return "stroke-emerald-500"
    if (score >= 60) return "stroke-amber-500"
    return "stroke-red-500"
  }

  const getBgColor = (score: number) => {
    if (score >= 80) return "stroke-emerald-100"
    if (score >= 60) return "stroke-amber-100"
    return "stroke-red-100"
  }

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg className="transform -rotate-90" width={size} height={size}>
        {/* Background circle */}
        <circle
          className={getBgColor(score)}
          strokeWidth={strokeWidth}
          fill="transparent"
          r={radius}
          cx={size / 2}
          cy={size / 2}
        />
        {/* Progress circle */}
        <circle
          className={getColor(score)}
          strokeWidth={strokeWidth}
          fill="transparent"
          r={radius}
          cx={size / 2}
          cy={size / 2}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-semibold">{score}</span>
      </div>
    </div>
  )
}

export function CoordinatorTransactionList({ transactions }: { transactions: Transaction[] }) {
  const getStageColor = (stage: string) => {
    switch (stage?.toLowerCase()) {
      case "contract":
      case "under_contract":
        return "bg-blue-100 text-blue-800 border-blue-200"
      case "due_diligence":
      case "inspection":
        return "bg-purple-100 text-purple-800 border-purple-200"
      case "financing":
      case "loan_approval":
        return "bg-indigo-100 text-indigo-800 border-indigo-200"
      case "pending":
      case "clear_to_close":
        return "bg-amber-100 text-amber-800 border-amber-200"
      case "closing":
      case "closing_scheduled":
        return "bg-emerald-100 text-emerald-800 border-emerald-200"
      default:
        return "bg-gray-100 text-gray-800 border-gray-200"
    }
  }

  const getRiskBadge = (riskLevel?: string) => {
    switch (riskLevel?.toLowerCase()) {
      case "high":
        return (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="h-3 w-3" />
            High Risk
          </Badge>
        )
      case "medium":
        return (
          <Badge variant="default" className="bg-amber-500 hover:bg-amber-600 gap-1">
            <AlertTriangle className="h-3 w-3" />
            Medium
          </Badge>
        )
      default:
        return null
    }
  }

  const getDaysToClose = (closeDate: string) => {
    if (!closeDate) return null
    const days = Math.floor((new Date(closeDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    return days
  }

  const formatStage = (stage: string) => {
    if (!stage) return "Unknown"
    return stage.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5" />
          Active Transactions
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {transactions.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <ClipboardList className="h-12 w-12 mx-auto mb-3 opacity-20" />
              <p>No active transactions assigned</p>
              <p className="text-sm mt-1">Transactions will appear here when assigned to you</p>
            </div>
          ) : (
            transactions.map((txn) => {
              const daysToClose = getDaysToClose(txn.close_date)
              const healthScore = txn.deal_health?.overall_score ?? txn.health_score ?? 0
              const riskLevel = txn.deal_health?.risk_level
              const flags = txn.deal_health?.flags || []

              return (
                <div key={txn.id} className="p-4 hover:bg-muted/50 transition-colors">
                  <div className="flex items-start gap-4">
                    {/* Health Ring */}
                    <HealthRing score={healthScore} />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1 flex-1 min-w-0">
                          {/* Address and Stage Badge */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span className="font-medium truncate">{txn.property_address || "No address"}</span>
                            <Badge className={`${getStageColor(txn.stage)} border text-xs`}>
                              {formatStage(txn.stage || txn.status)}
                            </Badge>
                          </div>

                          {/* Metrics Row */}
                          <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
                            {/* Days to Close */}
                            {daysToClose !== null && (
                              <span className="flex items-center gap-1">
                                <Calendar className="h-3 w-3" />
                                {daysToClose <= 0 ? (
                                  <Badge variant="destructive" className="text-xs">
                                    Past Due
                                  </Badge>
                                ) : daysToClose <= 7 ? (
                                  <Badge variant="outline" className="text-amber-600 border-amber-300 text-xs">
                                    {daysToClose}d to close
                                  </Badge>
                                ) : (
                                  <span>{daysToClose}d to close</span>
                                )}
                              </span>
                            )}

                            {/* Price */}
                            {txn.purchase_price && (
                              <span>${(txn.purchase_price / 1000).toFixed(0)}k</span>
                            )}

                            {/* Risk Badge */}
                            {getRiskBadge(riskLevel)}
                          </div>

                          {/* Flags/Issues */}
                          {flags.length > 0 && (
                            <div className="flex items-center gap-2 mt-1">
                              <AlertTriangle className="h-3 w-3 text-amber-500" />
                              <span className="text-xs text-amber-600">{flags.slice(0, 2).join(" | ")}</span>
                              {flags.length > 2 && (
                                <Badge variant="outline" className="text-xs">
                                  +{flags.length - 2} more
                                </Badge>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Action Button */}
                        <Button variant="ghost" size="icon" asChild className="flex-shrink-0">
                          <Link href={`/transactions/${txn.id}`}>
                            <ChevronRight className="h-5 w-5" />
                          </Link>
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </CardContent>
    </Card>
  )
}
