import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Eye, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

// Friendly labels for governance-relevant audit actions (falls back to the raw
// action string for everything else — the surface stays generic).
const ACTION_LABELS: Record<string, string> = {
  voice_access_expanded_roles_changed: 'Voice assistant access — expanded staff roles changed',
  regional_convention_review_completed: 'Regional closing-cost conventions — yearly review completed',
}

export default async function ComplianceAuditsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // pass 14: unified_audit_events was a PHANTOM table — the page now reads the
  // real audit_log ledger (action / entity_type / user_id / created_at).
  const { data: auditEvents } = await supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/compliance">
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
            ) : auditEvents.map((event: any) => {
              const after = (event.after ?? {}) as Record<string, any>
              const granted: string[] = Array.isArray(after.granted) ? after.granted : []
              const revoked: string[] = Array.isArray(after.revoked) ? after.revoked : []
              const isVoiceAccess = event.action === 'voice_access_expanded_roles_changed'
              return (
                <div key={event.id} className="p-4 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{ACTION_LABELS[event.action] ?? event.action}</p>
                    <p className="text-xs text-gray-500">{event.entity_type} · {event.user_id?.slice(0, 8)}...</p>
                    {/* Voice-expansion audit trail: the roles granted/revoked, from the event itself. */}
                    {isVoiceAccess && (granted.length > 0 || revoked.length > 0) && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {granted.map((r) => (
                          <Badge key={`g-${r}`} className="bg-emerald-100 text-emerald-700 border-emerald-200 text-xs">
                            granted: {String(r).replace(/_/g, ' ')}
                          </Badge>
                        ))}
                        {revoked.map((r) => (
                          <Badge key={`r-${r}`} className="bg-red-100 text-red-700 border-red-200 text-xs">
                            revoked: {String(r).replace(/_/g, ' ')}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <p className="text-xs text-gray-400">{new Date(event.created_at).toLocaleString()}</p>
                  </div>
                  {(event.compliance_relevant || after.compliance_relevant) && (
                    <Badge className="bg-purple-100 text-purple-700 border-purple-200 text-xs">Compliance</Badge>
                  )}
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
