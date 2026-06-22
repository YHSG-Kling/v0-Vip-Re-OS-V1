"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Gauge, Loader2, AlertTriangle } from "lucide-react"
import { evaluateAndLogLeadReadiness } from "@/app/actions/lead-readiness/evaluate-readiness"

const STATE_STYLE: Record<string, string> = {
  ai_qualifying: "bg-blue-100 text-blue-700 border-blue-200",
  ready_for_assignment: "bg-emerald-100 text-emerald-700 border-emerald-200",
  assigned_active: "bg-violet-100 text-violet-700 border-violet-200",
  stalled_no_response: "bg-amber-100 text-amber-700 border-amber-200",
  broker_review_required: "bg-red-100 text-red-700 border-red-200",
}

interface Evaluation {
  state: string
  explanation: string
  recommendedAction: string
  staleDays?: number
  warnings: string[]
}

/**
 * On-demand lead-readiness evaluation. Runs only when clicked (the action logs a
 * readiness transition to activities each call, so it must not fire on page load).
 * Read-only decision support — never contacts the lead or changes its stage.
 */
export function LeadReadinessPanel({ leadId }: { leadId: string }) {
  const [loading, setLoading] = useState(false)
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null)
  const [handoff, setHandoff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setLoading(true)
    setError(null)
    try {
      const res = await evaluateAndLogLeadReadiness(leadId)
      if (res.error || !res.evaluation) {
        setError(res.error ?? "Evaluation failed")
      } else {
        setEvaluation(res.evaluation as unknown as Evaluation)
        setHandoff(res.handoffContext)
      }
    } catch {
      setError("Evaluation failed")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-sm flex items-center gap-2"><Gauge className="h-4 w-4 text-blue-600" />Lead Readiness</CardTitle>
            <CardDescription>Where this lead is in the journey + the recommended next step.</CardDescription>
          </div>
          <Button size="sm" onClick={run} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Gauge className="h-4 w-4 mr-1" />}
            {evaluation ? "Re-evaluate" : "Evaluate"}
          </Button>
        </div>
      </CardHeader>
      {(evaluation || error) && (
        <CardContent className="text-sm space-y-2">
          {error && <p className="text-red-600">{error}</p>}
          {evaluation && (
            <>
              <Badge className={STATE_STYLE[evaluation.state] ?? "bg-gray-100 text-gray-600 border-gray-200"}>
                {evaluation.state.replace(/_/g, " ")}
              </Badge>
              <p className="text-muted-foreground">{evaluation.explanation}</p>
              <p><span className="font-medium">Recommended:</span> {evaluation.recommendedAction}</p>
              {evaluation.staleDays != null && (
                <p className="text-xs text-muted-foreground">{evaluation.staleDays} day(s) since last activity</p>
              )}
              {evaluation.warnings?.length > 0 && (
                <div className="text-xs text-amber-600 space-y-0.5">
                  {evaluation.warnings.map((w, i) => (
                    <p key={i} className="flex items-center gap-1"><AlertTriangle className="h-3 w-3" />{w}</p>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
