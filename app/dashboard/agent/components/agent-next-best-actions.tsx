"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Target, CheckCircle2 } from "lucide-react"
import { ActionPlanCard } from "@/app/components/shared/ActionPlanCard"

interface AgentNextBestActionsProps {
  briefingActions: Array<{ priority: 'high' | 'medium' | 'low'; action: string; context?: string }>
  dealsAtRisk: Array<{ transaction_id: string; address: string; reason?: string }>
  upcomingShowings: Array<{
    id: string
    scheduled_at: string
    listing: { address: string } | null
    contact: { first_name: string; last_name: string } | null
  }>
  actionPlans?: Array<{ id: string; title: string; description?: string; contact_id?: string | null }>
}

export function AgentNextBestActions({
  briefingActions,
  dealsAtRisk,
  upcomingShowings,
  actionPlans
}: AgentNextBestActionsProps) {
  const highPriorityActions = briefingActions.filter(a => a.priority === 'high')
  const otherActions = briefingActions.filter(a => a.priority !== 'high')

  // Filter showings to next 48 hours
  const now = new Date()
  const in48Hours = new Date(now.getTime() + 48 * 60 * 60 * 1000)
  const upcomingFiltered = upcomingShowings.filter(s => {
    const scheduled = new Date(s.scheduled_at)
    return scheduled >= now && scheduled <= in48Hours
  })

  const hasUrgent = dealsAtRisk.length > 0
  const hasToday = upcomingFiltered.length > 0 || highPriorityActions.length > 0
  const hasRecommendations = otherActions.length > 0
  const hasPlans = actionPlans && actionPlans.length > 0
  const isEmpty = !hasUrgent && !hasToday && !hasRecommendations && !hasPlans

  if (isEmpty) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" />
            Next Best Actions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-3" />
            <p className="text-foreground font-medium">Your pipeline is clear. Great work today.</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          Next Best Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* URGENT */}
        {hasUrgent && (
          <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 border-l-4 border-l-red-500 rounded-lg p-3">
            <p className="text-xs font-semibold text-red-700 dark:text-red-400 uppercase mb-2">Urgent</p>
            {dealsAtRisk.map((deal) => (
              <div key={deal.transaction_id} className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm font-medium">{deal.address}</p>
                  {deal.reason && <p className="text-xs text-muted-foreground">{deal.reason}</p>}
                </div>
                <Link href={`/dashboard/transactions/${deal.transaction_id}`} className="text-xs text-primary hover:underline">
                  Open Deal
                </Link>
              </div>
            ))}
          </div>
        )}

        {/* TODAY */}
        {hasToday && (
          <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 border-l-4 border-l-amber-500 rounded-lg p-3">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase mb-2">Today</p>
            {upcomingFiltered.map((showing) => (
              <div key={showing.id} className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm font-medium">{showing.listing?.address || 'Showing'}</p>
                  <p className="text-xs text-muted-foreground">
                    {showing.contact ? `${showing.contact.first_name} ${showing.contact.last_name}` : 'Client'} ·{' '}
                    {new Date(showing.scheduled_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </p>
                </div>
                <Link href="/dashboard/listings" className="text-xs text-primary hover:underline">
                  View
                </Link>
              </div>
            ))}
            {highPriorityActions.map((action, idx) => (
              <div key={idx} className="py-1">
                <p className="text-sm font-medium">{action.action}</p>
                {action.context && <p className="text-xs text-muted-foreground">{action.context}</p>}
              </div>
            ))}
          </div>
        )}

        {/* AI RECOMMENDS */}
        {hasRecommendations && (
          <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 border-l-4 border-l-blue-500 rounded-lg p-3">
            <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 uppercase mb-2">AI Recommends</p>
            {otherActions.map((action, idx) => (
              <div key={idx} className="py-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">{action.priority}</Badge>
                  <p className="text-sm font-medium">{action.action}</p>
                </div>
                {action.context && <p className="text-xs text-muted-foreground mt-0.5">{action.context}</p>}
              </div>
            ))}
          </div>
        )}

        {/* NEW ASSIGNMENT PLANS */}
        {hasPlans && (
          <div className="bg-indigo-50 dark:bg-indigo-950/20 border border-indigo-200 dark:border-indigo-900 border-l-4 border-l-indigo-500 rounded-lg p-3">
            <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-400 uppercase mb-2">New Assignment Plans</p>
            <div className="space-y-2">
              {actionPlans?.map((plan) => (
                <ActionPlanCard key={plan.id} plan={plan} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
