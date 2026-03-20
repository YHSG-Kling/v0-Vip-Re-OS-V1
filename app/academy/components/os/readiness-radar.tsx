"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Target, Loader2, CheckCircle2, AlertTriangle, XCircle } from "lucide-react"
import { analyzeAgentPerformance } from "@/app/actions/ai-training-coaching"

interface ReadinessRadarProps {
  agentId: string
  performanceData?: any | null
}

export function ReadinessRadar({ agentId, performanceData: initialData }: ReadinessRadarProps) {
  const [performanceData, setPerformanceData] = useState<any | null>(initialData || null)
  const [loading, setLoading] = useState(false)

  const handleAnalyze = async () => {
    setLoading(true)
    try {
      const result = await analyzeAgentPerformance({
        agentId,
        timeframe: "30_days",
      })
      setPerformanceData(result)
    } catch (error) {
      console.error("Error analyzing performance:", error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5 text-purple-600" />
          Readiness Radar
        </CardTitle>
      </CardHeader>
      <CardContent>
        {performanceData ? (
          <div className="space-y-4">
            {/* Overall Score */}
            {performanceData.readiness_score !== undefined && (
              <div className="text-center p-4 bg-muted rounded-lg">
                <div className="text-3xl font-bold text-emerald-600">{performanceData.readiness_score}%</div>
                <div className="text-sm text-muted-foreground">Overall Readiness</div>
              </div>
            )}

            {/* Strengths */}
            {performanceData.strengths?.length > 0 && (
              <div>
                <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  Strength Areas
                </h4>
                <div className="space-y-2">
                  {performanceData.strengths.map((strength: string, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-sm p-2 bg-green-50 rounded">
                      <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                      <span>{strength}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Improvement Areas */}
            {performanceData.improvements?.length > 0 && (
              <div>
                <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  Areas for Improvement
                </h4>
                <div className="space-y-2">
                  {performanceData.improvements.map((item: string, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-sm p-2 bg-amber-50 rounded">
                      <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Critical Gaps */}
            {performanceData.critical_gaps?.length > 0 && (
              <div>
                <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                  <XCircle className="h-4 w-4 text-red-600" />
                  Critical Gaps
                </h4>
                <div className="space-y-2">
                  {performanceData.critical_gaps.map((gap: string, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-sm p-2 bg-red-50 rounded">
                      <XCircle className="h-4 w-4 text-red-600 shrink-0" />
                      <span>{gap}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Button variant="outline" onClick={handleAnalyze} disabled={loading} className="w-full">
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Refresh Analysis
            </Button>
          </div>
        ) : (
          <div className="text-center py-8">
            <Target className="h-12 w-12 mx-auto mb-3 text-muted-foreground opacity-30" />
            <p className="text-muted-foreground mb-4">Analyze your performance to see readiness insights</p>
            <Button onClick={handleAnalyze} disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                "Analyze Performance"
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
