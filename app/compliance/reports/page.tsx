import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { generateComplianceReport } from '@/app/actions/compliance-monitoring'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TrendingUp, ArrowLeft, Download, CheckCircle2, AlertTriangle, Eye } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function ComplianceReportsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const today = new Date()
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)

  const report = await generateComplianceReport({
    startDate: thirtyDaysAgo.toISOString(),
    endDate: today.toISOString(),
  })

  const complianceRate =
    report.totalCommunications > 0
      ? Math.round((report.compliantCommunications / report.totalCommunications) * 100)
      : 100

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/compliance">
            <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <TrendingUp className="w-6 h-6 text-green-600" />
              Compliance Reports
            </h1>
            <p className="text-gray-500 text-sm">30-day compliance summary</p>
          </div>
        </div>
        <Button variant="outline" size="sm">
          <Download className="w-4 h-4 mr-2" />
          Export Report
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className={`text-3xl font-bold ${complianceRate >= 90 ? 'text-green-600' : 'text-red-600'}`}>{complianceRate}%</p>
            <p className="text-xs text-gray-500 mt-1">Compliance Rate</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-3xl font-bold text-blue-600">{report.totalCommunications}</p>
            <p className="text-xs text-gray-500 mt-1">Total Reviewed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-3xl font-bold text-green-600">{report.compliantCommunications}</p>
            <p className="text-xs text-gray-500 mt-1">Compliant</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-3xl font-bold text-red-600">
              {report.totalCommunications - report.compliantCommunications}
            </p>
            <p className="text-xs text-gray-500 mt-1">Flagged</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Full Compliance Center</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-500 mb-3">For the complete compliance dashboard with content submission, approval workflows, and transaction compliance tracking:</p>
          <Link href="/dashboard/compliance">
            <Button className="bg-blue-600 hover:bg-blue-700 text-white">
              Open Full Compliance Center
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
