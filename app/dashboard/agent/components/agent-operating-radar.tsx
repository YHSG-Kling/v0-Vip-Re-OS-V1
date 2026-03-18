"use client"

import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { FileText, DollarSign, Users, Zap, Calendar, TrendingUp } from "lucide-react"

interface AgentOperatingRadarProps {
  stats: {
    activeTransactions: number
    pendingGCI: number
    ytdGCI: number
    contactCount: number
    leadsToday: number
    pendingTasks: number
    upcomingShowings: number
    activeListings?: number
  }
  loading: boolean
}

function formatK(value: number): string {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}K`
  }
  return value.toString()
}

export function AgentOperatingRadar({ stats, loading }: AgentOperatingRadarProps) {
  const tiles = [
    {
      icon: FileText,
      color: 'border-l-blue-500',
      iconColor: 'text-blue-600',
      href: '/dashboard/transactions',
      value: stats.activeTransactions,
      label: 'Active Deals',
      hint: 'Across all stages',
    },
    {
      icon: DollarSign,
      color: 'border-l-green-500',
      iconColor: 'text-green-600',
      href: '/dashboard/financials/agent',
      value: `$${formatK(stats.pendingGCI)}`,
      label: 'Pending Commission',
      hint: 'Estimated closes',
    },
    {
      icon: Users,
      color: 'border-l-purple-500',
      iconColor: 'text-purple-600',
      href: '/crm',
      value: stats.contactCount,
      label: 'Active Contacts',
      hint: 'Assigned to you',
    },
    {
      icon: Zap,
      color: 'border-l-amber-500',
      iconColor: 'text-amber-600',
      href: '/leads',
      value: stats.leadsToday,
      label: 'New Leads Today',
      hint: 'Needs first contact',
      showBadge: stats.leadsToday > 0,
    },
    {
      icon: Calendar,
      color: 'border-l-teal-500',
      iconColor: 'text-teal-600',
      href: '/dashboard/listings',
      value: stats.upcomingShowings,
      label: 'Upcoming Showings',
      hint: 'Next 48 hours',
    },
    {
      icon: TrendingUp,
      color: 'border-l-emerald-500',
      iconColor: 'text-emerald-600',
      href: '/dashboard/financials/agent',
      value: `$${formatK(stats.ytdGCI)}`,
      label: 'YTD Gross',
      hint: 'This calendar year',
    },
  ]

  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {[...Array(6)].map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardContent className="p-4">
              <div className="h-16 bg-muted rounded" />
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      {tiles.map((tile, idx) => (
        <Link key={idx} href={tile.href}>
          <Card className={`border-l-4 ${tile.color} hover:shadow-md transition-shadow cursor-pointer h-full`}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <tile.icon className={`h-5 w-5 ${tile.iconColor}`} />
                {tile.showBadge && (
                  <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                    New
                  </Badge>
                )}
              </div>
              <p className="text-2xl font-bold mt-2">{tile.value}</p>
              <p className="text-sm font-medium text-foreground">{tile.label}</p>
              <p className="text-xs text-muted-foreground">{tile.hint}</p>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  )
}
