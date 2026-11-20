import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { generateComplianceReport } from '@/app/actions/compliance-monitoring'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { TrendingUp, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { ExportComplianceReportButton } from './export-report-button'

export const dynamic = 'force-dynamic'

export default async function ComplianceReportsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const today = new Date()
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
  const startDate = thirtyDaysAgo.toISOString()
  const endDate = today.toISOString()

  const report = await generateComplianceReport({ startDate, endDate })

  // When a source could not be read, every number below is a floor over what
  // did load — a 100% rate computed from an unreadable log is the one number
  // this page must never show without saying so.
  const unreadable: string[] = (report as any).unreadableSources ?? []

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
        {/* Downloads the SAME report object rendered below — no second
            generation path, so the file cannot disagree with the page. */}
        <ExportComplianceReportButton report={report} startDate={startDate} endDate={endDate} />
      </div>

      {unreadable.length > 0 && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-4">
            <p className="text-sm font-medium text-amber-900">
              This report is incomplete — {unreadable.join('; ')}
            </p>
            <p className="text-xs text-amber-800 mt-1">
              The figures below cover only the records that loaded. Do not treat
              them as a compliance finding until the source above is readable.
            </p>
          </CardContent>
        </Card>
      )}

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
