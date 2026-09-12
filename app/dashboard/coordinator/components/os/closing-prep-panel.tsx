'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { CheckCircle2, Home } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface ClosingPrepPanelProps {
  brokerageId: string
}

export function ClosingPrepPanel({ brokerageId }: ClosingPrepPanelProps) {
  const [closings, setClosings] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    const fetchClosings = async () => {
      try {
        const { data } = await supabase
          .from('transactions')
          .select(`
            id,
            property_address,
            close_date,
            stage,
            status,
            purchase_price
          `)
          .eq('brokerage_id', brokerageId)
          // The stage is CLOSING_PREP — 'closing' is not in the CHECK, so the
          // coordinator's closing-prep queue never listed a single deal.
          .eq('stage', 'CLOSING_PREP')
          .order('close_date', { ascending: true })
          .limit(12)

        setClosings(data || [])
      } catch (error) {
        console.error('Error fetching closings:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchClosings()
  }, [brokerageId, supabase])

  const readyCount = closings.filter(c => c.status === 'ready_to_close').length
  const readiness = closings.length > 0 ? (readyCount / closings.length) * 100 : 0

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ready_to_close':
        return 'bg-green-100 text-green-800'
      case 'in_preparation':
        return 'bg-orange-100 text-orange-800'
      case 'awaiting_docs':
        return 'bg-yellow-100 text-yellow-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  const getDaysUntilClose = (closeDate: string) => {
    const now = new Date()
    const close = new Date(closeDate)
    const diff = Math.ceil((close.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    return diff
  }

  return (
    <Card className="border-l-4 border-l-indigo-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Closing Preparation</CardTitle>
            <CardDescription>Upcoming closings and readiness</CardDescription>
          </div>
          <Home className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Closing Readiness</p>
            <p className="text-sm text-muted-foreground">{Math.round(readiness)}%</p>
          </div>
          <Progress value={readiness} className="h-2" />
          <p className="text-xs text-muted-foreground">
            {readyCount} of {closings.length} closings ready
          </p>
        </div>

        <div className="space-y-2 max-h-80 overflow-y-auto">
          {loading ? (
            <div className="text-center py-6 text-muted-foreground">Loading closings...</div>
          ) : closings.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">No closings in preparation</div>
          ) : (
            closings.map(closing => {
              const daysUntil = getDaysUntilClose(closing.close_date)
              return (
                <div
                  key={closing.id}
                  className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3 flex-1">
                    <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{closing.property_address}</p>
                      <p className="text-xs text-muted-foreground">
                        Closing in {daysUntil} day{daysUntil !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  <Badge className={getStatusColor(closing.status)}>
                    {closing.status}
                  </Badge>
                </div>
              )
            })
          )}
        </div>
      </CardContent>
    </Card>
  )
}
