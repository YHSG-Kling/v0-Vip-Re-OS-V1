import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getPendingApprovals, getComplianceViolations, generateComplianceReport } from '@/app/actions/compliance-monitoring'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Shield, AlertTriangle, CheckCircle2, FileText, TrendingUp, Eye } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function ComplianceDashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const today = new Date()
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [pendingApprovals, violations, monthlyReport] = await Promise.all([
    getPendingApprovals(),
    getComplianceViolations(),
    generateComplianceReport({
      startDate: thirtyDaysAgo.toISOString(),
      endDate: today.toISOString(),
    }),
  ])

  const complianceRate =
    monthlyReport.totalCommunications > 0
      ? Math.round((monthlyReport.compliantCommunications / monthlyReport.totalCommunications) * 100)
      : 100

  const stats = [
    { label: 'Compliance Rate', value: `${complianceRate}%`, icon: Shield, color: complianceRate >= 90 ? 'text-green-600' : 'text-red-600' },
    { label: 'Pending Approvals', value: pendingApprovals.length, icon: CheckCircle2, color: 'text-blue-600' },
    { label: 'Active Violations', value: violations.length, icon: AlertTriangle, color: violations.length > 0 ? 'text-red-600' : 'text-green-600' },
    { label: 'Total Reviewed', value: monthlyReport.totalCommunications, icon: Eye, color: 'text-purple-600' },
  ]

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-blue-600" />
            Compliance Dashboard
          </h1>
          <p className="text-gray-500 text-sm mt-1">Monitor, audit, and enforce compliance across all communications</p>
        </div>
        <Link href="/compliance/reports">
          <Button variant="outline" size="sm">
            <TrendingUp className="w-4 h-4 mr-2" />
            Generate Report
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
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
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-blue-600" />
              Pending Approvals ({pendingApprovals.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pendingApprovals.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">All caught up</p>
            ) : (
              <div className="space-y-2">
                {pendingApprovals.slice(0, 5).map((item: any) => (
                  <div key={item.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium">{item.content_type || 'Content'}</p>
                      <p className="text-xs text-gray-500">{new Date(item.created_at).toLocaleDateString()}</p>
                    </div>
                    <Badge variant="outline">{item.status}</Badge>
                  </div>
                ))}
                {pendingApprovals.length > 5 && (
                  <Link href="/compliance/violations" className="text-xs text-blue-600 hover:underline block text-center mt-2">
                    View all {pendingApprovals.length} items
                  </Link>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600" />
              Recent Violations ({violations.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {violations.length === 0 ? (
              <p className="text-sm text-green-600 text-center py-4 font-medium">No active violations</p>
            ) : (
              <div className="space-y-2">
                {violations.slice(0, 5).map((v: any) => (
                  <div key={v.id} className="flex items-center justify-between p-2 bg-red-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium">{v.violation_type || 'Violation'}</p>
                      <p className="text-xs text-gray-500">{new Date(v.created_at).toLocaleDateString()}</p>
                    </div>
                    <Badge className="bg-red-100 text-red-700 border-red-200">
                      {v.severity || 'medium'}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Navigation</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {[
              { label: 'Violations', href: '/compliance/violations', icon: AlertTriangle },
              { label: 'Audit Logs', href: '/compliance/audits', icon: Eye },
              { label: 'Policies', href: '/compliance/policies', icon: FileText },
              { label: 'Reports', href: '/compliance/reports', icon: TrendingUp },
              { label: 'Full Compliance', href: '/dashboard/compliance', icon: Shield },
              { label: 'Approvals Queue', href: '/approvals', icon: CheckCircle2 },
            ].map((item) => (
              <Link key={item.href} href={item.href}>
                <Button variant="outline" className="w-full justify-start" size="sm">
                  <item.icon className="w-4 h-4 mr-2" />
                  {item.label}
                </Button>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
