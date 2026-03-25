"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Target, Award, AlertCircle } from "lucide-react"

interface CapProgressBarProps {
  capAmount: number | null
  capProgress: number
  capProgressPct: number
  bonusCredits: number
  /** From agent_cap_tracking.is_capped */
  isCapped?: boolean
  /** ISO date string — from agent_cap_tracking.anniversary_start */
  anniversaryStart?: string
  /** ISO date string — from agent_cap_tracking.anniversary_end */
  anniversaryEnd?: string
}

export function CapProgressBar({
  capAmount,
  capProgress,
  capProgressPct,
  bonusCredits,
  isCapped = false,
  anniversaryStart,
  anniversaryEnd,
}: CapProgressBarProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  }

  // Determine cap status — agent_cap_tracking.is_capped is authoritative
  const getCapStatus = () => {
    if (!capAmount) return { label: "No Cap", variant: "secondary" as const, color: "text-muted-foreground" }
    if (isCapped || capProgressPct >= 100) return { label: "Cap Hit!", variant: "default" as const, color: "text-green-600" }
    if (capProgressPct >= 80) return { label: "Near Cap", variant: "outline" as const, color: "text-amber-600" }
    return { label: "Below Cap", variant: "secondary" as const, color: "text-muted-foreground" }
  }

  const capStatus = getCapStatus()

  // If no cap configured
  if (!capAmount) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Cap Progress</CardTitle>
            </div>
            <Badge variant="secondary">No Cap</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-muted-foreground">
            <AlertCircle className="h-4 w-4" />
            <p className="text-sm">No cap configured — contact your broker</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const remaining = Math.max(0, capAmount - capProgress)
  const progressValue = Math.min(capProgressPct, 100)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target className="h-5 w-5 text-blue-600" />
            <div>
              <CardTitle>Cap Progress</CardTitle>
              <CardDescription>
                {formatCurrency(capProgress)} of {formatCurrency(capAmount)}
              </CardDescription>
            </div>
          </div>
          <Badge 
            variant={capStatus.variant}
            className={capStatus.color === "text-green-600" ? "bg-green-100 text-green-800" : 
                       capStatus.color === "text-amber-600" ? "bg-amber-100 text-amber-800" : ""}
          >
            {capStatus.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className={`font-medium ${capStatus.color}`}>
              {capProgressPct.toFixed(1)}%
            </span>
          </div>
          <Progress 
            value={progressValue} 
            className="h-3"
          />
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-4 pt-2">
          <div className="text-center">
            <p className="text-lg font-semibold text-blue-600">
              {formatCurrency(capProgress)}
            </p>
            <p className="text-xs text-muted-foreground">Paid to Cap</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold text-muted-foreground">
              {formatCurrency(remaining)}
            </p>
            <p className="text-xs text-muted-foreground">Remaining</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1">
              <Award className="h-4 w-4 text-amber-500" />
              <p className="text-lg font-semibold text-amber-600">
                {formatCurrency(bonusCredits)}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">Bonus Credits</p>
          </div>
        </div>

        {/* Cap hit celebration */}
        {capProgressPct >= 100 && (
          <div className="mt-4 p-3 bg-green-50 rounded-lg border border-green-200">
            <div className="flex items-center gap-2">
              <Award className="h-5 w-5 text-green-600" />
              <p className="text-sm font-medium text-green-800">
                Congratulations! You've hit your cap — you now keep 100% of your commission!
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
