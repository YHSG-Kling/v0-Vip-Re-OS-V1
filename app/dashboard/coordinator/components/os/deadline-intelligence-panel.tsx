'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Calendar, Clock, CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface DeadlineIntelligencePanelProps {
  brokerageId: string
}

export function DeadlineIntelligencePanel({ brokerageId }: DeadlineIntelligencePanelProps) {
  const [deadlines, setDeadlines] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    const fetchDeadlines = async () => {
      try {
        const { data } = await supabase
          .from('transaction_deadlines')
          .select(`
            id,
            transaction_id,
            deadline_type,
            due_date,
            status,
            assigned_to,
            priority,
            created_at
          `)
          .eq('brokerage_id', brokerageId)
          .order('due_date', { ascending: true })
          .limit(20)

        setDeadlines(data || [])
      } catch (error) {
        console.error('Error fetching deadlines:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchDeadlines()
  }, [brokerageId, supabase])

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'overdue':
        return 'bg-destructive/10 text-destructive'
      case 'due_soon':
        return 'bg-orange-100 text-orange-800'
      case 'on_track':
        return 'bg-green-100 text-green-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  const getIcon = (status: string) => {
    switch (status) {
      case 'overdue':
        return <AlertTriangle className="h-4 w-4" />
      case 'due_soon':
        return <Clock className="h-4 w-4" />
      case 'on_track':
        return <CheckCircle2 className="h-4 w-4" />
      default:
        return <Calendar className="h-4 w-4" />
    }
  }

  const overdueCount = deadlines.filter(d => d.status === 'overdue').length
  const dueSoonCount = deadlines.filter(d => d.status === 'due_soon').length

  return (
    <Card className="border-l-4 border-l-blue-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Deadline Intelligence</CardTitle>
            <CardDescription>Transaction deadline tracking and alerts</CardDescription>
          </div>
          <Calendar className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {overdueCount > 0 && (
          <Alert className="border-destructive/50 bg-destructive/5">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <AlertDescription className="text-destructive">
              {overdueCount} overdue deadline{overdueCount !== 1 ? 's' : ''}
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-2 max-h-96 overflow-y-auto">
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading deadlines...</div>
          ) : deadlines.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No deadlines found</div>
          ) : (
            deadlines.slice(0, 10).map(deadline => (
              <div
                key={deadline.id}
                className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-3 flex-1">
                  <div className={`p-2 rounded-lg ${getStatusColor(deadline.status)}`}>
                    {getIcon(deadline.status)}
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-sm">{deadline.deadline_type}</p>
                    <p className="text-xs text-muted-foreground">
                      Due: {new Date(deadline.due_date).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <Badge variant="outline">{deadline.priority}</Badge>
              </div>
            ))
          )}
        </div>

        {deadlines.length > 10 && (
          <Button variant="outline" size="sm" className="w-full">
            View All Deadlines
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
