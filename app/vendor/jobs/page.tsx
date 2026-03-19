import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getAllVendorBookings } from '@/app/actions/vendor-marketplace'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Briefcase, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function VendorJobsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  let bookings: any[] = []
  try { bookings = await getAllVendorBookings() || [] } catch { bookings = [] }

  const statusColor: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    active: 'bg-blue-100 text-blue-700',
    scheduled: 'bg-indigo-100 text-indigo-700',
    completed: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-700',
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/vendor/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Briefcase className="w-6 h-6 text-blue-600" />
            My Jobs
          </h1>
          <p className="text-gray-500 text-sm">{bookings.length} total job{bookings.length !== 1 ? 's' : ''}</p>
        </div>
      </div>
      {bookings.length === 0 ? (
        <Card><CardContent className="text-center py-12 text-gray-500">No jobs found. Jobs assigned to you will appear here.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {bookings.map((b: any) => (
            <Card key={b.id}>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium">{b.service_type || 'Service Job'}</p>
                  <p className="text-sm text-gray-500">{b.notes || 'No additional details'}</p>
                  {b.scheduled_date && <p className="text-xs text-gray-400">{new Date(b.scheduled_date).toLocaleDateString()}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={statusColor[b.status] || 'bg-gray-100 text-gray-700'}>{b.status}</Badge>
                  {b.status === 'pending' && <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white text-xs">Accept</Button>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
