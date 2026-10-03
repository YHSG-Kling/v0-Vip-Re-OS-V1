"use client"

/**
 * CONVERSION FORECAST — the only conversion probability an agent can reach.
 *
 * `app/actions/ai-lead-nurturing.ts:aiPredictConversion` reads the contact, their
 * activity log and their property views, and returns a conversion probability, a
 * confidence level, weighted factors, risks, accelerators and a recommendation.
 * It writes `contacts.ai_conversion_probability` and
 * `contacts.ai_predicted_close_date`. It had no caller anywhere, and neither
 * column was read by anything either — so the forecast was written nowhere and
 * shown nowhere.
 *
 * WHY NOT THE OTHER PREDICTOR: `app/actions/ai-predictions.ts:predictLeadConversion`
 * answers the same question but stores it in `predictive_lead_scores`, whose RLS
 * (`is_lead_visible_role()`) admits broker/admin/superadmin only. An agent cannot
 * read that table under the anon key, so a card on THIS screen fed from it would
 * be empty by construction — its own file says exactly that and keeps it unwired.
 * This panel therefore uses the one predictor whose output an agent can see.
 *
 * `persisted` comes back from the action and is shown when the write was refused,
 * because a probability that looks saved and is not will silently disagree with
 * whatever the contact record shows tomorrow.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Target, Loader2, TriangleAlert, Rocket, AlertTriangle } from "lucide-react"
import { aiPredictConversion } from "@/app/actions/ai-lead-nurturing"

interface Prediction {
  conversionProbability: number
  predictedCloseDate?: string
  confidenceLevel: "low" | "medium" | "high"
  keyFactors: Array<{ factor: string; impact: "positive" | "negative" | "neutral"; weight: number }>
  riskFactors: string[]
  accelerators: string[]
  recommendation: string
}

export function ConversionForecastPanel({ contactId }: { contactId: string }) {
  const [prediction, setPrediction] = useState<Prediction | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const run = () => {
    setError(null)
    startTransition(async () => {
      const result = await aiPredictConversion({ contactId })
      if (!result.success) {
        setError((result as { error?: string }).error ?? "Could not build a forecast.")
        setPrediction(null)
        return
      }
      setPrediction((result as any).prediction as Prediction)
      setPersisted(((result as any).persisted as boolean | undefined) ?? null)
    })
  }

  const probability = prediction ? Math.max(0, Math.min(100, Math.round(prediction.conversionProbability))) : 0

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="h-4 w-4" />
            Conversion forecast
          </CardTitle>
          <CardDescription>Likelihood this relationship closes, and what moves it.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={run} disabled={isPending}>
          {isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
          {prediction ? "Re-run" : "Forecast"}
        </Button>
      </CardHeader>

      <CardContent className="space-y-3">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {!prediction && !error && !isPending && (
          <p className="text-sm text-muted-foreground">
            Reads this contact's activity and property views. This is a model's estimate, not a
            forecast the business should commit to.
          </p>
        )}

        {prediction && (
          <>
            <div>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums">{probability}%</span>
                <Badge variant="secondary" className="text-[10px] capitalize">
                  {prediction.confidenceLevel} confidence
                </Badge>
                {prediction.predictedCloseDate && (
                  <span className="text-xs text-muted-foreground">
                    Projected close {prediction.predictedCloseDate}
                  </span>
                )}
              </div>
              <Progress value={probability} className="mt-2 h-2" />
            </div>

            {persisted === false && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3 w-3" />
                Not saved to this contact — the record will not show this number.
              </p>
            )}

            {prediction.recommendation && (
              <p className="rounded-md border bg-muted/40 p-2 text-xs">{prediction.recommendation}</p>
            )}

            {prediction.keyFactors?.length > 0 && (
              <div className="space-y-1">
                {[...prediction.keyFactors]
                  .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
                  .slice(0, 5)
                  .map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span
                        className={
                          f.impact === "positive"
                            ? "text-emerald-600"
                            : f.impact === "negative"
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }
                      >
                        {f.impact === "positive" ? "▲" : f.impact === "negative" ? "▼" : "•"}
                      </span>
                      <span>{f.factor}</span>
                    </div>
                  ))}
              </div>
            )}

            {prediction.riskFactors?.length > 0 && (
              <div className="text-xs">
                <p className="flex items-center gap-1.5 font-medium">
                  <TriangleAlert className="h-3 w-3" /> Risks
                </p>
                <ul className="ml-4 list-disc text-muted-foreground">
                  {prediction.riskFactors.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}

            {prediction.accelerators?.length > 0 && (
              <div className="text-xs">
                <p className="flex items-center gap-1.5 font-medium">
                  <Rocket className="h-3 w-3" /> Accelerators
                </p>
                <ul className="ml-4 list-disc text-muted-foreground">
                  {prediction.accelerators.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
