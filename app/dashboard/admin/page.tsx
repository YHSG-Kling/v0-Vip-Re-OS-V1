import { getAgentContext } from '@/lib/identity/get-agent-context'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AdminDashboardClient } from './admin-dashboard-client'

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
  const context = await getAgentContext()

  if (!context?.brokerageId) {
    redirect('/login')
  }

  // Verify user has admin role
  if (context.role !== 'admin' && context.role !== 'broker') {
    redirect('/dashboard')
  }

  const brokerageId = context.brokerageId
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

  return (
    <AdminDashboardClient
      brokerageId={brokerageId}
      operationalSnapshot={operationalSnapshot}
    />
  )
}
