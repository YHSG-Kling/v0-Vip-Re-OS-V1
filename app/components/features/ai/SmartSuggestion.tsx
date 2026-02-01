"use client"

import { Sparkles, CheckCircle, Clock, TrendingUp, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface SmartSuggestionProps {
  title: string
  description: string
  confidence: number // 0-100
  automatedSteps?: string[]
  manualSteps?: string[]
  onApprove: () => void
  onDismiss?: () => void
  urgency?: "low" | "medium" | "high"
  category?: string
  estimatedTime?: string
}

export function SmartSuggestion({
  title,
  description,
  confidence,
  automatedSteps = [],
  manualSteps = [],
  onApprove,
  onDismiss,
  urgency = "medium",
  category,
  estimatedTime,
}: SmartSuggestionProps) {
  const urgencyColors = {
    low: "bg-blue-500/10 text-blue-600 border-blue-500/20",
    medium: "bg-amber-500/10 text-amber-600 border-amber-500/20",
    high: "bg-red-500/10 text-red-600 border-red-500/20",
  }

  const confidenceColor = confidence >= 80 ? "text-green-600" : confidence >= 60 ? "text-amber-600" : "text-slate-600"

  return (
    <div className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:shadow-md">
      {/* AI Indicator */}
      <div className="absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br from-indigo-500/10 to-purple-500/10 blur-2xl transition-all group-hover:scale-150" />

      <div className="relative">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1">
            <div className="mt-0.5 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 p-2 shadow-lg shadow-indigo-500/30">
              <Sparkles className="h-4 w-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-balance font-semibold text-slate-900 mb-1">{title}</h3>
              <p className="text-sm text-slate-600 text-pretty">{description}</p>
            </div>
          </div>

          {/* Confidence Badge */}
          <Badge variant="outline" className={cn("shrink-0 font-mono text-xs", confidenceColor)}>
            {confidence}% AI
          </Badge>
        </div>

        {/* Metadata */}
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          {category && (
            <Badge variant="secondary" className="gap-1">
              {category}
            </Badge>
          )}
          {estimatedTime && (
            <span className="flex items-center gap-1 text-slate-500">
              <Clock className="h-3 w-3" />
              {estimatedTime}
            </span>
          )}
          <Badge variant="outline" className={cn("gap-1", urgencyColors[urgency])}>
            <AlertCircle className="h-3 w-3" />
            {urgency} priority
          </Badge>
        </div>

        {/* Automated Steps */}
        {automatedSteps.length > 0 && (
          <div className="mb-3 rounded-lg bg-green-50 border border-green-200 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-green-700">
              <CheckCircle className="h-3.5 w-3.5" />
              Will automate ({automatedSteps.length} steps)
            </div>
            <ul className="space-y-1.5">
              {automatedSteps.map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-green-700">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-green-500" />
                  <span className="text-pretty">{step}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Manual Review Steps */}
        {manualSteps.length > 0 && (
          <div className="mb-4 rounded-lg bg-blue-50 border border-blue-200 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-blue-700">
              <TrendingUp className="h-3.5 w-3.5" />
              You'll review ({manualSteps.length} items)
            </div>
            <ul className="space-y-1.5">
              {manualSteps.map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-blue-700">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-blue-500" />
                  <span className="text-pretty">{step}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button
            onClick={onApprove}
            className="flex-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 shadow-lg shadow-indigo-500/30"
          >
            <CheckCircle className="mr-2 h-4 w-4" />
            Approve & Execute
          </Button>
          {onDismiss && (
            <Button onClick={onDismiss} variant="ghost" size="sm">
              Dismiss
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
