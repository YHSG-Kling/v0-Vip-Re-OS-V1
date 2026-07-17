'use client'

import React from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Sparkles, ExternalLink } from 'lucide-react'

interface ActionPlanCardProps {
  plan: {
    id: string
    title: string
    description?: string
    priority?: string
    contact_id?: string | null
    relatedLeadName?: string
    source?: string
  }
}

const priorityColors = {
  high: 'bg-red-100 text-red-800',
  medium: 'bg-amber-100 text-amber-800',
  low: 'bg-green-100 text-green-800',
}

export function ActionPlanCard({ plan }: ActionPlanCardProps) {
  const truncatedDescription = plan.description?.slice(0, 120) + (plan.description && plan.description.length > 120 ? '...' : '')
  const priorityColor = plan.priority ? priorityColors[plan.priority.toLowerCase() as keyof typeof priorityColors] || 'bg-gray-100 text-gray-800' : null

  return (
    <Card className="border-l-4 border-l-blue-500 bg-blue-50 border-blue-200">
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-1">
            <Sparkles className="h-5 w-5 text-blue-600 flex-shrink-0" />
            <h3 className="font-medium text-sm flex-1">{plan.title}</h3>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {plan.source && <Badge variant="outline" className="text-[10px]">{plan.source}</Badge>}
            {priorityColor && <Badge className={priorityColor}>{plan.priority}</Badge>}
          </div>
        </div>

        {truncatedDescription && <p className="text-sm text-muted-foreground">{truncatedDescription}</p>}

        {plan.contact_id && (
          <Link href={`/crm/contacts/${plan.contact_id}`}>
            <Button size="sm" variant="outline" className="w-full">
              <ExternalLink className="h-4 w-4 mr-2" />
              View Lead
            </Button>
          </Link>
        )}

        {!plan.contact_id && (
          <Link href="/leads">
            <Button size="sm" variant="outline" className="w-full">
              <ExternalLink className="h-4 w-4 mr-2" />
              View Leads
            </Button>
          </Link>
        )}
      </div>
    </Card>
  )
}
