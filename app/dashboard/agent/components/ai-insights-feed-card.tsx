"use client"

/**
 * AiInsightsFeedCard — surfaces the latest rows from the ai_insights table
 * (written by app/actions/ai-predictions.ts: risk flags, hidden opportunities,
 * learned preferences, churn/equity alerts).
 *
 * Presentational — the agent dashboard page loads the rows alongside its
 * sibling queries and passes them in. Writers store confidence inside the
 * estimated_impact jsonb payload (confidence / confidenceScore / probability),
 * so we extract it from there when present.
 */

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Lightbulb, ArrowUpRight } from "lucide-react"

export interface AiInsightRow {
  id: string
  insight_type: string
  insight_title: string
  insight_description: string | null
  priority: string | null
  estimated_impact: Record<string, any> | null
  created_at: string
  /** jsonb text[] written by every ai-predictions insert — "what to do next". */
  actionable_steps: string[] | null
  /** CHECK vocabulary on ai_insights.entity_type is written as one of
   *  lead | contact | transaction | property (see insightEntityHref). */
  entity_type: string | null
  /** uuid of the entity; NULL for the arbitrage "property" rows, whose subject
   *  is an MLS string kept in estimated_impact.mls_id (ai-predictions.ts:2812). */
  entity_id: string | null
}

/**
 * The entity_type vocabulary the eleven ai_insights writers in
 * app/actions/ai-predictions.ts actually produce, mapped to the ONE route that
 * serves each:
 *
 *   transaction → /dashboard/transactions/[id]   (app/dashboard/transactions/[id])
 *   contact     → /crm/contacts/[contactId]      (app/crm/contacts/[contactId];
 *                 /dashboard/buyers/[contactId] is a redirect onto it)
 *   lead        → NO LINK. Leads belong to the brokerage (CLAUDE.md §5) and the
 *                 tree has no lead detail route: the only `/dashboard/leads/${id}`
 *                 href in the repo (analytics/source/[sourceId]/source-detail-client.tsx)
 *                 points at a directory that does not exist. A link that 404s is
 *                 worse than none, so a lead insight renders its steps unlinked.
 *   property    → NO LINK. entity_id is NULL by design (MLS id, not a uuid).
 *
 * Anything else (a future vocabulary entry) gets no link rather than a guess.
 */
export function insightEntityHref(entityType: string | null, entityId: string | null): string | null {
  if (!entityId) return null
  switch (entityType) {
    case "transaction": return `/dashboard/transactions/${entityId}`
    case "contact":     return `/crm/contacts/${entityId}`
    default:            return null
  }
}

/** actionable_steps is jsonb; writers pass string[] but a step can arrive as a
 *  non-string (one writer maps `t.script`, which the model may omit). Keep only
 *  the non-empty strings so a `null` step never renders as the word "null". */
function cleanSteps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim())
}

const TYPE_BADGE: Record<string, string> = {
  risk: "bg-red-100 text-red-700 border-red-200",
  opportunity: "bg-emerald-100 text-emerald-700 border-emerald-200",
  learned_preferences: "bg-violet-100 text-violet-700 border-violet-200",
}

function extractConfidence(impact: Record<string, any> | null): number | null {
  const raw = impact?.confidence ?? impact?.confidenceScore ?? impact?.probability
  const num = typeof raw === "string" ? parseFloat(raw) : raw
  if (typeof num !== "number" || isNaN(num)) return null
  // Writers store 0-1 fractions; tolerate 0-100 values too
  return num <= 1 ? Math.round(num * 100) : Math.round(num)
}

export function AiInsightsFeedCard({ insights }: { insights: AiInsightRow[] }) {
  if (insights.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-amber-500" />
          AI Insights
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {insights.map((insight) => {
          const confidence = extractConfidence(insight.estimated_impact)
          const steps = cleanSteps(insight.actionable_steps).slice(0, 3)
          const href = insightEntityHref(insight.entity_type, insight.entity_id)
          return (
            <div key={insight.id} className="flex items-start gap-3 border-b last:border-b-0 pb-3 last:pb-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    variant="outline"
                    className={`text-[10px] capitalize ${TYPE_BADGE[insight.insight_type] ?? "bg-blue-100 text-blue-700 border-blue-200"}`}
                  >
                    {insight.insight_type.replace(/_/g, " ")}
                  </Badge>
                  <p className="text-sm font-medium truncate">{insight.insight_title}</p>
                </div>
                {insight.insight_description && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {insight.insight_description}
                  </p>
                )}
                {steps.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {steps.map((step, i) => (
                      <li key={i} className="text-xs text-foreground/90 flex gap-1.5">
                        <span className="text-muted-foreground shrink-0">→</span>
                        <span className="line-clamp-2">{step}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {href && (
                  <Link
                    href={href}
                    className="inline-flex items-center gap-0.5 mt-1.5 text-xs text-primary hover:underline"
                  >
                    Open {insight.entity_type}
                    <ArrowUpRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
              <div className="shrink-0 text-right">
                {confidence !== null && (
                  <p className="text-xs font-semibold text-foreground">{confidence}%</p>
                )}
                <p className="text-[10px] text-muted-foreground">
                  {new Date(insight.created_at).toLocaleDateString([], { month: "short", day: "numeric" })}
                </p>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
