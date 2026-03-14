import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getAllVendorBookings } from '@/app/actions/vendor-marketplace'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Briefcase, DollarSign, Star, Clock, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function VendorDashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  let bookings: any[] = []
  try {
    const result = await getAllVendorBookings()
    bookings = result || []
  } catch { bookings = [] }

  const active = bookings.filter((b: any) => b.status === 'active' || b.status === 'scheduled')
  const completed = bookings.filter((b: any) => b.status === 'completed')
  const pending = bookings.filter((b: any) => b.status === 'pending')

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Vendor Dashboard</h1>
          <p className="text-gray-500 text-sm">Manage your jobs, portfolio, and earnings</p>
        </div>
        <Link href="/vendor/jobs">
          <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white">View Jobs</Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Active Jobs', value: active.length, icon: Briefcase, color: 'text-blue-600' },
          { label: 'Pending', value: pending.length, icon: Clock, color: 'text-yellow-600' },
          { label: 'Completed', value: completed.length, icon: CheckCircle2, color: 'text-green-600' },
          { label: 'Total Jobs', value: bookings.length, icon: Star, color: 'text-purple-600' },
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
          <CardHeader><CardTitle className="text-base">Active Jobs ({active.length})</CardTitle></CardHeader>
          <CardContent>
            {active.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">No active jobs</p>
            ) : (
              <div className="space-y-2">
                {active.slice(0, 5).map((b: any) => (
                  <div key={b.id} className="flex items-center justify-between p-2 bg-blue-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium">{b.service_type || 'Service'}</p>
                      <p className="text-xs text-gray-500">{b.notes || 'No details'}</p>
                    </div>
                    <Badge className="bg-blue-100 text-blue-700 border-blue-200">{b.status}</Badge>
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
              { label: 'My Jobs', href: '/vendor/jobs' },
              { label: 'Portfolio', href: '/vendor/portfolio' },
              { label: 'Earnings', href: '/vendor/earnings' },
              { label: 'Client Portal', href: '/portal/vendor' },
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
