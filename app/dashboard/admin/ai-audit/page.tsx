import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sparkles, Eye, CheckCircle2, TrendingUp } from 'lucide-react'
import Link from 'next/link'
import { getAgentContext } from '@/lib/identity'
import { toCanonicalRoleOrDefault } from '@/lib/security'

export const dynamic = 'force-dynamic'

export default async function AIAuditPage() {
  // Kernel OS: getAgentContext — canonical identity, never raw auth.getUser()
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect('/login')

  const userRole = toCanonicalRoleOrDefault(ctx.userType, 'agent')
  if (!['admin', 'superadmin', 'compliance_officer'].includes(userRole)) redirect('/dashboard')

  const supabase = await createClient()

  // Fetch AI quality metrics — ai_generated_content is the canonical AI output
  // log (ai_content_outputs was a writer-less legacy twin; same columns).
  const { data: aiOutputs } = await supabase
    .from('ai_generated_content')
    .select('id, content_type, compliance_approved, created_at, agent_id')
    .order('created_at', { ascending: false })
    .limit(50)

  const outputs = aiOutputs || []
  const total = outputs.length
  const approved = outputs.filter((o: any) => o.compliance_approved).length
  const pending = outputs.filter((o: any) => !o.compliance_approved).length
  const approvalRate = total > 0 ? Math.round((approved / total) * 100) : 0

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-purple-600" />
            AI Quality Audit
          </h1>
          <p className="text-gray-500 text-sm">Monitor AI output quality and compliance across all agents</p>
        </div>
        <Link href="/dashboard/ai-quality">
          <Button variant="outline" size="sm">Full AI Quality Dashboard</Button>
        </Link>
      </div>

      {/* ── Your AI team's read ──────────────────────────────────────────────
          The compliance question this page exists to answer isn't "what's the
          approval rate" — it's "what AI output went out that nobody reviewed,
          and how long has it been sitting." Deterministic over the same rows
          the cards below count. Signal ownership: AI output review is the
          compliance_officer's domain (lib/kernel/manager-registry.ts). */}
      {(() => {
        const unapproved = outputs.filter((o: any) => !o.compliance_approved)
        const reads: Array<{ severity: 'urgent' | 'warn' | 'good'; text: string }> = []

        if (total === 0) {
          reads.push({
            severity: 'good',
            text: 'No AI output logged yet — nothing to review. This surface fills as your AI team produces content.',
          })
        } else {
          if (unapproved.length > 0) {
            const oldest = unapproved.reduce((a: any, b: any) =>
              new Date(a.created_at) <= new Date(b.created_at) ? a : b)
            const ageDays = Math.floor((Date.now() - new Date(oldest.created_at).getTime()) / 86_400_000)
            reads.push({
              severity: ageDays >= 7 ? 'urgent' : 'warn',
              text: `${unapproved.length} AI output${unapproved.length === 1 ? '' : 's'} ${unapproved.length === 1 ? 'has' : 'have'} never been compliance-reviewed — the oldest is ${ageDays} day${ageDays === 1 ? '' : 's'} old. Unreviewed AI content is the regulatory exposure this desk exists to close.`,
            })
            // Which content type dominates the unreviewed pile — where to start.
            const byType = new Map<string, number>()
            for (const o of unapproved) {
              const t = (o as any).content_type ?? 'unknown'
              byType.set(t, (byType.get(t) ?? 0) + 1)
            }
            const [topType, topCount] = [...byType.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
            if (topCount >= 2 && byType.size > 1) {
              reads.push({
                severity: 'warn',
                text: `${topCount} of them are ${topType.replace(/_/g, ' ')} — reviewing that one type clears most of the backlog in a single pass.`,
              })
            }
          }
          if (approvalRate >= 90 && total >= 5) {
            reads.push({
              severity: 'good',
              text: `${approvalRate}% of AI output cleared compliance — the generation gates are holding, not just the review desk.`,
            })
          } else if (approvalRate < 60 && total >= 5) {
            reads.push({
              severity: 'urgent',
              text: `Only ${approvalRate}% cleared compliance — a low rate points upstream at the prompts/brand voice, not at the reviewers. Fix the generator and the queue shrinks itself.`,
            })
          }
        }

        const STYLE: Record<string, string> = {
          urgent: 'border-red-200 bg-red-50/60', warn: 'border-amber-200 bg-amber-50/60', good: 'border-emerald-200 bg-emerald-50/60',
        }
        const DOT: Record<string, string> = { urgent: 'bg-red-500', warn: 'bg-amber-500', good: 'bg-emerald-500' }

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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total AI Outputs', value: total, icon: Sparkles, color: 'text-purple-600' },
          { label: 'Compliance Approved', value: approved, icon: CheckCircle2, color: 'text-green-600' },
          { label: 'Pending Review', value: pending, icon: Eye, color: 'text-yellow-600' },
          { label: 'Approval Rate', value: `${approvalRate}%`, icon: TrendingUp, color: approvalRate >= 80 ? 'text-green-600' : 'text-red-600' },
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent AI Outputs</CardTitle>
          <CardDescription>Last 50 AI-generated content items</CardDescription>
        </CardHeader>
        <CardContent>
          {outputs.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No AI outputs recorded yet</p>
          ) : (
            <div className="space-y-2">
              {outputs.map((output: any) => (
                <div key={output.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{output.content_type || 'AI Content'}</p>
                    <p className="text-xs text-gray-500">{new Date(output.created_at).toLocaleString()}</p>
                  </div>
                  <Badge className={output.compliance_approved ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}>
                    {output.compliance_approved ? 'Approved' : 'Pending'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
