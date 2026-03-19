"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { RefreshCw, Loader2 } from "lucide-react"

interface AgentCommandStripProps {
  agentName: string
  briefing: {
    summary?: string
    top_priority_actions?: Array<{ priority: 'high' | 'medium' | 'low'; action: string; context?: string }>
    market_pulse?: string
    hot_leads?: Array<{ name: string; status?: string; suggested_action?: string }>
    deals_at_risk?: Array<{ transaction_id: string; address: string; reason?: string }>
    tasks_overdue?: number
  } | null
  actionPlans?: Array<{ id: string; title: string; description?: string; contact_id?: string | null }>
  onRefreshBriefing: () => void
  refreshing: boolean
}

export function AgentCommandStrip({
  agentName,
  briefing,
  actionPlans,
  onRefreshBriefing,
  refreshing
}: AgentCommandStripProps) {
  const getGreeting = () => {
    const hour = new Date().getHours()
    if (hour < 12) return "Good morning,"
    if (hour < 17) return "Good afternoon,"
    return "Good evening,"
  }

  const getPriorityDotColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'bg-red-400'
      case 'medium': return 'bg-amber-400'
      case 'low': return 'bg-blue-400'
      default: return 'bg-gray-400'
    }
  }

  // NULL STATE
  if (!briefing) {
    return (
      <div className="bg-gradient-to-r from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-900 rounded-2xl px-6 py-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">{getGreeting()}</p>
            <p className="text-lg font-bold text-foreground">{agentName}</p>
            <p className="text-sm text-muted-foreground mt-1">Your AI briefing is ready when you are.</p>
          </div>
          <Button
            onClick={onRefreshBriefing}
            disabled={refreshing}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            Generate Today&apos;s Briefing
          </Button>
        </div>
      </div>
    )
  }

  const highPriorityAction = briefing.top_priority_actions?.find(a => a.priority === 'high')
  const hotLeadsCount = briefing.hot_leads?.length || 0
  const dealsAtRiskCount = briefing.deals_at_risk?.length || 0
  const tasksOverdue = briefing.tasks_overdue || 0

  return (
    <div className="bg-gradient-to-r from-blue-700 to-indigo-800 text-white rounded-2xl px-6 py-5">
      <div className="flex items-start justify-between">
        {/* LEFT 2/3 */}
        <div className="flex-1 max-w-[66%]">
          <p className="text-xs text-blue-200">{getGreeting()}</p>
          <p className="text-lg font-bold">{agentName}</p>
          {highPriorityAction && (
            <>
              <p className="text-md font-medium text-white mt-1">{highPriorityAction.action}</p>
              {highPriorityAction.context && (
                <p className="text-sm text-blue-200">{highPriorityAction.context}</p>
              )}
            </>
          )}

          {/* Radar pills */}
          <div className="flex flex-wrap gap-2 mt-3">
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/20 text-amber-200">
              {hotLeadsCount} leads showing strong intent
            </span>
            {dealsAtRiskCount > 0 ? (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-red-500/20 text-red-200">
                {dealsAtRiskCount} deals may slow a customer&apos;s closing
              </span>
            ) : (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/20 text-green-200">
                All active deals are healthy
              </span>
            )}
            {tasksOverdue > 0 ? (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-orange-500/20 text-orange-200">
                {tasksOverdue} overdue actions
              </span>
            ) : (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-gray-500/20 text-gray-300">
                0 overdue items
              </span>
            )}
          </div>
        </div>

        {/* RIGHT 1/3 */}
        <div className="text-right space-y-2">
          <div className="flex items-center justify-end gap-2">
            <Link href="/dashboard/briefing" className="text-white underline text-sm hover:text-blue-200">
              View Full Briefing →
            </Link>
            <Button
              variant="ghost"
              size="icon"
              onClick={onRefreshBriefing}
              disabled={refreshing}
              className="text-white hover:bg-white/10"
            >
              {refreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
          {briefing.market_pulse && (
            <p className="text-xs italic text-blue-200 max-w-[200px]">
              {briefing.market_pulse.slice(0, 90)}{briefing.market_pulse.length > 90 ? '...' : ''}
            </p>
          )}
        </div>
      </div>

      {/* BOTTOM */}
      {((briefing.top_priority_actions && briefing.top_priority_actions.length > 0) || (actionPlans && actionPlans.length > 0)) && (
        <div className="border-t border-white/10 mt-3 pt-2">
          <div className="overflow-x-auto flex gap-2 scrollbar-hide">
            {briefing.top_priority_actions?.map((action, idx) => (
              <span
                key={`action-${idx}`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-white/10 text-white whitespace-nowrap"
              >
                <span className={`w-1.5 h-1.5 rounded-full ${getPriorityDotColor(action.priority)}`} />
                <span className="max-w-[200px] truncate">{action.action}</span>
              </span>
            ))}
            {actionPlans?.slice(0, 2).map((plan) => (
              <span
                key={plan.id}
                className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-blue-200/20 text-blue-100 whitespace-nowrap"
              >
                <span className="max-w-[200px] truncate">Plan: {plan.title}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
