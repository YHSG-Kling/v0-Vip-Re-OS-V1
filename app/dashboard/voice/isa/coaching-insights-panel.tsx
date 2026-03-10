"use client"

import { useState } from "react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  Lightbulb,
  ExternalLink,
  X,
  AlertTriangle,
  TrendingUp,
  MessageSquare
} from "lucide-react"
import { useRouter } from "next/navigation"

interface CoachingInsight {
  id: string
  insight_type: string | null
  priority: string | null
  content: string | null
  dismissed: boolean
  created_at: string
  call_analysis_id: string | null
  call_analyses: {
    voice_call_id: string | null
  } | null
}

interface CoachingInsightsPanelProps {
  insights: CoachingInsight[]
  agentId: string
}

function getInsightIcon(type: string | null) {
  switch (type) {
    case "warning":
    case "objection":
      return <AlertTriangle className="h-4 w-4" />
    case "positive":
    case "success":
      return <TrendingUp className="h-4 w-4" />
    case "communication":
      return <MessageSquare className="h-4 w-4" />
    default:
      return <Lightbulb className="h-4 w-4" />
  }
}

function getPriorityBadge(priority: string | null) {
  switch (priority) {
    case "high":
      return <Badge variant="destructive">High</Badge>
    case "medium":
      return <Badge className="bg-amber-500/10 text-amber-600 border-amber-200">Medium</Badge>
    case "low":
      return <Badge variant="secondary">Low</Badge>
    default:
      return <Badge variant="outline">{priority || "Normal"}</Badge>
  }
}

function getInsightTypeBadge(type: string | null) {
  switch (type) {
    case "objection":
      return <Badge variant="outline" className="text-xs">Objection Handling</Badge>
    case "positive":
      return <Badge variant="outline" className="text-xs bg-green-50">Positive Signal</Badge>
    case "communication":
      return <Badge variant="outline" className="text-xs">Communication</Badge>
    case "follow_up":
      return <Badge variant="outline" className="text-xs">Follow Up</Badge>
    default:
      return <Badge variant="outline" className="text-xs">{type || "General"}</Badge>
  }
}

export function CoachingInsightsPanel({ insights, agentId }: CoachingInsightsPanelProps) {
  const router = useRouter()
  const [dismissing, setDismissing] = useState<string | null>(null)

  const handleDismiss = async (insightId: string) => {
    setDismissing(insightId)
    const supabase = createClient()
    
    await supabase
      .from("call_coaching_insights")
      .update({ dismissed: true })
      .eq("id", insightId)
    
    setDismissing(null)
    router.refresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lightbulb className="h-5 w-5" />
          Coaching Insights
        </CardTitle>
      </CardHeader>
      <CardContent>
        {insights.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Lightbulb className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">No new coaching insights</p>
            <p className="text-xs text-muted-foreground mt-1">
              Insights will appear after AI analyzes your calls
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {insights.map((insight) => (
              <div 
                key={insight.id} 
                className="flex items-start gap-3 p-3 rounded-lg border bg-card"
              >
                <div className="mt-0.5 text-muted-foreground">
                  {getInsightIcon(insight.insight_type)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {getInsightTypeBadge(insight.insight_type)}
                    {getPriorityBadge(insight.priority)}
                  </div>
                  <p className="text-sm">{insight.content}</p>
                  {insight.call_analyses?.voice_call_id && (
                    <Link 
                      href={`/dashboard/voice/review/${insight.call_analyses.voice_call_id}`}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-2"
                    >
                      View Full Review
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => handleDismiss(insight.id)}
                  disabled={dismissing === insight.id}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
