"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileText, Download, BarChart3, Loader2, TrendingUp, TrendingDown } from "lucide-react"
import { getComplianceStatistics } from "@/app/actions/content-compliance"
import { generateComplianceReport } from "@/app/actions/compliance-monitoring"

interface ComplianceStats {
  total_evaluations: number
  pass_rate: number
  fail_rate: number
  review_required_rate: number
  top_violation_types: Array<{ type: string; count: number }>
  trend: "improving" | "declining" | "stable"
}

interface PolicyReportingPanelProps {
  complianceRate: number
  totalViolations: number
  criticalViolations: number
  totalCommunications: number
}

export function PolicyReportingPanel({
  complianceRate,
  totalViolations,
  criticalViolations,
  totalCommunications,
}: PolicyReportingPanelProps) {
  const [stats, setStats] = useState<ComplianceStats | null>(null)
  const [isPending, startTransition] = useTransition()
  const [isGenerating, setIsGenerating] = useState(false)

  const handleLoadStats = () => {
    startTransition(async () => {
      const today = new Date()
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
      
      const result = await getComplianceStatistics({
        date_range: {
          start: thirtyDaysAgo.toISOString(),
          end: today.toISOString(),
        },
      })

      if (result.success && result.stats) {
        setStats(result.stats as ComplianceStats)
      }
    })
  }

  const handleGenerateReport = async () => {
    setIsGenerating(true)
    try {
      const today = new Date()
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
      
      const report = await generateComplianceReport({
        startDate: thirtyDaysAgo.toISOString(),
        endDate: today.toISOString(),
      })

      // Create downloadable report
      const reportContent = JSON.stringify(report, null, 2)
      const blob = new Blob([reportContent], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `compliance-report-${today.toISOString().split("T")[0]}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } finally {
      setIsGenerating(false)
    }
  }

  const trend = complianceRate >= 90 ? "improving" : complianceRate >= 70 ? "stable" : "declining"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-5 w-5 text-muted-foreground" />
            Policy & Reporting
          </CardTitle>
          <Button variant="outline" size="sm" onClick={handleGenerateReport} disabled={isGenerating}>
            {isGenerating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Download className="h-4 w-4 mr-1" />
                Export
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Quick Stats */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-muted/50 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Compliance Rate</span>
              {trend === "improving" ? (
                <TrendingUp className="h-4 w-4 text-green-600" />
              ) : trend === "declining" ? (
                <TrendingDown className="h-4 w-4 text-destructive" />
              ) : null}
            </div>
            <div className={`text-2xl font-bold ${complianceRate >= 90 ? "text-green-600" : complianceRate >= 70 ? "text-orange-600" : "text-destructive"}`}>
              {complianceRate}%
            </div>
          </div>
          <div className="rounded-lg bg-muted/50 p-3">
            <span className="text-xs text-muted-foreground">Total Communications</span>
            <div className="text-2xl font-bold">{totalCommunications}</div>
          </div>
          <div className="rounded-lg bg-muted/50 p-3">
            <span className="text-xs text-muted-foreground">Total Violations</span>
            <div className={`text-2xl font-bold ${totalViolations > 0 ? "text-orange-600" : "text-green-600"}`}>
              {totalViolations}
            </div>
          </div>
          <div className="rounded-lg bg-muted/50 p-3">
            <span className="text-xs text-muted-foreground">Critical Issues</span>
            <div className={`text-2xl font-bold ${criticalViolations > 0 ? "text-destructive" : "text-green-600"}`}>
              {criticalViolations}
            </div>
          </div>
        </div>

        {/* Load Extended Stats */}
        {!stats ? (
          <Button variant="outline" className="w-full" onClick={handleLoadStats} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading Statistics...
              </>
            ) : (
              <>
                <BarChart3 className="mr-2 h-4 w-4" />
                Load Detailed Statistics
              </>
            )}
          </Button>
        ) : (
          <div className="space-y-3 pt-2 border-t">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Pass Rate</span>
              <Badge className="bg-green-500 text-white">{stats.pass_rate}%</Badge>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Fail Rate</span>
              <Badge variant="destructive">{stats.fail_rate}%</Badge>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Review Required</span>
              <Badge className="bg-orange-500 text-white">{stats.review_required_rate}%</Badge>
            </div>
            
            {stats.top_violation_types?.length > 0 && (
              <div className="pt-2 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-2">Top Violation Types</p>
                <div className="space-y-1">
                  {stats.top_violation_types.slice(0, 3).map((v, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{v.type}</span>
                      <Badge variant="outline">{v.count}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
