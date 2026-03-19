"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import {
  TrendingUp,
  AlertTriangle,
  Eye,
  ArrowRight,
  Target,
  Clock,
  CheckCircle2,
} from "lucide-react"
import { acknowledgePattern } from "@/app/actions/pattern-actions"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

interface Pattern {
  id: string
  patternName: string
  patternSlug: string
  entityType: string
  entityId: string
  entityName: string
  confidence: number
  status: "active" | "acknowledged" | "dismissed"
  recommendedAction: string
  predictedEvent?: string
  predictedWithinDays?: number
  probability?: number
}

interface BehaviorPatternsPanelProps {
  patterns: Pattern[]
  onPatternAction?: (patternId: string, action: string) => void
}

export function BehaviorPatternsPanel({
  patterns,
  onPatternAction,
}: BehaviorPatternsPanelProps) {
  const router = useRouter()
  const activePatterns = patterns.filter(p => p.status === "active")
  const highConfidence = activePatterns.filter(p => p.confidence >= 0.75)

  const handleAcknowledge = async (patternId: string) => {
    try {
      await acknowledgePattern(patternId)
      toast.success("Pattern acknowledged")
      router.refresh()
    } catch (error) {
      toast.error("Failed to acknowledge pattern")
    }
  }

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.8) return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
    if (confidence >= 0.6) return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
    return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400"
  }

  const getEntityLink = (entityType: string, entityId: string) => {
    switch (entityType) {
      case "contact": return `/dashboard/contacts/${entityId}`
      case "listing": return `/dashboard/listings/${entityId}`
      case "transaction": return `/dashboard/transactions/${entityId}`
      default: return "#"
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4 text-primary" />
            Behavior Patterns
          </CardTitle>
          {highConfidence.length > 0 && (
            <Badge variant="destructive" className="text-xs">
              {highConfidence.length} high priority
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {activePatterns.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-green-500" />
            No active patterns detected
          </div>
        ) : (
          <>
            {activePatterns.slice(0, 4).map((pattern) => (
              <div
                key={pattern.id}
                className="rounded-lg border p-3 space-y-2"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{pattern.patternName}</span>
                      <Badge className={`text-xs ${getConfidenceColor(pattern.confidence)}`}>
                        {Math.round(pattern.confidence * 100)}%
                      </Badge>
                    </div>
                    <Link 
                      href={getEntityLink(pattern.entityType, pattern.entityId)}
                      className="text-xs text-primary hover:underline"
                    >
                      {pattern.entityName || `${pattern.entityType} ${pattern.entityId.slice(0, 8)}`}
                    </Link>
                  </div>
                </div>

                {pattern.predictedEvent && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Target className="h-3 w-3" />
                    <span>{pattern.predictedEvent}</span>
                    {pattern.predictedWithinDays && (
                      <>
                        <Clock className="h-3 w-3 ml-2" />
                        <span>within {pattern.predictedWithinDays}d</span>
                      </>
                    )}
                  </div>
                )}

                <p className="text-xs text-muted-foreground line-clamp-2">
                  {pattern.recommendedAction}
                </p>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleAcknowledge(pattern.id)}
                  >
                    <Eye className="h-3 w-3 mr-1" />
                    Acknowledge
                  </Button>
                  <Link href={getEntityLink(pattern.entityType, pattern.entityId)}>
                    <Button variant="ghost" size="sm" className="h-7 text-xs">
                      Investigate
                    </Button>
                  </Link>
                </div>
              </div>
            ))}

            {activePatterns.length > 4 && (
              <p className="text-center text-xs text-muted-foreground">
                +{activePatterns.length - 4} more patterns
              </p>
            )}
          </>
        )}

        <Link href="/dashboard/patterns">
          <Button variant="outline" size="sm" className="w-full gap-2">
            View All Patterns
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
