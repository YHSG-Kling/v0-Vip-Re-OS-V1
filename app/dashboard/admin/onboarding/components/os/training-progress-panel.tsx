import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { BookOpen } from 'lucide-react'

interface TrainingProgress {
  status: string
  score: number | null
}

interface TrainingProgressPanelProps {
  trainingProgress: TrainingProgress[]
  brokerageId: string
}

export function TrainingProgressPanel({ trainingProgress, brokerageId }: TrainingProgressPanelProps) {
  // agent_courses status CHECK: not_started|in_progress|passed|failed
  const completed = trainingProgress.filter(t => t.status === 'passed').length
  const inProgress = trainingProgress.filter(t => t.status === 'in_progress').length
  const notStarted = trainingProgress.filter(t => t.status === 'not_started').length

  const avgProgress = trainingProgress.length
    ? Math.round(trainingProgress.reduce((sum, t) => sum + (t.score || 0), 0) / trainingProgress.length)
    : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Training Progress</CardTitle>
        <CardDescription>Agent course completion metrics</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Overall Progress */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Average Training Completion</span>
            <span className="text-2xl font-bold">{avgProgress}%</span>
          </div>
          <Progress value={avgProgress} className="h-2" />
        </div>

        {/* Status Breakdown */}
        <div className="grid grid-cols-3 gap-4">
          <div className="text-center p-3 bg-blue-50 rounded-lg">
            <p className="text-2xl font-bold text-blue-600">{completed}</p>
            <p className="text-xs text-muted-foreground">Completed</p>
          </div>
          <div className="text-center p-3 bg-yellow-50 rounded-lg">
            <p className="text-2xl font-bold text-yellow-600">{inProgress}</p>
            <p className="text-xs text-muted-foreground">In Progress</p>
          </div>
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-600">{notStarted}</p>
            <p className="text-xs text-muted-foreground">Not Started</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
