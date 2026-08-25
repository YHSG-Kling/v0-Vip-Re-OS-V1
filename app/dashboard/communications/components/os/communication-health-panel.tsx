"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { 
  Activity, 
  TrendingUp, 
  TrendingDown, 
  Minus,
  AlertTriangle,
  CheckCircle,
  Clock,
  ArrowRight
} from "lucide-react"

interface CommunicationHealthPanelProps {
  contactId: string
  contactName: string
  overallHealth: "excellent" | "good" | "fair" | "poor" | "critical"
  healthScore: number
  engagementLevel: "highly_engaged" | "engaged" | "passive" | "disengaged" | "at_risk"
  sentimentTrend: "improving" | "stable" | "declining"
  communicationBalance: string
  responsiveness: string
  keyInsights: string[]
  riskFactors: string[]
  recommendations: string[]
  suggestedNextOutreach?: {
    timing: string
    channel: string
    topic: string
  }
  onViewFullAnalysis?: () => void
  onActOnRecommendation?: (recommendation: string) => void
}

export function CommunicationHealthPanel({
  contactId,
  contactName,
  overallHealth,
  healthScore,
  engagementLevel,
  sentimentTrend,
  communicationBalance,
  responsiveness,
  keyInsights,
  riskFactors,
  recommendations,
  suggestedNextOutreach,
  onViewFullAnalysis,
  onActOnRecommendation,
}: CommunicationHealthPanelProps) {
  const getHealthColor = (health: string) => {
    switch (health) {
      case "excellent": return "text-green-600"
      case "good": return "text-green-500"
      case "fair": return "text-amber-500"
      case "poor": return "text-orange-500"
      case "critical": return "text-destructive"
      default: return "text-muted-foreground"
    }
  }

  const getHealthBadgeVariant = (health: string) => {
    switch (health) {
      case "excellent":
      case "good": return "default"
      case "fair": return "secondary"
      case "poor":
      case "critical": return "destructive"
      default: return "outline"
    }
  }

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case "improving": return <TrendingUp className="h-4 w-4 text-green-600" />
      case "declining": return <TrendingDown className="h-4 w-4 text-destructive" />
      default: return <Minus className="h-4 w-4 text-muted-foreground" />
    }
  }

  const getProgressColor = (score: number) => {
    if (score >= 70) return "bg-green-500"
    if (score >= 50) return "bg-amber-500"
    return "bg-destructive"
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Communication Health
            </CardTitle>
            <CardDescription>{contactName}</CardDescription>
          </div>
          <Badge variant={getHealthBadgeVariant(overallHealth)}>
            {overallHealth.charAt(0).toUpperCase() + overallHealth.slice(1)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Health Score */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Health Score</span>
            <div className="flex items-center gap-2">
              <span className={`text-2xl font-bold ${getHealthColor(overallHealth)}`}>
                {healthScore}
              </span>
              {getTrendIcon(sentimentTrend)}
            </div>
          </div>
          <Progress value={healthScore} className="h-2" />
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-2 bg-muted/30 rounded-lg">
            <div className="text-xs text-muted-foreground mb-1">Engagement</div>
            <div className="font-medium text-sm capitalize">
              {engagementLevel.replace("_", " ")}
            </div>
          </div>
          <div className="p-2 bg-muted/30 rounded-lg">
            <div className="text-xs text-muted-foreground mb-1">Balance</div>
            <div className="font-medium text-sm">{communicationBalance}</div>
          </div>
        </div>

        {/* Risk Factors */}
        {riskFactors.length > 0 && (
          <div className="p-3 bg-destructive/10 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <span className="text-sm font-medium">Risk Factors</span>
            </div>
            <ul className="text-sm text-muted-foreground space-y-1">
              {riskFactors.slice(0, 3).map((risk, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-destructive">-</span>
                  {risk}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Key Insights */}
        {keyInsights.length > 0 && (
          <div className="p-3 bg-muted/30 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <span className="text-sm font-medium">Key Insights</span>
            </div>
            <ul className="text-sm text-muted-foreground space-y-1">
              {keyInsights.slice(0, 3).map((insight, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-green-600">+</span>
                  {insight}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Suggested Next Outreach */}
        {suggestedNextOutreach && (
          <div className="p-3 bg-primary/10 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Suggested Next Outreach</span>
            </div>
            <div className="text-sm space-y-1">
              <div><span className="text-muted-foreground">When:</span> {suggestedNextOutreach.timing}</div>
              <div><span className="text-muted-foreground">Channel:</span> {suggestedNextOutreach.channel}</div>
              <div><span className="text-muted-foreground">Topic:</span> {suggestedNextOutreach.topic}</div>
            </div>
          </div>
        )}

        {/* Recommendations */}
        {recommendations.length > 0 && (
          <div>
            <div className="text-sm font-medium mb-2">Recommendations</div>
            <div className="space-y-2">
              {recommendations.slice(0, 2).map((rec, idx) => (
                <Button
                  key={idx}
                  variant="outline"
                  size="sm"
                  className="w-full justify-between text-left h-auto py-2"
                  onClick={() => onActOnRecommendation?.(rec)}
                >
                  <span className="truncate">{rec}</span>
                  <ArrowRight className="h-4 w-4 ml-2 flex-shrink-0" />
                </Button>
              ))}
            </div>
          </div>
        )}

        {onViewFullAnalysis && (
          <Button variant="ghost" size="sm" className="w-full" onClick={onViewFullAnalysis}>
            View Full Analysis
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
