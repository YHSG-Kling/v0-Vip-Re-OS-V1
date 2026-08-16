import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { readRoleGrants, selectVendorId } from '@/lib/auth/role-grants'
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
import { VENDOR_CATEGORY_TITLE } from "@/lib/kernel/vendor-categories"
import { getTitleTransactionDetail } from '@/app/actions/title-portal'

export const dynamic = 'force-dynamic'

export default async function TitleDashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get title company/vendor ID for this user (canonical linkage via
  // user_role_assignments). Not in the reported list but the identical shape:
  // narrowing to the vendor-bearing grants still leaves several rows possible,
  // because the table is UNIQUE on (user_id, role) and not on user_id.
  const grantsResult = await readRoleGrants(supabase, user.id)
  if (!grantsResult.ok) {
    console.error('[title/dashboard] role grant read failed:', grantsResult.error)
  }
  const { vendorId: titleVendorId } = grantsResult.ok
    ? selectVendorId(grantsResult.grants)
    : { vendorId: null }

  const { data: vendor } = titleVendorId
    ? await supabase
        .from('vendors')
        .select('id')
        .eq('id', titleVendorId)
        .eq('category', VENDOR_CATEGORY_TITLE)
        .maybeSingle()
    : { data: null }

  // This used to be `vendor?.id || user.id`. Those are different id spaces —
  // every panel below passes this value as `vendor_id`, an FK to vendors(id),
  // so an auth user id matched no rows at all. The page rendered a complete,
  // entirely empty title dashboard and looked like a company with no work.
  // No fallback: without a linked vendor there is nothing honest to show.
  const titleCompanyId = vendor?.id ?? null

  const { data: transactions } = await supabase
    .from('transactions')
    .select('id, property_address, status, close_date, client_name, transaction_type:deal_type')
    .order('close_date', { ascending: true })
    .limit(20)

  const upcoming = (transactions || []).filter((t: any) => {
    if (!t.close_date) return false
    const closeDate = new Date(t.close_date)
    const now = new Date()
    const diff = (closeDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    return diff >= 0 && diff <= 14
  })

  // The doc-status and batch panels at the bottom of this page were mounted on
  // hardcoded [] — they rendered forever-empty while getTitleTransactionDetail
  // already returned this title company's documents and title-visible milestones.
  // The loader's identity rail is title_company_users (that is the row
  // requireTitleActor checks); the `vendors` row resolved above is the marketplace
  // profile, not a title-portal identity, so it cannot be passed here. Each
  // title_company_users row is scoped to one transaction.
  const { data: titleUserRows } = await supabase
    .from('title_company_users')
    .select('id, transaction_id')
    .eq('user_id', user.id)
    .not('transaction_id', 'is', null)
    .limit(10)

  const titleDetails = await Promise.all(
    ((titleUserRows || []) as any[]).map(async (row) => {
      try {
        return await getTitleTransactionDetail(row.transaction_id, row.id)
      } catch {
        // Throws when the title company is not assigned to that transaction (or the
        // user has no brokerage). One unassigned deal contributes nothing instead of
        // failing the whole dashboard.
        return null
      }
    })
  )

  // Documents come back already aliased by the loader (file_name ← doc_label,
  // file_url ← storage_url). Every row is a document that exists in storage, so
  // 'uploaded' is the honest status — the loader does not select
  // transaction_documents.status, and nothing models per-doc requiredness, so
  // `required` stays false rather than inventing a checklist.
  const titleDocuments = titleDetails.flatMap((d) =>
    ((d?.documents || []) as any[]).map((doc) => ({
      id: doc.id,
      name: doc.file_name || doc.document_type,
      type: doc.document_type,
      status: 'uploaded' as const,
      required: false,
      uploadedAt: doc.created_at,
      fileUrl: doc.file_url || undefined,
    }))
  )

  // Batch items are the same loader's title-visible milestones. transaction_milestones
  // has no "ready" state, so a milestone is either completed or still pending.
  const titleBatchItems = titleDetails.flatMap((d) =>
    ((d?.milestones || []) as any[]).map((m) => ({
      id: m.id,
      label: m.milestone_name,
      type: 'milestone' as const,
      status: (m.status === 'completed' ? 'completed' : 'pending') as 'completed' | 'pending',
      relatedId: (d?.transaction as any)?.id,
    }))
  )

  if (!titleCompanyId) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-2">Title Dashboard</h1>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-700">
              This account is not linked to a title company yet, so there are no
              orders or files to show. A brokerage admin links a title company to
              your login from the vendor directory.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

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
        <ExternalDocStatusPanel partnerType="title" partnerId={titleCompanyId} documents={titleDocuments} />
      </div>

      <ExternalBatchActionsPanel partnerType="title" items={titleBatchItems} />

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
