import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { TrendingUp } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

interface RecentOnboarding {
  id: string
  status: string
  completion_percentage: number
  created_at: string
}

interface AdoptionHealthPanelProps {
  recentOnboardings: RecentOnboarding[]
  avgCompletion: number
}

export function AdoptionHealthPanel({ recentOnboardings, avgCompletion }: AdoptionHealthPanelProps) {
  const isHealthy = avgCompletion >= 70

  return (
    <Card>
      <CardHeader>
        <CardTitle>Adoption Health</CardTitle>
        <CardDescription>Overall platform adoption status</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Health Status */}
        <div className={`p-4 rounded-lg ${isHealthy ? 'bg-green-50' : 'bg-yellow-50'}`}>
          <div className="flex items-center gap-2">
            <TrendingUp className={`h-5 w-5 ${isHealthy ? 'text-green-600' : 'text-yellow-600'}`} />
            <div>
              <p className="font-medium">{isHealthy ? 'On Track' : 'Needs Attention'}</p>
              <p className="text-sm text-muted-foreground">
                {isHealthy ? 'Adoption metrics are excellent' : 'Some agents need support'}
              </p>
            </div>
          </div>
        </div>

        {/* Recent Activity */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Recent Activity</p>
          {recentOnboardings.slice(0, 5).map(onboarding => (
            <div key={onboarding.id} className="flex items-center justify-between text-sm p-2 bg-gray-50 rounded">
              <div>
                <p className="font-medium">{onboarding.status}</p>
                <p className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(onboarding.created_at), { addSuffix: true })}</p>
              </div>
              <p className="text-xs font-medium">{onboarding.completion_percentage}%</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
