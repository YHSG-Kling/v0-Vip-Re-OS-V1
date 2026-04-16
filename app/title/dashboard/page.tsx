import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FileCheck, Clock, Calendar, Package, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'
import { TitleCommandStrip, TitleOperationsPanel } from '../components/os'
import {
  ExternalPartnerCommandStrip,
  ExternalActiveFilesPanel,
  ExternalDocStatusPanel,
  ExternalBatchActionsPanel,
} from '../../(external-portal)/components/os'

export const dynamic = 'force-dynamic'

export default async function TitleDashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get title company/vendor ID for this user
  const { data: vendor } = await supabase
    .from('vendors')
    .select('id')
    .eq('user_id', user.id)
    .eq('category', 'title')
    .maybeSingle()

  const titleCompanyId = vendor?.id || user.id

  const { data: transactions } = await supabase
    .from('transactions')
    .select('id, property_address, status, close_date, client_name, transaction_type')
    .order('close_date', { ascending: true })
    .limit(20)

  const upcoming = (transactions || []).filter((t: any) => {
    if (!t.close_date) return false
    const closeDate = new Date(t.close_date)
    const now = new Date()
    const diff = (closeDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    return diff >= 0 && diff <= 14
  })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Title Dashboard</h1>
          <p className="text-gray-500 text-sm">Title orders and closing management</p>
        </div>
        <Link href="/title/orders"><Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white">View Orders</Button></Link>
      </div>

      {/* OS Command Strip */}
      <TitleCommandStrip titleCompanyId={titleCompanyId} />
      <ExternalPartnerCommandStrip partnerType="title" partnerId={titleCompanyId} />

      {/* OS Panel + Stats Grid */}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <TitleOperationsPanel titleCompanyId={titleCompanyId} />
        </div>
        <div className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: 'Total Orders', value: transactions?.length || 0, icon: Package, color: 'text-blue-600' },
              { label: 'Closing This Week', value: upcoming.length, icon: Calendar, color: 'text-orange-600' },
              { label: 'Pending', value: (transactions || []).filter((t: any) => t.status === 'pending').length, icon: Clock, color: 'text-yellow-600' },
              { label: 'Completed', value: (transactions || []).filter((t: any) => t.status === 'closed').length, icon: CheckCircle2, color: 'text-green-600' },
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
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Upcoming Closings (Next 14 Days)</CardTitle></CardHeader>
        <CardContent>
          {upcoming.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-4">No closings in the next 14 days</p>
          ) : (
            <div className="space-y-2">
              {upcoming.map((t: any) => (
                <div key={t.id} className="flex items-center justify-between p-2 bg-orange-50 rounded-lg border border-orange-100">
                  <div>
                    <p className="text-sm font-medium">{t.property_address}</p>
                    <p className="text-xs text-gray-500">{t.client_name}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-semibold text-orange-600">{new Date(t.close_date).toLocaleDateString()}</p>
                    <Badge variant="outline" className="text-xs">{t.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* External Partner OS Panels */}
      <div className="grid lg:grid-cols-2 gap-6">
        <ExternalActiveFilesPanel partnerType="title" partnerId={titleCompanyId} files={upcoming.map((t: any) => ({
          id: t.id,
          transactionId: t.id,
          propertyAddress: t.property_address,
          clientName: t.client_name,
          status: t.status,
          closeDate: t.close_date,
          urgency: 'high',
          actionRequired: t.status === 'pending',
        }))} />
        <ExternalDocStatusPanel partnerType="title" partnerId={titleCompanyId} documents={[]} />
      </div>

      <ExternalBatchActionsPanel partnerType="title" items={[]} />

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Title Orders', href: '/title/orders' },
          { label: 'Order Status', href: '/title/status' },
          { label: 'Documents', href: '/title/documents' },
          { label: 'Closing Schedule', href: '/title/closing' },
          { label: 'Client Portal', href: '/portal/title' },
          { label: 'Settings', href: '/title/settings' },
        ].map((a) => (
          <Link key={a.href} href={a.href}>
            <Button variant="outline" size="sm" className="w-full">{a.label}</Button>
          </Link>
        ))}
      </div>
    </div>
  )
}
