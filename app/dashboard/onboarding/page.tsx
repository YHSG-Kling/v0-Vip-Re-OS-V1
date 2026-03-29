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

  // Get user details including type
  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle()

  // If no users row, fall back to agents table to get brokerage_id
  let brokerageId = userData?.brokerage_id
  if (!brokerageId) {
    const { data: agentRow } = await supabase
      .from('agents')
      .select('brokerage_id')
      .eq('user_id', user.id)
      .maybeSingle()
    brokerageId = agentRow?.brokerage_id
  }

  if (!brokerageId) {
    redirect('/dashboard/agent')
  }

  // Get agent ID - for agents it's their own ID, for admin viewing they may pass a different ID
  let agentId = user.id

  // For agents, get their agent record
  const userType = userData?.user_type ?? 'agent'
  if (userType === 'agent') {
    const { data: agent } = await supabase
      .from('agents')
      .select('id')
      .eq('user_id', user.id)
      .eq('brokerage_id', brokerageId)
      .maybeSingle()

    if (agent) {
      agentId = agent.id
    }
  }

  // Fetch onboarding dashboard data using kernel function
  let dashboard
  try {
    dashboard = await getAgentOnboardingDashboard({
      userId: user.id,
      agentId,
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
      userType={userData.user_type || 'agent'}
      brokerageId={userData.brokerage_id}
    />
  )
}
