"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { 
  Users, 
  GraduationCap, 
  AlertTriangle, 
  CheckCircle2,
  Clock,
  TrendingUp
} from "lucide-react"

interface AdoptionRadarProps {
  metrics: {
    totalAgents: number
    activeOnboarding: number
    completedThisMonth: number
    averageCompletion: number
    stuckAgents: number
    certifiedAgents: number
    avgDaysToComplete: number
    trainingCompletionRate: number
  }
}

export function AdoptionRadar({ metrics }: AdoptionRadarProps) {
  const completionColor = metrics.averageCompletion >= 75 
    ? "text-green-600" 
    : metrics.averageCompletion >= 50 
    ? "text-yellow-600" 
    : "text-red-600"

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Adoption Radar
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Active Onboarding */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-500" />
              <span className="text-2xl font-bold">{metrics.activeOnboarding}</span>
            </div>
            <p className="text-xs text-muted-foreground">In Progress</p>
            <Progress value={(metrics.activeOnboarding / Math.max(metrics.totalAgents, 1)) * 100} className="h-1" />
          </div>

          {/* Avg Completion */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <CheckCircle2 className={`h-4 w-4 ${completionColor}`} />
              <span className={`text-2xl font-bold ${completionColor}`}>
                {metrics.averageCompletion}%
              </span>
            </div>
            <p className="text-xs text-muted-foreground">Avg Completion</p>
            <Progress value={metrics.averageCompletion} className="h-1" />
          </div>

          {/* Stuck Agents */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <AlertTriangle className={`h-4 w-4 ${metrics.stuckAgents > 0 ? 'text-red-500' : 'text-green-500'}`} />
              <span className="text-2xl font-bold">{metrics.stuckAgents}</span>
            </div>
            <p className="text-xs text-muted-foreground">Need Attention</p>
            {metrics.stuckAgents > 0 && (
              <Badge variant="destructive" className="text-xs">Action Required</Badge>
            )}
          </div>

          {/* Certified */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <GraduationCap className="h-4 w-4 text-purple-500" />
              <span className="text-2xl font-bold">{metrics.certifiedAgents}</span>
            </div>
            <p className="text-xs text-muted-foreground">Certified</p>
            <Progress 
              value={(metrics.certifiedAgents / Math.max(metrics.totalAgents, 1)) * 100} 
              className="h-1" 
            />
          </div>
        </div>

        {/* Secondary Metrics */}
        <div className="mt-4 pt-4 border-t grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-lg font-semibold">{metrics.completedThisMonth}</p>
            <p className="text-xs text-muted-foreground">Completed This Month</p>
          </div>
          <div>
            <p className="text-lg font-semibold">{metrics.avgDaysToComplete}</p>
            <p className="text-xs text-muted-foreground">Avg Days to Complete</p>
          </div>
          <div>
            <p className="text-lg font-semibold">{metrics.trainingCompletionRate}%</p>
            <p className="text-xs text-muted-foreground">Training Rate</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
