"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Brain,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Lightbulb,
  MessageSquare,
  Users,
} from "lucide-react"

interface RetrainingSignal {
  id: string
  signalType: "failed_objection" | "low_performing_path" | "high_performing_branch" | "coaching_insight"
  title: string
  description: string
  frequency: number
  impactScore: number
  exampleConversationId?: string
  suggestedImprovement?: string
  createdAt: string
}

interface RetrainingSignalsPanelProps {
  signals: RetrainingSignal[]
}

const signalTypeConfig: Record<
  RetrainingSignal["signalType"],
  { label: string; icon: typeof Brain; color: string; bgColor: string }
> = {
  failed_objection: {
    label: "Failed Objection",
    icon: AlertTriangle,
    color: "text-red-600",
    bgColor: "bg-red-50",
  },
  low_performing_path: {
    label: "Low-Performing Path",
    icon: TrendingDown,
    color: "text-amber-600",
    bgColor: "bg-amber-50",
  },
  high_performing_branch: {
    label: "High-Performing Branch",
    icon: TrendingUp,
    color: "text-green-600",
    bgColor: "bg-green-50",
  },
  coaching_insight: {
    label: "Coaching Insight",
    icon: Lightbulb,
    color: "text-blue-600",
    bgColor: "bg-blue-50",
  },
}

function getImpactBadge(score: number) {
  if (score >= 80) {
    return <Badge className="bg-red-100 text-red-700 text-[10px]">High Impact</Badge>
  }
  if (score >= 50) {
    return <Badge className="bg-amber-100 text-amber-700 text-[10px]">Medium Impact</Badge>
  }
  return <Badge variant="outline" className="text-[10px]">Low Impact</Badge>
}

export function RetrainingSignalsPanel({ signals }: RetrainingSignalsPanelProps) {
  const failedObjections = signals.filter((s) => s.signalType === "failed_objection")
  const lowPerforming = signals.filter((s) => s.signalType === "low_performing_path")
  const highPerforming = signals.filter((s) => s.signalType === "high_performing_branch")
  const coachingInsights = signals.filter((s) => s.signalType === "coaching_insight")

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Brain className="h-4 w-4 text-purple-600" />
            Retraining Signals
          </CardTitle>
          <Badge variant="secondary" className="text-xs">
            {signals.length} signals
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {signals.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Brain className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">No retraining signals yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              AI improvement signals will appear as conversations are analyzed
            </p>
          </div>
        ) : (
          <>
            {/* Summary Stats */}
            <div className="grid grid-cols-4 gap-2 mb-3 pb-3 border-b">
              {[
                {
                  label: "Failed Objections",
                  count: failedObjections.length,
                  icon: AlertTriangle,
                  color: "text-red-600",
                  bgColor: "bg-red-50",
                },
                {
                  label: "Low Performers",
                  count: lowPerforming.length,
                  icon: TrendingDown,
                  color: "text-amber-600",
                  bgColor: "bg-amber-50",
                },
                {
                  label: "High Performers",
                  count: highPerforming.length,
                  icon: TrendingUp,
                  color: "text-green-600",
                  bgColor: "bg-green-50",
                },
                {
                  label: "Coaching Tips",
                  count: coachingInsights.length,
                  icon: Lightbulb,
                  color: "text-blue-600",
                  bgColor: "bg-blue-50",
                },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className={`${stat.bgColor} rounded-md p-2 text-center`}
                >
                  <stat.icon className={`h-4 w-4 ${stat.color} mx-auto mb-0.5`} />
                  <p className={`text-lg font-bold ${stat.color}`}>{stat.count}</p>
                  <p className="text-[9px] text-muted-foreground">{stat.label}</p>
                </div>
              ))}
            </div>

            {/* Signal List */}
            <ScrollArea className="h-[220px]">
              <div className="space-y-2 pr-2">
                {signals.map((signal) => {
                  const config = signalTypeConfig[signal.signalType]
                  return (
                    <div
                      key={signal.id}
                      className={`${config.bgColor} border rounded-lg p-2.5`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2">
                          <config.icon className={`h-4 w-4 ${config.color} mt-0.5 shrink-0`} />
                          <div>
                            <p className="text-sm font-medium">{signal.title}</p>
                            <Badge variant="outline" className="text-[10px] mt-0.5">
                              {config.label}
                            </Badge>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          {getImpactBadge(signal.impactScore)}
                          <span className="text-[10px] text-muted-foreground">
                            {signal.frequency}x seen
                          </span>
                        </div>
                      </div>

                      <p className="text-xs text-muted-foreground mt-2 pl-6">
                        {signal.description}
                      </p>

                      {signal.suggestedImprovement && (
                        <div className="mt-2 pl-6 pt-2 border-t">
                          <div className="flex items-start gap-1.5">
                            <Lightbulb className="h-3 w-3 text-indigo-600 mt-0.5 shrink-0" />
                            <p className="text-xs text-indigo-700">
                              <span className="font-medium">Suggestion:</span>{" "}
                              {signal.suggestedImprovement}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </>
        )}
      </CardContent>
    </Card>
  )
}
