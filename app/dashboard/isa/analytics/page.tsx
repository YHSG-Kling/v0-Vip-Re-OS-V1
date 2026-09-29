import { redirect } from 'next/navigation'
import { getAgentContext } from '@/lib/identity'
import { getQualificationOutcomes } from '@/app/actions/ai-isa'
import { getSpeedToLeadMetrics } from '@/app/actions/ai-isa/speed-to-lead-metrics'
import { IsaProofNumbersStrip } from '../components/speed-to-lead-panel'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { BarChart3, ArrowLeft, TrendingUp, Phone, CheckCircle2, Zap } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function ISAAnalyticsPage() {
  // Kernel OS: getAgentContext — canonical identity
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect('/login')

  // Lane 90C: this page read `outcomes.totalContacted` / `totalQualified` /
  // `byOutcome` — fields getQualificationOutcomes has never returned (it returns
  // `outcomes[]`, `stats`, `chartData`), so every tile rendered 0 forever and
  // "Detailed analytics will populate as calls are completed" was permanent. The
  // reader's real shape is used now, and the three proof numbers ride the same
  // strip the console and the Intelligence Center show.
  const emptyStats = { qualified: 0, not_qualified: 0, appointment_set: 0, no_response: 0, needs_follow_up: 0 }
  let outcomes: Awaited<ReturnType<typeof getQualificationOutcomes>> = { success: false, outcomes: [], stats: emptyStats, chartData: [] }
  let speedToLead: Awaited<ReturnType<typeof getSpeedToLeadMetrics>> | null = null
  let readError: string | null = null
  if (ctx.brokerageId) {
    const [q, s] = await Promise.all([
      getQualificationOutcomes(ctx.brokerageId).catch((e: unknown) => ({ ...outcomes, error: (e as Error)?.message ?? 'refused' })),
      getSpeedToLeadMetrics(ctx.brokerageId).catch(() => null),
    ])
    outcomes = q
    speedToLead = s
    if (q.error) readError = q.error
  }

  const totalContacted = outcomes.outcomes.length
  const totalQualified = outcomes.stats.qualified + outcomes.stats.appointment_set
  const conversionRate = totalContacted > 0 ? Math.round((totalQualified / totalContacted) * 100) : 0

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/isa"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-purple-600" />
            ISA Analytics
          </h1>
          <p className="text-gray-500 text-sm">Qualification performance and conversion tracking · last 30 days</p>
        </div>
      </div>

      {readError && (
        <p className="text-sm text-amber-700">The qualification ledger refused to read: {readError}. The tiles below are partial.</p>
      )}

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Contacted', value: totalContacted, icon: Phone, color: 'text-blue-600' },
          { label: 'Leads Qualified', value: totalQualified, icon: CheckCircle2, color: 'text-green-600' },
          { label: 'Conversion Rate', value: `${conversionRate}%`, icon: TrendingUp, color: 'text-orange-600' },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4 text-center">
              <stat.icon className={`w-8 h-8 ${stat.color} mx-auto mb-2`} />
              <p className="text-3xl font-bold">{stat.value}</p>
              <p className="text-xs text-gray-500 mt-1">{stat.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {speedToLead && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="w-4 h-4 text-indigo-600" />
              Proof numbers
              <span className="text-xs font-normal text-muted-foreground">response rate · connect rate · days of follow-up</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <IsaProofNumbersStrip proof={speedToLead.proof} refused={speedToLead.refused} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Performance by Outcome</CardTitle></CardHeader>
        <CardContent>
          {totalContacted > 0 ? (
            <div className="space-y-2">
              {Object.entries(outcomes.stats).map(([outcome, count]) => (
                <div key={outcome} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                  <span className="text-sm capitalize">{outcome.replace(/_/g, ' ')}</span>
                  <span className="text-sm font-semibold">{count}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 text-center py-8">No qualification outcomes in the last 30 days yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
