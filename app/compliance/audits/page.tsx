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
      {/* ── Your AI team's read ──────────────────────────────────────────────
          An audit log is evidence, and evidence needs a summary an auditor can
          act on: what's compliance-relevant, what's driving the volume, whether
          changes concentrate in one pair of hands, and — critically — how much
          time the capped window actually covers. Deterministic over the same
          rows listed below. Signal ownership: the audit ledger is the
          compliance_officer's domain (lib/kernel/manager-registry.ts). */}
      {(() => {
        const events = auditEvents ?? []
        const reads: Array<{ severity: "urgent" | "warn" | "good"; text: string }> = []

        if (events.length === 0) {
          reads.push({ severity: "good", text: "No audit events recorded yet — this ledger fills as governance-relevant changes happen." })
        } else {
          // The capped window is a real evidentiary limitation — say it plainly.
          const oldest = events[events.length - 1]
          const spanHours = Math.max(1, Math.round((Date.now() - new Date(oldest.created_at).getTime()) / 3_600_000))
          if (events.length >= 100) {
            reads.push({
              severity: "warn",
              text: spanHours < 48
                ? `These 100 events cover only the last ${spanHours} hour${spanHours === 1 ? "" : "s"} — the ledger is busier than this page can show, so anything older is off-screen. Export before relying on this view for an audit.`
                : `Showing the most recent 100 events, covering ~${Math.round(spanHours / 24)} days. Older history exists beyond this window.`,
            })
          }

          const complianceCount = events.filter((e: any) =>
            e.compliance_relevant || (e.after ?? {})?.compliance_relevant).length
          if (complianceCount > 0) {
            reads.push({
              severity: "warn",
              text: `${complianceCount} of ${events.length} event${events.length === 1 ? "" : "s"} ${complianceCount === 1 ? "is" : "are"} flagged compliance-relevant — these are the rows an auditor will ask about first.`,
            })
          }

          const byAction = new Map<string, number>()
          const byActor = new Map<string, number>()
          for (const e of events as any[]) {
            byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1)
            if (e.user_id) byActor.set(e.user_id, (byActor.get(e.user_id) ?? 0) + 1)
          }
          const [topAction, topActionCount] = [...byAction.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0]
          if (topActionCount >= 3 && byAction.size > 1) {
            reads.push({
              severity: "good",
              text: `Most frequent change: ${ACTION_LABELS[topAction] ?? topAction} (${topActionCount}× in this window) — that's what's driving the volume.`,
            })
          }
          const [, topActorCount] = [...byActor.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0]
          if (byActor.size > 1 && topActorCount / events.length >= 0.7) {
            reads.push({
              severity: "warn",
              text: `One account made ${Math.round((topActorCount / events.length) * 100)}% of the changes in this window — worth confirming that concentration is intended (segregation of duties).`,
            })
          }
        }

        const STYLE: Record<string, string> = {
          urgent: "border-red-200 bg-red-50/60", warn: "border-amber-200 bg-amber-50/60", good: "border-emerald-200 bg-emerald-50/60",
        }
        const DOT: Record<string, string> = { urgent: "bg-red-500", warn: "bg-amber-500", good: "bg-emerald-500" }

        return (
          <Card className="border-indigo-200">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Your AI team&apos;s read</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {reads.map((r, i) => (
                <div key={i} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${STYLE[r.severity]}`}>
                  <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${DOT[r.severity]}`} />
                  <p className="text-sm leading-relaxed">{r.text}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        )
      })()}

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
