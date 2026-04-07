import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ShieldAlert, Building2, Users, Activity, CreditCard, Settings, TrendingUp, Eye } from 'lucide-react'
import Link from 'next/link'
import { getAgentContext } from '@/lib/identity'
import { toCanonicalRoleOrDefault } from '@/lib/security'

export const dynamic = 'force-dynamic'

export default async function PlatformAdminPage() {
  // Kernel OS: getAgentContext — canonical identity, never raw auth.getUser()
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect('/login')

  const userRole = toCanonicalRoleOrDefault(ctx.userType, 'agent')
  if (userRole !== 'superadmin') redirect('/dashboard/admin')

  const supabase = await createClient()

  const [brokeragesRes, usersRes] = await Promise.all([
    supabase.from('brokerages').select('id, name, status, created_at').order('created_at', { ascending: false }).limit(10),
    supabase.from('users').select('id', { count: 'exact', head: true }),
  ])

  const brokerages = brokeragesRes.data || []
  const totalUsers = usersRes.count || 0

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-red-600" />
            Platform Administration
          </h1>
          <p className="text-gray-500 text-sm">Superadmin — full platform control</p>
        </div>
        <Badge className="bg-red-100 text-red-700 border-red-200">Superadmin</Badge>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Brokerages', value: brokerages.length, icon: Building2, color: 'text-blue-600' },
          { label: 'Total Users', value: totalUsers, icon: Users, color: 'text-purple-600' },
          { label: 'System Status', value: 'Healthy', icon: Activity, color: 'text-green-600' },
          { label: 'Platform Tier', value: 'Enterprise', icon: CreditCard, color: 'text-orange-600' },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4 flex items-center gap-3">
              <stat.icon className={`w-8 h-8 ${stat.color}`} />
              <div>
                <p className="text-2xl font-bold">{stat.value}</p>
                <p className="text-xs text-gray-500">{stat.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Recent Brokerages</CardTitle></CardHeader>
          <CardContent>
            {brokerages.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">No brokerages yet</p>
            ) : (
              <div className="space-y-2">
                {brokerages.map((b: any) => (
                  <div key={b.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                    <p className="text-sm font-medium">{b.name}</p>
                    <Badge variant="outline" className="text-xs">{b.status || 'active'}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Platform Controls</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {[
              { label: 'Brokerages', href: '/admin/brokerages', icon: Building2 },
              { label: 'All Users', href: '/admin/users', icon: Users },
              { label: 'Billing Admin', href: '/admin/billing', icon: CreditCard },
              { label: 'Usage Metrics', href: '/admin/usage', icon: TrendingUp },
              { label: 'System Health', href: '/admin/system-health', icon: Activity },
              { label: 'AI Audit', href: '/admin/ai-audit', icon: Eye },
              { label: 'Integrations', href: '/admin/integrations', icon: Settings },
              { label: 'Global Settings', href: '/settings/global', icon: Settings },
            ].map((action) => (
              <Link key={action.href} href={action.href}>
                <Button variant="outline" size="sm" className="w-full justify-start text-xs">
                  <action.icon className="w-3 h-3 mr-1" />
                  {action.label}
                </Button>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
