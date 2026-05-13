"use client"

import { useState, useEffect }  from "react"
import { Badge }                 from "@/components/ui/badge"
import { Button }                from "@/components/ui/button"
import { cn }                    from "@/lib/utils"
import { getBuyerCoaching }      from "@/app/actions/buyer-coaching"

interface BuyerCoachingCardProps {
  contactId:   string
  brokerageId: string
}

const PERSONA_COLORS: Record<string, string> = {
  motivated:  "bg-green-100 text-green-800 border-green-200",
  skeptical:  "bg-orange-100 text-orange-800 border-orange-200",
  emotional:  "bg-purple-100 text-purple-800 border-purple-200",
  investor:   "bg-blue-100 text-blue-800 border-blue-200",
  indecisive: "bg-yellow-100 text-yellow-800 border-yellow-200",
  analytical: "bg-slate-100 text-slate-800 border-slate-200",
}

export function BuyerCoachingCard({ contactId, brokerageId }: BuyerCoachingCardProps) {
  const [coaching, setCoaching]       = useState<any>(null)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)
  const [collapsed, setCollapsed]     = useState(false)
  const [dismissed, setDismissed]     = useState(false)
  const [objExpanded, setObjExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const result = await getBuyerCoaching({ contactId, brokerageId })
      if (cancelled) return
      if (result.success) {
        setCoaching(result.coaching)
        setError(null)
      } else {
        setError(result.error ?? "Failed to load coaching")
      }
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [contactId, brokerageId])

  if (dismissed) return null

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 animate-pulse space-y-3">
        <div className="h-4 w-1/2 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-4/5 rounded bg-muted" />
        <div className="flex gap-2">
          <div className="h-3 w-24 rounded bg-muted" />
          <div className="h-3 w-20 rounded bg-muted" />
        </div>
      </div>
    )
  }

  if (error || !coaching) {
    return null
  }

  const personaColor = coaching.persona
    ? PERSONA_COLORS[coaching.persona] ?? "bg-muted text-muted-foreground"
    : "bg-muted text-muted-foreground"

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-sm leading-tight truncate">{coaching.coaching_headline}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {coaching.persona && (
            <Badge className={cn("text-xs border", personaColor)}>
              {coaching.persona}
            </Badge>
          )}
          <button
            onClick={() => setCollapsed(c => !c)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label={collapsed ? "Expand" : "Collapse"}
          >
            <svg viewBox="0 0 16 16" className={cn("w-4 h-4 transition-transform", collapsed && "rotate-180")} fill="none">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="px-5 py-4 space-y-4">
          {/* Body */}
          <p className="text-sm text-foreground leading-relaxed">{coaching.coaching_body}</p>

          {/* Talking points */}
          {coaching.suggested_talking_points?.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Talking Points</p>
              <div className="flex flex-wrap gap-2">
                {coaching.suggested_talking_points.map((pt: string, i: number) => (
                  <span key={i} className="text-xs rounded-md border border-border bg-muted/50 px-2.5 py-1 leading-tight">
                    {pt}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Common objections (expandable) */}
          {coaching.common_objections?.length > 0 && (
            <div>
              <button
                onClick={() => setObjExpanded(o => !o)}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg viewBox="0 0 12 12" className={cn("w-3 h-3 transition-transform", objExpanded && "rotate-90")} fill="none">
                  <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Common objections ({coaching.common_objections.length})
              </button>
              {objExpanded && (
                <div className="mt-2 space-y-2">
                  {coaching.common_objections.map((obj: any, i: number) => (
                    <div key={i} className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1">
                      <p className="text-xs font-medium text-foreground">&ldquo;{obj.objection}&rdquo;</p>
                      <p className="text-xs text-muted-foreground">{obj.response}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Signals grid */}
          <div className="grid grid-cols-2 gap-3">
            {coaching.success_signals?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Success signals</p>
                <ul className="space-y-0.5">
                  {coaching.success_signals.map((s: string, i: number) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-foreground">
                      <svg viewBox="0 0 12 12" className="w-3 h-3 mt-0.5 flex-shrink-0 text-green-600" fill="none">
                        <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {coaching.risk_signals?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Risk signals</p>
                <ul className="space-y-0.5">
                  {coaching.risk_signals.map((s: string, i: number) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-foreground">
                      <svg viewBox="0 0 12 12" className="w-3 h-3 mt-0.5 flex-shrink-0 text-amber-500" fill="none">
                        <path d="M6 2v4M6 9v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Footer */}
          {coaching.next_action_prompt && (
            <div className="flex items-center justify-between pt-2 border-t border-border gap-3">
              <p className="text-xs text-muted-foreground leading-tight flex-1">
                <span className="font-medium text-foreground">Next: </span>
                {coaching.next_action_prompt}
              </p>
              <Button size="sm" variant="outline" onClick={() => setDismissed(true)}>Got it</Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
