import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Users, TrendingUp, AlertCircle, CheckCircle2 } from 'lucide-react'

interface AdoptionRadarProps {
  avgCompletion: number
  activeAgents: number
  completedAgents: number
  stalledCount: number
}

export function AdoptionRadar({
  avgCompletion,
  activeAgents,
  completedAgents,
  stalledCount,
}: AdoptionRadarProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Adoption Radar</CardTitle>
        <CardDescription>Real-time onboarding and adoption metrics</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Overall Completion */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Average Completion Rate</span>
            <span className="text-2xl font-bold">{avgCompletion}%</span>
          </div>
          <Progress value={avgCompletion} className="h-2" />
        </div>

        {/* Status Grid */}
        <div className="grid grid-cols-3 gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
              <Users className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Active</p>
              <p className="text-lg font-bold">{activeAgents}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Completed</p>
              <p className="text-lg font-bold">{completedAgents}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-100">
              <AlertCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Stalled</p>
              <p className="text-lg font-bold">{stalledCount}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
