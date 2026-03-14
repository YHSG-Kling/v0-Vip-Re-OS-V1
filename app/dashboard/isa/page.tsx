import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { listISACampaigns, getQualificationOutcomes } from '@/app/actions/ai-isa'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Phone, Megaphone, Users, TrendingUp, PhoneCall, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function ISADashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users')
    .select('brokerage_id, first_name')
    .eq('id', user.id)
    .single()

  let campaigns: any[] = []
  let qualOutcomes: any = { totalQualified: 0, totalContacted: 0 }

  if (profile?.brokerage_id) {
    try {
      const [campaignResult, qual] = await Promise.all([
        listISACampaigns(profile.brokerage_id),
        getQualificationOutcomes(profile.brokerage_id),
      ])
      campaigns = campaignResult?.campaigns || []
      qualOutcomes = qual || qualOutcomes
    } catch {}
  }

  const activeCampaigns = campaigns.filter((c: any) => c.status === 'active')

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">ISA Dashboard</h1>
          <p className="text-gray-500 text-sm">AI Inside Sales Agent — Lead Qualification Center</p>
        </div>
        <Link href="/dashboard/isa/calling">
          <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white">
            <PhoneCall className="w-4 h-4 mr-2" />
            Start Calling
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Active Campaigns', value: activeCampaigns.length, icon: Megaphone, color: 'text-blue-600' },
          { label: 'Total Contacted', value: qualOutcomes.totalContacted || 0, icon: Phone, color: 'text-purple-600' },
          { label: 'Qualified Leads', value: qualOutcomes.totalQualified || 0, icon: CheckCircle2, color: 'text-green-600' },
          { label: 'Conversion Rate', value: qualOutcomes.totalContacted > 0 ? `${Math.round((qualOutcomes.totalQualified / qualOutcomes.totalContacted) * 100)}%` : '0%', icon: TrendingUp, color: 'text-orange-600' },
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

      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Active Campaigns ({activeCampaigns.length})</CardTitle></CardHeader>
          <CardContent>
            {activeCampaigns.length === 0 ? (
              <div className="text-center py-4">
                <p className="text-sm text-gray-500 mb-3">No active campaigns</p>
                <Link href="/dashboard/isa/campaigns">
                  <Button size="sm" variant="outline">Create Campaign</Button>
                </Link>
              </div>
            ) : (
              <div className="space-y-2">
                {activeCampaigns.slice(0, 5).map((c: any) => (
                  <div key={c.id} className="flex items-center justify-between p-2 bg-blue-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium">{c.name}</p>
                      <p className="text-xs text-gray-500">{c.channel}</p>
                    </div>
                    <Badge className="bg-blue-100 text-blue-700 border-blue-200">Active</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Quick Navigation</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {[
              { label: 'Calling', href: '/dashboard/isa/calling' },
              { label: 'Campaigns', href: '/dashboard/isa/campaigns' },
              { label: 'Scripts', href: '/dashboard/isa/scripts' },
              { label: 'Analytics', href: '/dashboard/isa/analytics' },
              { label: 'Lead Intelligence', href: '/leads' },
              { label: 'Voice AI', href: '/dashboard/voice/isa' },
            ].map((a) => (
              <Link key={a.href} href={a.href}>
                <Button variant="outline" size="sm" className="w-full">{a.label}</Button>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
