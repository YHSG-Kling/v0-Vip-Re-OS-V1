import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getQualificationOutcomes } from '@/app/actions/ai-isa'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { BarChart3, ArrowLeft, TrendingUp, Phone, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function ISAAnalyticsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('users').select('brokerage_id').eq('id', user.id).single()

  let outcomes: any = { totalQualified: 0, totalContacted: 0, conversionRate: 0 }
  if (profile?.brokerage_id) {
    try { outcomes = await getQualificationOutcomes(profile.brokerage_id) || outcomes } catch {}
  }

  const conversionRate = outcomes.totalContacted > 0
    ? Math.round((outcomes.totalQualified / outcomes.totalContacted) * 100)
    : 0

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/isa"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-purple-600" />
            ISA Analytics
          </h1>
          <p className="text-gray-500 text-sm">Qualification performance and conversion tracking</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Contacted', value: outcomes.totalContacted || 0, icon: Phone, color: 'text-blue-600' },
          { label: 'Leads Qualified', value: outcomes.totalQualified || 0, icon: CheckCircle2, color: 'text-green-600' },
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

      <Card>
        <CardHeader><CardTitle className="text-base">Performance by Outcome</CardTitle></CardHeader>
        <CardContent>
          {outcomes.byOutcome ? (
            <div className="space-y-2">
              {Object.entries(outcomes.byOutcome).map(([outcome, count]: any) => (
                <div key={outcome} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                  <span className="text-sm capitalize">{outcome.replace(/_/g, ' ')}</span>
                  <span className="text-sm font-semibold">{count}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 text-center py-8">Detailed analytics will populate as calls are completed</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
