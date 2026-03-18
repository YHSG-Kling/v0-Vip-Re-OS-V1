import { getAgentContext } from '@/lib/identity/get-agent-context'
import { redirect } from 'next/navigation'
import { AdminDashboardClient } from './admin-dashboard-client'

export const metadata = {
  title: 'Brokerage Command Center | Admin Dashboard',
  description: 'Real-time operations intelligence and brokerage management',
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

  return <AdminDashboardClient brokerageId={context.brokerageId} />
}
