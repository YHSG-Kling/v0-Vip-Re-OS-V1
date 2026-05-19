'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { 
  Loader2, 
  AlertTriangle, 
  Clock, 
  Phone, 
  Mail, 
  Home, 
  FileText,
  ArrowRight,
  Sparkles 
} from 'lucide-react'
import Link from 'next/link'
import { getTodaysBriefing } from '@/app/actions/briefing-actions'

interface PriorityAction {
  id: string
  type: string
  title: string
  description?: string
  urgency: 'critical' | 'high' | 'medium' | 'low'
  route?: string
  contact_name?: string
  deadline?: string
}

export function RootCommandPreview() {
  const [loading, setLoading] = useState(true)
  const [priorityActions, setPriorityActions] = useState<PriorityAction[]>([])
  const [briefingSummary, setBriefingSummary] = useState<string | null>(null)

  useEffect(() => {
    async function loadBriefing() {
      try {
        const result = await getTodaysBriefing()
        
        if (result.briefing) {
          setBriefingSummary(result.briefing.summary || null)
          
          // Extract priority actions from briefing
          const actions: PriorityAction[] = []
          
          if (result.briefing.top_priority_actions && Array.isArray(result.briefing.top_priority_actions)) {
            result.briefing.top_priority_actions.forEach((action: any, idx: number) => {
              actions.push({
                id: `priority-${idx}`,
                type: action.type || 'task',
                title: action.title || action.description || 'Action Required',
                description: action.description,
                urgency: action.urgency || 'high',
                route: action.route,
                contact_name: action.contact_name,
                deadline: action.deadline,
              })
            })
          }

          // Add hot leads as priority actions
          if (result.briefing.hot_leads && Array.isArray(result.briefing.hot_leads)) {
            result.briefing.hot_leads.slice(0, 2).forEach((lead: any, idx: number) => {
              actions.push({
                id: `lead-${idx}`,
                type: 'lead',
                title: `Follow up with ${lead.name || 'Hot Lead'}`,
                description: lead.reason || 'High engagement detected',
                urgency: 'high',
                route: lead.contact_id ? `/crm/contacts/${lead.contact_id}` : '/crm',
                contact_name: lead.name,
              })
            })
          }

          // Add deals at risk
          if (result.briefing.deals_at_risk && Array.isArray(result.briefing.deals_at_risk)) {
            result.briefing.deals_at_risk.slice(0, 2).forEach((deal: any, idx: number) => {
              actions.push({
                id: `deal-${idx}`,
                type: 'deal',
                title: `Deal at Risk: ${deal.deal_name || deal.property_address || 'Transaction'}`,
                description: deal.risk_reason || 'Needs attention',
                urgency: 'critical',
                route: deal.transaction_id ? `/transactions/${deal.transaction_id}` : '/dashboard/transactions',
              })
            })
          }

          setPriorityActions(actions.slice(0, 5))
        }
      } catch (error) {
        console.error('[RootCommandPreview] Error loading briefing:', error)
      } finally {
        setLoading(false)
      }
    }

    loadBriefing()
  }, [])

  const getActionIcon = (type: string) => {
    switch (type) {
      case 'call':
      case 'lead':
        return Phone
      case 'email':
        return Mail
      case 'showing':
      case 'deal':
        return Home
      case 'document':
        return FileText
      default:
        return Clock
    }
  }

  const getUrgencyColor = (urgency: string) => {
    switch (urgency) {
      case 'critical':
        return 'bg-destructive/10 text-destructive border-destructive/20'
      case 'high':
        return 'bg-amber-50 text-amber-700 border-amber-200'
      case 'medium':
        return 'bg-blue-50 text-blue-700 border-blue-200'
      default:
        return 'bg-muted text-muted-foreground border-border'
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    )
  }

  if (priorityActions.length === 0 && !briefingSummary) {
    return (
      <Card className="border-primary/20">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-primary" />
            Today's Focus
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No priority actions for now. Check your role-specific dashboard for more details.
          </p>
          <Link href="/dashboard/briefing">
            <Button variant="outline" size="sm" className="mt-3">
              View Full Briefing
            </Button>
          </Link>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3 border-b">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Priority Actions
          </CardTitle>
          <Badge variant="secondary">{priorityActions.length} items</Badge>
        </div>
        {briefingSummary && (
          <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
            {briefingSummary}
          </p>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {priorityActions.map((action) => {
            const Icon = getActionIcon(action.type)
            return (
              <div
                key={action.id}
                className="p-4 hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-muted rounded-lg shrink-0">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-medium text-sm truncate">{action.title}</p>
                      <Badge
                        variant="outline"
                        className={`text-xs shrink-0 ${getUrgencyColor(action.urgency)}`}
                      >
                        {action.urgency}
                      </Badge>
                    </div>
                    {action.description && (
                      <p className="text-xs text-muted-foreground line-clamp-1">
                        {action.description}
                      </p>
                    )}
                    {action.contact_name && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {action.contact_name}
                      </p>
                    )}
                  </div>
                  {action.route && (
                    <Link href={action.route}>
                      <Button variant="ghost" size="icon" className="shrink-0">
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </Link>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="p-3 border-t bg-muted/30">
          <Link href="/dashboard/briefing">
            <Button variant="outline" size="sm" className="w-full">
              View Full Briefing
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
