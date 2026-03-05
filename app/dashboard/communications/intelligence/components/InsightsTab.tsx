"use client"

import { Badge } from "@/components/ui/badge"

interface InsightRecord {
  id: string
  conversation_id: string            // → conversations.id
  contact_name: string
  contact_email: string | null
  agent_name: string
  overall_sentiment: string
  health_score: number               // 0-1
  top_topics: string[]
  key_questions: string[]
  unanswered_questions_count: number
  escalation_recommended: boolean
  next_best_action: string | null
  updated_at: string
}

interface InsightsTabProps {
  insights: InsightRecord[]
}

function sentimentColor(s: string) {
  if (s === "positive") return "text-green-600"
  if (s === "negative") return "text-red-600"
  return "text-muted-foreground"
}

export default function InsightsTab({ insights }: InsightsTabProps) {
  if (insights.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground text-sm">
        No conversation insights available.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {insights.map(row => {
        const pct = Math.round(row.health_score * 100)
        return (
          <div key={row.id} className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-foreground">{row.contact_name}</p>
                {row.contact_email && (
                  <p className="text-xs text-muted-foreground">{row.contact_email}</p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs font-medium capitalize ${sentimentColor(row.overall_sentiment)}`}>
                  {row.overall_sentiment}
                </span>
                <span className="text-xs text-muted-foreground">Health: <strong>{pct}%</strong></span>
                {row.escalation_recommended && (
                  <Badge className="bg-red-100 text-red-700 border-0 text-xs">Escalate</Badge>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {row.top_topics?.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Topics</p>
                  <div className="flex flex-wrap gap-1">
                    {row.top_topics.map(t => (
                      <span key={t} className="text-xs bg-secondary text-secondary-foreground px-2 py-0.5 rounded-full capitalize">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {row.key_questions?.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Key Questions
                    {row.unanswered_questions_count > 0 && (
                      <span className="ml-1 text-yellow-600">({row.unanswered_questions_count} unanswered)</span>
                    )}
                  </p>
                  <ul className="space-y-0.5">
                    {row.key_questions.slice(0, 3).map((q, i) => (
                      <li key={i} className="text-xs text-muted-foreground truncate">{q}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {row.next_best_action && (
              <div className="rounded-md bg-primary/5 border border-primary/10 px-3 py-2">
                <p className="text-xs font-medium text-primary">Next Best Action</p>
                <p className="text-xs text-foreground mt-0.5">{row.next_best_action}</p>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Agent: {row.agent_name} · Updated {new Date(row.updated_at).toLocaleDateString()}
            </p>
          </div>
        )
      })}
    </div>
  )
}
