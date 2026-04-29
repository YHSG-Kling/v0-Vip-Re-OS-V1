// app/api/cron/onboarding-health/route.ts
// VIP Real Estate AI OS — Layer 11
// Cron job to detect stalled onboarding and create smart assistant suggestions
// Schedule: Daily via Vercel Cron

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'
import { processKernelEvent } from '@/lib/kernel/notification-engine'
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from '@/app/actions/cron-kernel'

// Vercel Cron config
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Stalled threshold: 7 days with no progress
const STALLED_DAYS_THRESHOLD = 7

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const contextResult = await createCronRunContextAction({
    cron_name: 'onboarding-health',
    cron_path: '/app/api/cron/onboarding-health/route.ts',
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: 'Failed to create cron context' }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error('[OnboardingHealth] Failed to record cron start:', startRecordResult.error)
  }

  try {
  const supabase = createServiceClient()
  const now = new Date()
  const stalledThreshold = new Date(now.getTime() - STALLED_DAYS_THRESHOLD * 24 * 60 * 60 * 1000)

  // Get all in-progress onboarding records
  const { data: onboardings, error: onboardingsError } = await supabase
    .from('agent_onboarding')
    .select('id, agent_id, brokerage_id, current_day, status, updated_at')
    .eq('status', 'in_progress')

  if (onboardingsError) {
    console.error('[OnboardingHealth] Error fetching onboardings:', onboardingsError)
    return NextResponse.json({ error: 'Failed to fetch onboardings' }, { status: 500 })
  }

  if (!onboardings || onboardings.length === 0) {
    return NextResponse.json({ message: 'No in-progress onboardings found', processed: 0 })
  }

  const stalledAgents: string[] = []
  const suggestions: Array<{
    agent_id: string
    brokerage_id: string
    suggestion_type: string
    title: string
    body: string
    priority: 'low' | 'medium' | 'high'
  }> = []

  for (const onboarding of onboardings) {
    // Get the most recent step completion for this agent
    const { data: latestCompletion } = await supabase
      .from('agent_step_completions')
      .select('completed_at, updated_at')
      .eq('agent_id', onboarding.agent_id)
      .eq('brokerage_id', onboarding.brokerage_id)
      .eq('completed', true)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Determine last activity date
    const lastActivityDate = latestCompletion?.completed_at 
      ? new Date(latestCompletion.completed_at)
      : onboarding.updated_at
        ? new Date(onboarding.updated_at)
        : null

    if (!lastActivityDate) {
      // No activity at all - consider stalled if onboarding started more than threshold days ago
      stalledAgents.push(onboarding.agent_id)
      continue
    }

    // Check if stalled (no activity in threshold days)
    if (lastActivityDate < stalledThreshold) {
      stalledAgents.push(onboarding.agent_id)

      // Get agent name for personalized suggestion
      const { data: agent } = await supabase
        .from('users')
        .select('first_name, last_name')
        .eq('id', onboarding.agent_id)
        .single()

      const agentName = agent 
        ? `${agent.first_name || ''} ${agent.last_name || ''}`.trim() 
        : 'Agent'

      // Emit ONBOARDING_STALLED event
      await processKernelEvent({
        event: KernelEvent.ONBOARDING_STALLED,
        brokerageId: onboarding.brokerage_id,
        entityType: 'agent_onboarding',
        entityId: onboarding.id,
      }).catch(err => {
        console.error('[OnboardingHealth] Failed to process stalled event:', err)
      })

      // Create smart assistant suggestion for the agent
      suggestions.push({
        agent_id: onboarding.agent_id,
        brokerage_id: onboarding.brokerage_id,
        suggestion_type: 'onboarding_nudge',
        title: 'Resume Your Onboarding',
        body: `Hey ${agentName.split(' ')[0] || 'there'}! It looks like your onboarding progress has stalled at Day ${onboarding.current_day}. Would you like to continue where you left off? Your next steps are waiting for you.`,
        priority: 'high',
      })

      // Create notification for brokerage admins
      const { data: admins } = await supabase
        .from('users')
        .select('id')
        .eq('brokerage_id', onboarding.brokerage_id)
        .in('user_type', ['admin', 'broker'])

      for (const admin of admins || []) {
        await supabase.from('notifications').insert({
          user_id: admin.id,
          brokerage_id: onboarding.brokerage_id,
          type: 'onboarding_stalled',
          entity_type: 'agent_onboarding',
          entity_id: onboarding.id,
          title: 'Agent Onboarding Stalled',
          body: `${agentName} has not made onboarding progress in ${STALLED_DAYS_THRESHOLD}+ days (currently on Day ${onboarding.current_day}).`,
          is_read: false,
          priority: 'high',
        }).then(() => {}, (err: unknown) => {
          console.error('[OnboardingHealth] Failed to create admin notification:', err)
        })
      }
    }
  }

  // Bulk insert smart assistant suggestions
  if (suggestions.length > 0) {
    const { error: suggestionsError } = await supabase
      .from('smart_assistant_suggestions')
      .insert(suggestions.map(s => ({
        agent_id: s.agent_id,
        brokerage_id: s.brokerage_id,
        suggestion_type: s.suggestion_type,
        title: s.title,
        body: s.body,
        priority: s.priority,
        status: 'pending',
        context: { source: 'onboarding_health_cron' },
      })))

    if (suggestionsError) {
      console.error('[OnboardingHealth] Error inserting suggestions:', suggestionsError)
    }
  }

  console.log(`[OnboardingHealth] Processed ${onboardings.length} onboardings, found ${stalledAgents.length} stalled`)

  await recordCronSuccessAction({
    context_id: contextId,
    records_processed: onboardings.length,
    output_count: suggestions.length,
    metadata: { processed: onboardings.length, stalledCount: stalledAgents.length, suggestionsCreated: suggestions.length },
  })

  return NextResponse.json({
    message: 'Onboarding health check complete',
    processed: onboardings.length,
    stalledCount: stalledAgents.length,
    suggestionsCreated: suggestions.length,
  })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error('[OnboardingHealth] Cron failed:', error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: 'main-processing' })
    return NextResponse.json({ error: errorMessage, context_id: contextId }, { status: 500 })
  }
}
