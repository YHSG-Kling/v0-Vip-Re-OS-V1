"use client"

import { Card, CardContent } from "@/components/ui/card"
import { 
  TrendingUp, 
  Users, 
  Mail, 
  Eye, 
  Clock, 
  AlertTriangle,
  CheckCircle2,
  PlayCircle
} from "lucide-react"

interface CampaignOpsRadarProps {
  activeSequences: number
  totalEnrollments: number
  totalAdSpend: number
  totalImpressions: number
  pendingApprovals?: number
  scheduledPosts?: number
  atRiskCampaigns?: number
}

export function CampaignOpsRadar({
  activeSequences,
  totalEnrollments,
  totalAdSpend,
  totalImpressions,
  pendingApprovals = 0,
  scheduledPosts = 0,
  atRiskCampaigns = 0,
}: CampaignOpsRadarProps) {
  const metrics = [
    {
      label: "Active Sequences",
      value: activeSequences,
      icon: PlayCircle,
      color: "green",
      format: (v: number) => v.toString(),
    },
    {
      label: "Total Enrollments",
      value: totalEnrollments,
      icon: Users,
      color: "blue",
      format: (v: number) => v.toLocaleString(),
    },
    {
      label: "Ad Spend",
      value: totalAdSpend,
      icon: TrendingUp,
      color: "purple",
      format: (v: number) => `$${v.toLocaleString()}`,
    },
    {
      label: "Impressions",
      value: totalImpressions,
      icon: Eye,
      color: "amber",
      format: (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toString(),
    },
    {
      label: "Pending Approval",
      value: pendingApprovals,
      icon: Clock,
      color: pendingApprovals > 0 ? "amber" : "muted",
      format: (v: number) => v.toString(),
    },
    {
      label: "Scheduled",
      value: scheduledPosts,
      icon: CheckCircle2,
      color: "green",
      format: (v: number) => v.toString(),
    },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {metrics.map((metric) => {
        const Icon = metric.icon
        return (
          <Card key={metric.label} className="border-l-4" style={{ borderLeftColor: `var(--${metric.color}-500, hsl(var(--muted)))` }}>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg bg-${metric.color}-500/10`}>
                  <Icon className={`h-4 w-4 text-${metric.color}-500`} />
                </div>
                <div>
                  <p className="text-xl font-bold">{metric.format(metric.value)}</p>
                  <p className="text-xs text-muted-foreground">{metric.label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )
      })}

      {/* At-Risk Alert */}
      {atRiskCampaigns > 0 && (
        <Card className="border-l-4 border-l-red-500 bg-red-50/50 dark:bg-red-950/20">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-500/10">
                <AlertTriangle className="h-4 w-4 text-red-500" />
              </div>
              <div>
                <p className="text-xl font-bold text-red-600">{atRiskCampaigns}</p>
                <p className="text-xs text-red-600/80">At Risk</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
