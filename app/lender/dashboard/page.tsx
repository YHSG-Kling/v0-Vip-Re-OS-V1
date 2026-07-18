import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DollarSign, TrendingUp, CheckCircle2, Clock, FileCheck, AlertCircle } from 'lucide-react'
import Link from 'next/link'
import { LenderCommandStrip, LenderPipelinePanel } from '../components/os'
import { TodaysFocusCard } from '@/app/components/shell/todays-focus-card'
import { generateUserTypeBrief } from '@/lib/intelligence/user-type-briefs'
import {
  ExternalPartnerCommandStrip,
  ExternalActiveFilesPanel,
  ExternalDocStatusPanel,
  ExternalCommunicationPanel,
} from '../../(external-portal)/components/os'

export const dynamic = 'force-dynamic'

export default async function LenderDashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Lenders are vendors — resolve the caller's lender VENDOR, then the deals it's
  // assigned to (vendor_assignments).
  const { data: roleRows } = await supabase
    .from('user_role_assignments')
    .select('vendor_id, vendors!inner(id, name, brokerage_id, category)')
    .eq('user_id', user.id)
    .not('vendor_id', 'is', null)
  const { isLenderVendorCategory, lenderVendorTransactionIds, lenderFilterIds } =
    await import('@/lib/kernel/lender-linkage')
  const lenderVendor = ((roleRows ?? []) as any[]).map((r) => r.vendors).find((v) => v && isLenderVendorCategory(v.category))
  const lenderPortal = lenderVendor ? { id: lenderVendor.id, lender_company: lenderVendor.name, brokerage_id: lenderVendor.brokerage_id } : null
  const lenderId = lenderPortal?.id ?? user.id

  const txnIds = lenderFilterIds(lenderVendor ? await lenderVendorTransactionIds(supabase, lenderVendor.id, lenderVendor.brokerage_id) : [])
  const { data: transactions } = await supabase
    .from('transactions')
    .select('id, property_address, status, contract_price:purchase_price, client_name, close_date, transaction_type:deal_type')
    .in('id', txnIds)
    .order('created_at', { ascending: false })
    .limit(20)

  const active = (transactions || []).filter((t: any) => !['closed', 'cancelled'].includes(t.status))
  const closing = (transactions || []).filter((t: any) => t.status === 'pending')

  // Today's AI brief for this lender
  const lenderBrief = await generateUserTypeBrief({
    userType: 'lender',
    userId: user.id,
    brokerageId: lenderPortal?.brokerage_id ?? null,
  })

  return (
    <div className="p-6 space-y-6">
      <TodaysFocusCard brief={lenderBrief} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Lender Dashboard</h1>
          <p className="text-gray-500 text-sm">Loan pipeline and transaction overview</p>
        </div>
        <Link href="/lender/pipeline">
          <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white">View Pipeline</Button>
        </Link>
      </div>

      {/* OS Command Strip */}
      <LenderCommandStrip lenderId={lenderId} />
      <ExternalPartnerCommandStrip partnerType="lender" partnerId={lenderId} />

      {/* OS Panel + Stats Grid */}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <LenderPipelinePanel lenderId={lenderId} />
        </div>
        <div className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: 'Total in Pipeline', value: transactions?.length || 0, icon: TrendingUp, color: 'text-blue-600' },
              { label: 'Active Loans', value: active.length, icon: DollarSign, color: 'text-green-600' },
              { label: 'Closing Soon', value: closing.length, icon: Clock, color: 'text-orange-600' },
              { label: 'Pending Approvals', value: 0, icon: FileCheck, color: 'text-purple-600' },
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

      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Recent Transactions</CardTitle></CardHeader>
          <CardContent>
            {(!transactions || transactions.length === 0) ? (
              <p className="text-sm text-gray-500 text-center py-4">No transactions in pipeline</p>
            ) : (
              <div className="space-y-2">
                {transactions.slice(0, 5).map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium">{t.property_address || 'Address TBD'}</p>
                      <p className="text-xs text-gray-500">{t.client_name} · {t.transaction_type}</p>
                    </div>
                    <Badge variant="outline">{t.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Quick Actions</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {[
              { label: 'Loan Pipeline', href: '/lender/pipeline' },
              { label: 'Assigned Transactions', href: '/lender/transactions' },
              { label: 'Approvals', href: '/lender/approvals' },
              { label: 'Underwriting', href: '/lender/underwriting' },
              { label: 'Documents', href: '/lender/documents' },
            ].map((action) => (
              <Link key={action.href} href={action.href}>
                <Button variant="outline" size="sm" className="w-full">{action.label}</Button>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* External Partner OS Panels */}
      <div className="grid lg:grid-cols-2 gap-6">
        <ExternalActiveFilesPanel partnerType="lender" partnerId={lenderId} files={active.map((t: any) => ({
          id: t.id,
          transactionId: t.id,
          propertyAddress: t.property_address,
          clientName: t.client_name,
          status: t.status,
          closeDate: t.close_date,
          urgency: 'medium',
          actionRequired: false,
        }))} />
        <ExternalDocStatusPanel partnerType="lender" partnerId={lenderId} documents={[]} />
      </div>

      <ExternalCommunicationPanel partnerType="lender" partnerId={lenderId} messages={[]} />
    </div>
  )
}
