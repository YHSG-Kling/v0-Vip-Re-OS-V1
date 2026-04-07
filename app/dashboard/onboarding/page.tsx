// app/dashboard/onboarding/page.tsx
// VIP Real Estate AI OS — Layer 11
// Onboarding Progress Dashboard with Certification Issuance
// 3-column layout: Progress Sidebar | Active Work Area | Achievements & Admin

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getAgentOnboardingDashboard } from '@/lib/kernel/agent-onboarding'
import { OnboardingDashboardClient } from './OnboardingDashboardClient'

export const dynamic = 'force-dynamic'

export default async function OnboardingPage() {
  const supabase = await createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // Get user details including type — maybeSingle() never throws on missing row
  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle()

  // If no users row, fall back to agents table to get brokerage_id
  let brokerageId = userData?.brokerage_id ?? null
  if (!brokerageId) {
    const { data: agentRow } = await supabase
      .from('agents')
      .select('brokerage_id')
      .eq('user_id', user.id)
      .maybeSingle()
    brokerageId = agentRow?.brokerage_id ?? null
  }

  if (!brokerageId) {
    // No brokerage assigned — account is incomplete; show setup flow
    redirect('/dashboard/agent')
  }

  // Get agent ID — for agents it's agents.id (FK), not users.id
  let agentId: string | null = null

  const userType = userData?.user_type ?? 'agent'
  const isAgentRole = ['agent', 'isa', 'team_lead'].includes(userType)

  if (isAgentRole) {
    const { data: agent } = await supabase
      .from('agents')
      .select('id')
      .eq('user_id', user.id)
      .eq('brokerage_id', brokerageId)
      .maybeSingle()
    agentId = agent?.id ?? null
  }

  // Fetch onboarding dashboard data using kernel function
  // agentId may be null for non-agent roles (tc, broker, admin) — kernel handles this
  let dashboard
  try {
    dashboard = await getAgentOnboardingDashboard({
      userId:  user.id,
      agentId: agentId ?? user.id, // kernel expects a string; fall back to user.id for non-agent path
    })
  } catch (error) {
    console.error('[Onboarding] Failed to load dashboard:', error)
    return (
      <div className="p-6">
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
          <p className="text-destructive">Failed to load onboarding data. Please try again.</p>
        </div>
      </div>
    )
  }

  return (
    <OnboardingDashboardClient
      initialData={{
        onboarding: {
          id: dashboard.onboarding.id,
          status: dashboard.onboarding.status,
          completion_percentage: dashboard.onboarding.completion_percentage,
          current_day: dashboard.onboarding.current_day,
          certification_achieved: dashboard.onboarding.certification_achieved,
          certified_at: dashboard.onboarding.certified_at,
        },
        steps: dashboard.steps,
        completions: dashboard.completions.map(c => ({
          step_id: c.step_id,
          completed: c.completed,
          completed_at: c.completed_at,
          quiz_score: c.quiz_score,
        })),
      }}
      userType={userData?.user_type ?? 'agent'}
      brokerageId={brokerageId}
    />
  )
}
