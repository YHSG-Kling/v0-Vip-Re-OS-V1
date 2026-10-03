// app/dashboard/onboarding/page.tsx
// VIP Real Estate AI OS — Layer 11
// Onboarding Progress Dashboard with Certification Issuance
// 3-column layout: Progress Sidebar | Active Work Area | Achievements & Admin

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { readRoleGrants, selectVendorId } from '@/lib/auth/role-grants'
import { ensureAgentBrokerage } from '@/app/actions/onboarding/ensure-agent-brokerage'
import { getAgentOnboardingDashboard } from '@/lib/kernel/agent-onboarding'
import { OnboardingDashboardClient } from './OnboardingDashboardClient'
import { CriticalSetupMeter } from '@/app/components/onboarding/critical-setup-meter'
import {
  composeSetupReadiness,
  loadCriticalSetupFacts,
  normalizeCriticalRole,
  type CriticalSetupReadiness,
} from '@/lib/onboarding/critical-setup'

export const dynamic = 'force-dynamic'

export default async function OnboardingPage() {
  const supabase = await createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // Self-heal a brokerage-less agent/team_lead the same way /dashboard does — many
  // surfaces bounce an incomplete account here, and previously it only fell through
  // to /dashboard/agent (still no brokerage), so those pages "bounced back" forever.
  // Idempotent + guarded (no-op for an already-anchored user or a non-agent type).
  await ensureAgentBrokerage()

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

  // NOT `?? user.id` (m353). getAgentOnboardingDashboard filters
  // agent_onboarding.agent_id, which FKs AGENTS — so the fallback handed it a
  // users id and the query matched nothing. Worse, it was backwards: the
  // substitution only ever happened for the non-agent roles the AGENT
  // onboarding dashboard does not describe in the first place. A role without
  // an agents row gets an honest notice, not an empty agent curriculum.
  if (isAgentRole && !agentId) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Finishing your account setup — refresh in a moment to view your onboarding.
      </div>
    )
  }
  if (!agentId) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Onboarding is agent-scoped. Your role ({userType}) does not have an agent curriculum.
      </div>
    )
  }

  let dashboard
  try {
    dashboard = await getAgentOnboardingDashboard({
      userId:  user.id,
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

  // CRITICAL SETUP — THE FIRST ONBOARDING STEP (round 42). Before the
  // curriculum, show the role's critical-setup meter: the registry of items
  // whole engines no-op without (markets → scrape pipeline, assignment rules →
  // Engine 2, providers → egress, license → signature gate, …), each with an
  // honest why-line and a link to the existing settings surface. Derived from
  // real tables on every load — never a stored/staleable step status.
  let setupReadiness: CriticalSetupReadiness | null = null
  try {
    const role = normalizeCriticalRole(userType)
    if (role) {
      const svc = createServiceClient()
      let teamLead = false
      if (role === 'team_lead') teamLead = true
      let vendorId: string | null = null
      if (role === 'vendor') {
        // Read every grant and choose: narrowing to the vendor-bearing rows still
        // leaves several possible (the table is UNIQUE on (user_id, role)), and
        // `.maybeSingle()` over them ERRORS — which here silently emptied the
        // vendor half of the critical-setup meter and told a vendor their setup
        // was complete when it had simply not been looked at.
        const grantsResult = await readRoleGrants(svc, user.id)
        if (!grantsResult.ok) {
          console.error('[Onboarding] role grant read failed:', grantsResult.error)
        } else {
          const resolved = selectVendorId(grantsResult.grants)
          if (resolved.ambiguous) {
            console.error('[Onboarding] user', user.id, 'is linked to more than one vendor')
          }
          vendorId = resolved.vendorId
        }
      }
      const facts = await loadCriticalSetupFacts(svc, {
        brokerageId,
        userId: user.id,
        agentId,
        includeTeamLead: teamLead,
        vendorId,
      })
      setupReadiness = composeSetupReadiness({ role, facts })
    }
  } catch (error) {
    console.error('[Onboarding] critical-setup meter load failed (additive):', error)
  }

  return (
    <div className="space-y-4">
      {setupReadiness && (
        <div className="px-6 pt-4">
          <CriticalSetupMeter
            readiness={setupReadiness}
            heading="Step 1 — critical setup"
          />
        </div>
      )}
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
    </div>
  )
}
