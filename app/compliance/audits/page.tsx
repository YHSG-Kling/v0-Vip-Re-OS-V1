import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Eye, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function ComplianceAuditsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: auditEvents } = await supabase
    .from('unified_audit_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/compliance/dashboard">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Eye className="w-6 h-6 text-purple-600" />
            Audit Logs
          </h1>
          <p className="text-gray-500 text-sm">All platform audit events (last 100)</p>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="divide-y">
            {(!auditEvents || auditEvents.length === 0) ? (
              <div className="text-center py-8 text-gray-500">No audit events found</div>
            ) : auditEvents.map((event: any) => (
              <div key={event.id} className="p-4 flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{event.action}</p>
                  <p className="text-xs text-gray-500">{event.entity_type} · {event.user_id?.slice(0, 8)}...</p>
                  <p className="text-xs text-gray-400">{new Date(event.created_at).toLocaleString()}</p>
                </div>
                {event.compliance_relevant && (
                  <Badge className="bg-purple-100 text-purple-700 border-purple-200 text-xs">Compliance</Badge>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
