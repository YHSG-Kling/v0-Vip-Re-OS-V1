"use client"

import { useEffect, useState, useTransition } from "react"
import { cn } from "@/lib/utils"
import {
  getOrGenerateStrategyRecommendation,
  type StrategyRecommendation,
} from "@/app/actions/buyer-offers"

interface StrategyAdvisorProps {
  contactId:   string
  listingId:   string | null
  brokerageId: string
  agentUserId: string
  onUse:       (rec: StrategyRecommendation) => void
  onCustomize: (rec: StrategyRecommendation) => void
  onSkip:      () => void
  onBack:      () => void
}

const STRATEGY_BADGES: Record<string, { label: string; className: string }> = {
  aggressive:   { label: "Aggressive",   className: "bg-red-100 text-red-700 border-red-200" },
  conservative: { label: "Conservative", className: "bg-blue-100 text-blue-700 border-blue-200" },
  standard:     { label: "Standard",     className: "bg-green-100 text-green-700 border-green-200" },
}

export function StrategyAdvisor({
  contactId, listingId, brokerageId, agentUserId,
  onUse, onCustomize, onSkip, onBack,
}: StrategyAdvisorProps) {
  const [rec, setRec]           = useState<StrategyRecommendation | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [isPending, startTrans] = useTransition()

  useEffect(() => {
    startTrans(async () => {
      const result = await getOrGenerateStrategyRecommendation(
        contactId, listingId, brokerageId, agentUserId
      )
      if (result.success && result.recommendation) {
        setRec(result.recommendation)
      } else {
        setError(result.error ?? "Failed to generate recommendation")
      }
    })
  }, [contactId, listingId, brokerageId, agentUserId])

  if (isPending) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <p className="text-sm text-muted-foreground">Analyzing market conditions...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-5 space-y-3">
        <p className="text-sm font-medium text-destructive">Could not generate recommendation</p>
        <p className="text-xs text-muted-foreground">{error}</p>
        <div className="flex gap-2 pt-1">
          <button
            onClick={onSkip}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
          >
            Skip — Fill Manually
          </button>
          <button onClick={onBack} className="text-sm text-muted-foreground hover:underline">
            Back
          </button>
        </div>
      </div>
    )
  }

  if (!rec) return null

  const badge = STRATEGY_BADGES[rec.strategy_type] ?? STRATEGY_BADGES.standard
  const c = rec.recommended_contingencies

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border bg-muted/30 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold">AI Strategy Recommendation</p>
            <p className="text-xs text-muted-foreground">Based on market conditions &amp; buyer profile</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={cn(
            "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
            badge.className
          )}>
            {badge.label}
          </span>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Success probability</p>
            <p className="text-sm font-semibold text-primary">
              {Math.round(rec.success_probability * 100)}%
            </p>
          </div>
        </div>
      </div>

      {/* Narrative */}
      <div className="px-5 py-4 text-sm text-muted-foreground leading-relaxed border-b border-border">
        {rec.ai_narrative}
      </div>

      {/* Suggestions grid */}
      <div className="px-5 py-4 border-b border-border">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Suggested Terms</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Offer Price</p>
            <p className="font-semibold">${rec.recommended_price.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Earnest Money</p>
            <p className="font-semibold">${rec.recommended_earnest.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Financing Contingency</p>
            <p className="font-medium">
              {c.financing ? `Yes — ${c.financing_days} days` : "Waived"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Inspection Contingency</p>
            <p className="font-medium">
              {c.inspection ? `Yes — ${c.inspection_days} days` : "Waived"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Appraisal Contingency</p>
            <p className="font-medium">
              {c.appraisal ? `Yes — ${c.appraisal_days} days` : "Waived"}
            </p>
          </div>
          {rec.comparable_context && (
            <div className="col-span-2">
              <p className="text-xs text-muted-foreground">Market Context</p>
              <p className="font-medium">{rec.comparable_context}</p>
            </div>
          )}
        </div>
      </div>

      {/* Risk factors */}
      {rec.risk_factors.length > 0 && (
        <div className="px-5 py-3 border-b border-border">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Risk Factors</p>
          <div className="flex flex-wrap gap-1.5">
            {rec.risk_factors.map((r, i) => (
              <span
                key={i}
                className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs text-amber-700"
              >
                {r}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="px-5 py-4 flex items-center gap-3 flex-wrap">
        <button
          onClick={() => onUse(rec)}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Use This Strategy
        </button>
        <button
          onClick={() => onCustomize(rec)}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
        >
          Customize
        </button>
        <button
          onClick={onSkip}
          className="text-sm text-muted-foreground hover:underline"
        >
          Skip Advice
        </button>
        <button
          onClick={onBack}
          className="ml-auto text-xs text-muted-foreground hover:underline"
        >
          Back to form source
        </button>
      </div>
    </div>
  )
}
