"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Mail,
  Eye,
  MousePointer,
  MessageSquare,
  DollarSign,
  Users
} from "lucide-react"

interface CampaignPerformance {
  id: string
  name: string
  type: string
  metrics: {
    sent?: number
    opens?: number
    clicks?: number
    replies?: number
    conversions?: number
    revenue?: number
    openRate?: number
    clickRate?: number
    conversionRate?: number
  }
  trend: "up" | "down" | "stable"
  comparedToPrevious?: number
}

interface PerformanceFeedbackPanelProps {
  campaigns: CampaignPerformance[]
}

export function PerformanceFeedbackPanel({ campaigns }: PerformanceFeedbackPanelProps) {
  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case "up": return <TrendingUp className="h-4 w-4 text-green-500" />
      case "down": return <TrendingDown className="h-4 w-4 text-red-500" />
      default: return <Minus className="h-4 w-4 text-muted-foreground" />
    }
  }

  const getTrendColor = (trend: string) => {
    switch (trend) {
      case "up": return "text-green-500"
      case "down": return "text-red-500"
      default: return "text-muted-foreground"
    }
  }

  // Calculate aggregate metrics
  const totals = campaigns.reduce((acc, c) => ({
    sent: acc.sent + (c.metrics.sent || 0),
    opens: acc.opens + (c.metrics.opens || 0),
    clicks: acc.clicks + (c.metrics.clicks || 0),
    replies: acc.replies + (c.metrics.replies || 0),
    conversions: acc.conversions + (c.metrics.conversions || 0),
    revenue: acc.revenue + (c.metrics.revenue || 0),
  }), { sent: 0, opens: 0, clicks: 0, replies: 0, conversions: 0, revenue: 0 })

  const avgOpenRate = totals.sent > 0 ? Math.round((totals.opens / totals.sent) * 100) : 0
  const avgClickRate = totals.opens > 0 ? Math.round((totals.clicks / totals.opens) * 100) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5" />
          Performance Feedback
        </CardTitle>
        <CardDescription>Real-time campaign metrics and insights</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Aggregate Stats */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
          <div className="p-3 border rounded-lg text-center">
            <Mail className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
            <p className="text-lg font-bold">{totals.sent.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">Sent</p>
          </div>
          <div className="p-3 border rounded-lg text-center">
            <Eye className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
            <p className="text-lg font-bold">{avgOpenRate}%</p>
            <p className="text-xs text-muted-foreground">Open Rate</p>
          </div>
          <div className="p-3 border rounded-lg text-center">
            <MousePointer className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
            <p className="text-lg font-bold">{avgClickRate}%</p>
            <p className="text-xs text-muted-foreground">Click Rate</p>
          </div>
          <div className="p-3 border rounded-lg text-center">
            <MessageSquare className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
            <p className="text-lg font-bold">{totals.replies}</p>
            <p className="text-xs text-muted-foreground">Replies</p>
          </div>
          <div className="p-3 border rounded-lg text-center">
            <Users className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
            <p className="text-lg font-bold">{totals.conversions}</p>
            <p className="text-xs text-muted-foreground">Conversions</p>
          </div>
          <div className="p-3 border rounded-lg text-center bg-green-500/5">
            <DollarSign className="h-4 w-4 mx-auto text-green-500 mb-1" />
            <p className="text-lg font-bold text-green-600">${totals.revenue.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">Revenue</p>
          </div>
        </div>

        {/* Individual Campaign Performance */}
        {campaigns.length > 0 ? (
          <div className="space-y-2">
            <h4 className="font-medium text-sm">Campaign Breakdown</h4>
            {campaigns.slice(0, 5).map((campaign) => (
              <div 
                key={campaign.id} 
                className="flex items-center justify-between p-3 border rounded-lg"
              >
                <div className="flex items-center gap-3">
                  {getTrendIcon(campaign.trend)}
                  <div>
                    <p className="font-medium text-sm">{campaign.name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{campaign.type}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <div className="text-right">
                    <p className="font-medium">{campaign.metrics.openRate || 0}%</p>
                    <p className="text-xs text-muted-foreground">Opens</p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium">{campaign.metrics.clickRate || 0}%</p>
                    <p className="text-xs text-muted-foreground">Clicks</p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium">{campaign.metrics.conversions || 0}</p>
                    <p className="text-xs text-muted-foreground">Conv.</p>
                  </div>
                  {campaign.comparedToPrevious !== undefined && (
                    <Badge 
                      variant="outline" 
                      className={getTrendColor(campaign.trend)}
                    >
                      {campaign.comparedToPrevious > 0 ? "+" : ""}
                      {campaign.comparedToPrevious}%
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <TrendingUp className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>No performance data yet</p>
            <p className="text-xs">Launch campaigns to see metrics here</p>
          </div>
        )}

        {/* Insights */}
        {campaigns.length > 0 && (
          <div className="p-4 border rounded-lg bg-muted/30">
            <h4 className="font-medium text-sm mb-2">AI Insights</h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              {avgOpenRate > 25 && (
                <li className="flex items-center gap-2">
                  <TrendingUp className="h-3 w-3 text-green-500" />
                  Open rates above industry average (25%)
                </li>
              )}
              {avgClickRate > 3 && (
                <li className="flex items-center gap-2">
                  <TrendingUp className="h-3 w-3 text-green-500" />
                  Click-through rate exceeds benchmark
                </li>
              )}
              {totals.conversions > 0 && (
                <li className="flex items-center gap-2">
                  <Users className="h-3 w-3 text-blue-500" />
                  {totals.conversions} contacts converted to clients
                </li>
              )}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
