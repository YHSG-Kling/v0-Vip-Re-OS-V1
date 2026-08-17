import { getAgentContext } from '@/lib/identity/get-agent-context'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import {
  SystemCommandStrip,
  ProviderHealthPanel,
  AgentCapabilityPanel,
  OutcomeProofPanel,
  RenderCachePanel,
  LivingVideoPanel,
  ObservabilityPanel,
  AIQualityPanel,
  SyncHealthPanel,
  SystemAlertsPanel,
  OperationalImpactPanel,
  ServiceSLAPanel,
  SchemaReadinessPanel,
} from './components/os'
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

// Force dynamic rendering - this page requires authentication
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'System Intelligence | Operations Dashboard',
  description: 'Monitor system health, provider status, and operational intelligence',
}

export default async function SystemPage() {
  const context = await getAgentContext()

  // Require authentication
  if (!context?.brokerageId) {
    redirect('/login')
  }

  // Role gate: broker, admin, superadmin only (NOT agents)
  // This is a broker/admin operations surface, not superadmin-only
  if (!isAdminOrBroker({ user_type: context.userType })) {
    redirect('/dashboard')
  }

  const { brokerageId } = context

  // "Is superadmin" needs BOTH identity columns and AgentContext carries only
  // user_type, so platform_role is read here. `context.userType === 'superadmin'`
  // was FALSE for the platform's only superadmin (user_type='admin',
  // platform_role='superadmin'), so the footer's link out to Superadmin
  // Observability — the ONLY route to full observability offered from this page —
  // never rendered for the one account that can use it. Same shape as
  // public.is_platform_admin() in RLS; see app/actions/vendor-budget.ts:136-147.
  const supabase = await createClient()
  const { data: identity } = await supabase
    .from('users')
    .select('platform_role')
    .eq('id', context.userId)
    .maybeSingle()
  const isSuperadmin =
    context.userType === 'superadmin' ||
    (identity as { platform_role?: string | null } | null)?.platform_role === 'superadmin'

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="px-6 py-4">
          <h1 className="text-2xl font-bold text-foreground">System Intelligence</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor system health, provider integrations, and operational status
          </p>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Command Strip - Full Width Priority Actions */}
        <SystemCommandStrip brokerageId={brokerageId} />

        {/* Main Intelligence Grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Column 1: Provider & Sync Health */}
          <div className="space-y-6">
            <ProviderHealthPanel brokerageId={brokerageId} />
            {/* Providers answer "which vendors are live"; this answers the question a
                broker actually asks before switching autonomy on — what the agents can
                DO. Same resolver the MCP tool list uses, so screen and tool list agree. */}
            <AgentCapabilityPanel brokerageId={brokerageId} />
            {/* Capabilities say what the team CAN do; this says what the providers
                CONFIRMED it did. The gap between them is the only honest measure of
                whether autonomy can be trusted. */}
            <OutcomeProofPanel brokerageId={brokerageId} />
            <SyncHealthPanel brokerageId={brokerageId} />
          </div>

          {/* Column 2: Observability & AI Quality */}
          <div className="space-y-6">
            <ObservabilityPanel brokerageId={brokerageId} />
            <AIQualityPanel brokerageId={brokerageId} />
            {/* Video is the OS's most expensive output. This says how much of it was
                delivered WITHOUT re-rendering, and names the compositions whose inputs
                make reuse impossible — the same finding the Asset Manager gets on the
                bus, put where a broker can see a fix is pending. */}
            <RenderCachePanel brokerageId={brokerageId} />
            {/* The cache made a render reusable by giving it an identity. The same
                technique, pointed at a narrower set of inputs, gives a DELIVERED
                video an identity too — and an identity you can recompute is one
                you can check. This is what the OS is telling clients right now. */}
            <LivingVideoPanel brokerageId={brokerageId} />
          </div>

          {/* Column 3: Alerts & Impact */}
          <div className="space-y-6">
            <SystemAlertsPanel brokerageId={brokerageId} />
            <OperationalImpactPanel brokerageId={brokerageId} />
            {/* Impact says WHO is affected right now. This says what the
                providers actually delivered and how long each service has been
                up — and, where nothing was ever collected, says exactly that
                instead of drawing a 100% line through an empty table. */}
            <ServiceSLAPanel brokerageId={brokerageId} />
          </div>
        </div>

        {/* Database Schema Readiness — full width below the grid */}
        <SchemaReadinessPanel brokerageId={brokerageId} />

        {/* Footer Note */}
        <div className="text-center text-xs text-muted-foreground pt-4 border-t border-border">
          <p>
            This dashboard shows brokerage-level system health.
            {isSuperadmin && (
              <span className="ml-1">
                For full observability access, visit{' '}
                <a 
                  href="/dashboard/superadmin/observability" 
                  className="text-primary hover:underline"
                >
                  Superadmin Observability
                </a>
              </span>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
