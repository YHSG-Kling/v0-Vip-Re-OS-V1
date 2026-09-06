'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Flag, CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface MilestoneOperationsPanelProps {
  brokerageId: string
}

export function MilestoneOperationsPanel({ brokerageId }: MilestoneOperationsPanelProps) {
  const [milestones, setMilestones] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    const fetchMilestones = async () => {
      try {
        const { data } = await supabase
          .from('transaction_milestones')
          .select(`
            id,
            transaction_id,
            milestone_name,
            target_date,
            status
          `)
          .eq('brokerage_id', brokerageId)
          .order('target_date', { ascending: true })
          .limit(20)

        setMilestones(data || [])
      } catch (error) {
        console.error('Error fetching milestones:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchMilestones()
  }, [brokerageId, supabase])

  const completedCount = milestones.filter(m => m.status === 'completed').length
  const completionRate = milestones.length > 0 ? (completedCount / milestones.length) * 100 : 0

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800'
      case 'pending':
        return 'bg-gray-100 text-gray-800'
      case 'overdue':
        return 'bg-red-100 text-red-800'
      case 'cancelled':
        return 'bg-slate-100 text-slate-600'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  return (
    <Card className="border-l-4 border-l-green-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Milestone Operations</CardTitle>
            <CardDescription>Transaction milestone tracking</CardDescription>
          </div>
          <Flag className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Overall Progress</p>
            <p className="text-sm text-muted-foreground">{Math.round(completionRate)}%</p>
          </div>
          <Progress value={completionRate} className="h-2" />
          <p className="text-xs text-muted-foreground">
            {completedCount} of {milestones.length} milestones completed
          </p>
        </div>

        <div className="space-y-2 max-h-80 overflow-y-auto">
          {loading ? (
            <div className="text-center py-6 text-muted-foreground">Loading milestones...</div>
          ) : milestones.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">No milestones found</div>
          ) : (
            milestones.map(milestone => (
              <div
                key={milestone.id}
                className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-3 flex-1">
                  {milestone.status === 'completed' ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  ) : (
                    <Flag className="h-5 w-5 text-muted-foreground" />
                  )}
                  <div className="flex-1">
                    <p className="font-medium text-sm">{milestone.milestone_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(milestone.target_date).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <Badge className={getStatusColor(milestone.status)}>
                  {milestone.status}
                </Badge>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
