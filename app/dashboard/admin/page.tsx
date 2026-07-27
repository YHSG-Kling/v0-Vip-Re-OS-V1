import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AdminDashboardClient } from './admin-dashboard-client'
import { ProvisioningHealthPanel } from './components/provisioning-health-panel'
import { LicenseExpiryPanel } from './components/os/license-expiry-panel'
import { TenantSafetyWidget } from './components/tenant-safety-widget'
import { RevenueProtectionRollupWidget } from './components/revenue-protection-rollup-widget'
import { BrokerageIntelligenceWidget } from './components/brokerage-intelligence-widget'
import WorkflowReportsWidget from './components/workflow-reports-widget'
import { getBrokerageAgentLicenseStatuses } from '@/app/actions/admin/license-tracking'

// Force dynamic rendering to prevent build-time prerendering errors
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Brokerage Command Center | Admin Dashboard',
  description: 'Real-time operations intelligence and brokerage management',
}

export type OperationalSnapshot = {
  aiIsaActiveLeads: number
  listingsReadyToLaunch: number
  transactionsStalled: number
  pendingCommissions: number
  failedPublishes: number
  degradedProviders: string[]
}

export default async function AdminPage() {
  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const context = await ensureAgentContextInPlace()

  // Verify user is authenticated
  if (!context?.isAuthenticated) {
    redirect('/login')
  }

  // Verify user has admin/broker/superadmin role
  const allowedRoles = ['admin', 'superadmin', 'broker', 'broker_admin']
  if (!allowedRoles.includes(context.userType)) {
    redirect('/dashboard')
  }

  // For admins without a specific brokerage, query the first available brokerage
  let brokerageId = context.brokerageId
  if (!brokerageId) {
    const supabaseTemp = await createClient()
    const { data: firstBrokerage } = await supabaseTemp
      .from('brokerages')
      .select('id')
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    brokerageId = firstBrokerage?.id ?? null
  }

  if (!brokerageId) {
    redirect('/dashboard/agent')
  }
  const supabase = await createClient()
  const stalledCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [
    aiIsaLeads,
    listingsReady,
    txStalled,
    pendingCommissions,
    failedPublishes,
    degradedProviders,
  ] = await Promise.all([
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .eq('ai_isa_owner', true)
      .eq('is_active', true)
      .eq('ai_outreach_paused', false),
    supabase
      .from('listings')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .in('lifecycle_stage', ['launch_ready', 'prep', 'intake']),
    supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .eq('status', 'active')
      .lt('updated_at', stalledCutoff),
    supabase
      .from('commission_distributions')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .neq('status', 'paid'),
    supabase
      .from('social_posts')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .eq('status', 'failed'),
    supabase
      .from('integration_credentials')
      .select('provider_name')
      .eq('brokerage_id', brokerageId)
      .eq('is_active', false),
  ])

  const operationalSnapshot: OperationalSnapshot = {
    aiIsaActiveLeads:     aiIsaLeads.count      ?? 0,
    listingsReadyToLaunch: listingsReady.count   ?? 0,
    transactionsStalled:  txStalled.count        ?? 0,
    pendingCommissions:   pendingCommissions.count ?? 0,
    failedPublishes:      failedPublishes.count  ?? 0,
    degradedProviders:    (degradedProviders.data ?? []).map((r) => r.provider_name as string),
  }

  const { agents: licenseAgents } = await getBrokerageAgentLicenseStatuses(brokerageId)

  return (
    <>
      <AdminDashboardClient
        brokerageId={brokerageId}
        operationalSnapshot={operationalSnapshot}
      />
      <div className="px-6 pb-6 space-y-6">
        <RevenueProtectionRollupWidget brokerageId={brokerageId} />
        <BrokerageIntelligenceWidget />
        <TenantSafetyWidget />
        <WorkflowReportsWidget brokerageId={brokerageId} />
        <LicenseExpiryPanel agents={licenseAgents} />
        <ProvisioningHealthPanel brokerageId={brokerageId} />
      </div>
    </>
  )
}
