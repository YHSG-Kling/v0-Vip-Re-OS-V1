import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getComplianceViolations } from '@/app/actions/compliance-monitoring'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AlertTriangle, CheckCircle2, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function ComplianceViolationsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const violations = await getComplianceViolations()

  const severityColor: Record<string, string> = {
    high: 'bg-red-100 text-red-700 border-red-200',
    medium: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    low: 'bg-blue-100 text-blue-700 border-blue-200',
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/compliance">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-red-600" />
            Compliance Violations
          </h1>
          <p className="text-gray-500 text-sm">{violations.length} violation{violations.length !== 1 ? 's' : ''} found</p>
        </div>
      </div>

      {violations.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12">
            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
            <p className="text-lg font-medium text-green-700">No Active Violations</p>
            <p className="text-sm text-gray-500 mt-1">All communications are compliant</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {violations.map((v: any) => (
            <Card key={v.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-medium">{v.violation_type || 'Compliance Violation'}</p>
                      <Badge className={severityColor[v.severity] || severityColor.medium}>
                        {v.severity || 'medium'}
                      </Badge>
                    </div>
                    <p className="text-sm text-gray-600">{v.description || 'No description available'}</p>
                    <p className="text-xs text-gray-400 mt-1">{new Date(v.created_at).toLocaleDateString()}</p>
                  </div>
                  <Badge variant={v.status === 'resolved' ? 'outline' : 'destructive'}>
                    {v.status || 'open'}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
