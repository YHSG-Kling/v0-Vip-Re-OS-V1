import { getAgentContext } from '@/lib/identity/get-agent-context'
import { redirect } from 'next/navigation'
import {
  SystemCommandStrip,
  ProviderHealthPanel,
  ObservabilityPanel,
  AIQualityPanel,
  SyncHealthPanel,
  SystemAlertsPanel,
  OperationalImpactPanel,
  SchemaReadinessPanel,
} from './components/os'

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
  if (!['admin', 'broker', 'superadmin'].includes(context.role)) {
    redirect('/dashboard')
  }

  const { brokerageId } = context

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
            <SyncHealthPanel brokerageId={brokerageId} />
          </div>

          {/* Column 2: Observability & AI Quality */}
          <div className="space-y-6">
            <ObservabilityPanel brokerageId={brokerageId} />
            <AIQualityPanel brokerageId={brokerageId} />
          </div>

          {/* Column 3: Alerts & Impact */}
          <div className="space-y-6">
            <SystemAlertsPanel brokerageId={brokerageId} />
            <OperationalImpactPanel brokerageId={brokerageId} />
          </div>
        </div>

        {/* Database Schema Readiness — full width below the grid */}
        <SchemaReadinessPanel brokerageId={brokerageId} />

        {/* Footer Note */}
        <div className="text-center text-xs text-muted-foreground pt-4 border-t border-border">
          <p>
            This dashboard shows brokerage-level system health.
            {context.role === 'superadmin' && (
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
