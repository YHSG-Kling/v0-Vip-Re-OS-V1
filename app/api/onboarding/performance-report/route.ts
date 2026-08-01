// app/api/onboarding/performance-report/route.ts
// VIP Real Estate AI OS — Layer 11
// API route for generating AI-powered performance reports

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { streamText } from 'ai'
import { getAgentProgress } from '@/app/actions/onboarding/progress'

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get user's brokerage
  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, first_name, last_name')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) {
    return NextResponse.json({ error: 'No brokerage found' }, { status: 400 })
  }

  const brokerageId = userData.brokerage_id
  // domain drill: agent_onboarding / video_completion_tracking /
  // agent_quiz_attempts all FK agents(id) — the raw user.id filter read EMPTY
  // for every agent and the performance report showed zeros. Resolve it.
  const { resolveAgentId } = await import("@/lib/kernel/agent-identity")
  // NOT `?? user.id` (m353). The comment above says the raw user.id filter
  // "read EMPTY for every agent and the performance report showed zeros" — the
  // fallback reinstated exactly that. A report of zeros is worse than no report.
  const agentId = await resolveAgentId(supabase as any, user.id)
  if (!agentId) {
    return NextResponse.json({ error: 'No agent profile for this user — the performance report is agent-scoped.' }, { status: 409 })
  }

  // Gather metrics
  const progressResult = await getAgentProgress(agentId, brokerageId)
  if (!progressResult.success || !progressResult.data) {
    return NextResponse.json({ error: 'Failed to gather progress data' }, { status: 500 })
  }

  // Get onboarding record
  const { data: onboarding } = await supabase
    .from('agent_onboarding')
    .select('start_date')
    .eq('agent_id', agentId)
    .maybeSingle()

  // Get video completion metrics
  const { data: videoProgress } = await supabase
    .from('video_completion_tracking')
    .select('training_video_id, percent_watched, completed')
    .eq('agent_id', agentId)

  const avgVideoCompletion = videoProgress && videoProgress.length > 0
    ? Math.round(videoProgress.reduce((sum, v) => sum + (v.percent_watched || 0), 0) / videoProgress.length)
    : 0

  // Get quiz metrics
  const { data: quizAttempts } = await supabase
    .from('agent_quiz_attempts')
    .select('score, passed')
    .eq('agent_id', agentId)

  const avgQuizScore = quizAttempts && quizAttempts.length > 0
    ? Math.round(quizAttempts.reduce((sum, q) => sum + (q.score || 0), 0) / quizAttempts.length)
    : null

  // Calculate days in onboarding
  const daysInOnboarding = onboarding?.start_date
    ? Math.ceil((Date.now() - new Date(onboarding.start_date).getTime()) / (1000 * 60 * 60 * 24))
    : 0

  const metrics = {
    agentName: `${userData.first_name || ''} ${userData.last_name || ''}`.trim() || 'Agent',
    overallCompletion: progressResult.data.overallPercentage,
    completedSteps: progressResult.data.completedRequired,
    totalSteps: progressResult.data.totalRequired,
    daysInOnboarding,
    avgVideoCompletion,
    avgQuizScore,
    certificationsEarned: progressResult.data.certifications.filter(c => c.awarded).length,
    totalCertifications: progressResult.data.certifications.length,
    categories: progressResult.data.categories.map(c => ({
      name: c.category,
      percentage: c.percentage,
      completed: c.completed,
      total: c.total,
    })),
    strengths: [] as string[],
    improvementAreas: [] as string[],
  }

  // Identify strengths and improvement areas
  for (const cat of progressResult.data.categories) {
    if (cat.percentage >= 80) {
      metrics.strengths.push(cat.category.replace(/_/g, ' '))
    } else if (cat.percentage < 50) {
      metrics.improvementAreas.push(cat.category.replace(/_/g, ' '))
    }
  }

  // Stream AI-generated report using Claude
  const result = streamText({
    model: 'anthropic/claude-sonnet-4-20250514',
    system: `You are a real estate brokerage training coach. Generate a performance report for a new agent going through onboarding. Be encouraging but honest. Provide actionable recommendations.`,
    prompt: `Based on this agent's onboarding metrics:

${JSON.stringify(metrics, null, 2)}

Generate a JSON performance report with these exact fields:
{
  "overall_score": <number 0-100 based on progress>,
  "ai_narrative": "<2-3 sentence summary of their progress>",
  "strengths": ["<strength 1>", "<strength 2>", ...],
  "improvement_areas": ["<area 1>", "<area 2>", ...],
  "recommended_actions": ["<action 1>", "<action 2>", "<action 3>"]
}

Make the narrative personalized and actionable. If they're doing well, acknowledge it. If they're struggling, be supportive.`,
    onFinish: async ({ text }) => {
      // Parse the response and save to database
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/)
        if (!jsonMatch) return

        const reportData = JSON.parse(jsonMatch[0])
        
        const serviceClient = createServiceClient()
        await serviceClient
          .from('agent_performance_reports')
          .insert({
            agent_id: agentId,
            brokerage_id: brokerageId,
            report_type: 'onboarding_coaching',
            period_start: onboarding?.start_date || new Date().toISOString(),
            period_end: new Date().toISOString(),
            // agent_performance_reports has no overall_score/strengths/improvement_areas
            // columns — fold them into the metrics jsonb (mirrored on read in GET).
            metrics: {
              ...metrics,
              overall_score: reportData.overall_score,
              strengths: reportData.strengths,
              improvement_areas: reportData.improvement_areas,
            },
            ai_summary: reportData.ai_narrative,
            recommendations: reportData.recommended_actions,
          })
      } catch (err) {
        console.error('[PerformanceReport] Error saving report:', err)
      }
    },
  })

  return result.toTextStreamResponse()
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get most recent report
  const { data: report } = await supabase
    .from('agent_performance_reports')
    .select('*')
    .eq('agent_id', user.id)
    .eq('report_type', 'onboarding_coaching')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!report) {
    return NextResponse.json({ hasReport: false })
  }

  return NextResponse.json({
    hasReport: true,
    report: {
      id: report.id,
      overallScore: report.metrics?.overall_score,
      aiNarrative: report.ai_summary,
      strengths: report.metrics?.strengths || [],
      improvementAreas: report.metrics?.improvement_areas || [],
      recommendedActions: report.recommendations || [],
      createdAt: report.created_at,
    },
  })
}
