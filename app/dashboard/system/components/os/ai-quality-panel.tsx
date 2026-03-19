'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Brain, AlertCircle, CheckCircle, TrendingUp, Users } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface AIQualityPanelProps {
  brokerageId: string
}

interface AIQualityMetrics {
  totalFeedback: number
  positiveCount: number
  negativeCount: number
  approvalRate: number
  humanReviewPressure: number
  lowConfidenceCount: number
  topNegativeThemes: string[]
}

export function AIQualityPanel({ brokerageId }: AIQualityPanelProps) {
  const [loading, setLoading] = useState(true)
  const [metrics, setMetrics] = useState<AIQualityMetrics | null>(null)

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const supabase = createClient()

        // Get AI feedback metrics from ai_improvement_metrics table
        const weekStart = new Date()
        weekStart.setDate(weekStart.getDate() - 7)

        const { data: improvementData } = await supabase
          .from('ai_improvement_metrics')
          .select('total_feedback, positive_count, negative_count, approval_rate, top_negative_themes')
          .eq('brokerage_id', brokerageId)
          .gte('week_start', weekStart.toISOString().split('T')[0])
          .order('week_start', { ascending: false })
          .limit(1)
          .maybeSingle()

        // Get conversation insights that require human review
        const { data: reviewData, count: reviewCount } = await supabase
          .from('conversation_insights')
          .select('id', { count: 'exact', head: true })
          .eq('requires_human_review', true)

        // Get low confidence AI drafts
        const { data: lowConfData, count: lowConfCount } = await supabase
          .from('ai_message_drafts')
          .select('id', { count: 'exact', head: true })
          .eq('brokerage_id', brokerageId)
          .lt('confidence_score', 60)
          .eq('status', 'pending')

        setMetrics({
          totalFeedback: improvementData?.total_feedback || 0,
          positiveCount: improvementData?.positive_count || 0,
          negativeCount: improvementData?.negative_count || 0,
          approvalRate: improvementData?.approval_rate || 100,
          humanReviewPressure: reviewCount || 0,
          lowConfidenceCount: lowConfCount || 0,
          topNegativeThemes: improvementData?.top_negative_themes || []
        })
      } catch (error) {
        console.error('Error loading AI quality metrics:', error)
        setMetrics({
          totalFeedback: 0,
          positiveCount: 0,
          negativeCount: 0,
          approvalRate: 100,
          humanReviewPressure: 0,
          lowConfidenceCount: 0,
          topNegativeThemes: []
        })
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="flex items-center justify-center py-8">
          <Brain className="h-6 w-6 animate-pulse text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  const qualityScore = metrics?.approvalRate || 100
  const qualityLevel = qualityScore >= 90 ? 'excellent' : qualityScore >= 75 ? 'good' : qualityScore >= 50 ? 'fair' : 'needs-attention'

  const qualityColors = {
    excellent: 'text-green-600 bg-green-50 dark:bg-green-950/20',
    good: 'text-blue-600 bg-blue-50 dark:bg-blue-950/20',
    fair: 'text-yellow-600 bg-yellow-50 dark:bg-yellow-950/20',
    'needs-attention': 'text-red-600 bg-red-50 dark:bg-red-950/20',
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Brain className="h-5 w-5 text-primary" />
          AI Quality
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Quality Score */}
        <div className={`rounded-lg p-4 ${qualityColors[qualityLevel]}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-3xl font-bold">{qualityScore.toFixed(1)}%</p>
              <p className="text-sm opacity-80">Approval Rate (7d)</p>
            </div>
            {qualityLevel === 'excellent' || qualityLevel === 'good' ? (
              <CheckCircle className="h-8 w-8 opacity-60" />
            ) : (
              <AlertCircle className="h-8 w-8 opacity-60" />
            )}
          </div>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-4 w-4 text-green-500" />
              <span className="text-sm text-muted-foreground">Positive</span>
            </div>
            <p className="text-xl font-bold">{metrics?.positiveCount || 0}</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="h-4 w-4 text-red-500" />
              <span className="text-sm text-muted-foreground">Negative</span>
            </div>
            <p className="text-xl font-bold">{metrics?.negativeCount || 0}</p>
          </div>
        </div>

        {/* Human Review Pressure */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Human Review Queue</span>
            </div>
            <Badge variant={metrics?.humanReviewPressure && metrics.humanReviewPressure > 10 ? 'destructive' : 'secondary'}>
              {metrics?.humanReviewPressure || 0} pending
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Low Confidence Drafts</span>
            </div>
            <Badge variant={metrics?.lowConfidenceCount && metrics.lowConfidenceCount > 5 ? 'destructive' : 'secondary'}>
              {metrics?.lowConfidenceCount || 0} drafts
            </Badge>
          </div>
        </div>

        {/* Negative Themes */}
        {metrics?.topNegativeThemes && metrics.topNegativeThemes.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Top Issues This Week</p>
            <div className="flex flex-wrap gap-1">
              {metrics.topNegativeThemes.slice(0, 3).map((theme, i) => (
                <Badge key={i} variant="outline" className="text-xs">
                  {theme}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
