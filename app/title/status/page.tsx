import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Clock, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const STATUS_GROUPS = [
  { key: 'active', label: 'Active', color: 'bg-blue-100 text-blue-700' },
  { key: 'pending', label: 'Pending', color: 'bg-yellow-100 text-yellow-700' },
  { key: 'under_contract', label: 'Under Contract', color: 'bg-purple-100 text-purple-700' },
  { key: 'closed', label: 'Closed', color: 'bg-green-100 text-green-700' },
]

export default async function TitleStatusPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: transactions } = await supabase
    .from('transactions')
    .select('id, property_address, status, close_date, client_name')
    .order('close_date', { ascending: true })
    .limit(50)

  const grouped = STATUS_GROUPS.map((group) => ({
    ...group,
    items: (transactions || []).filter((t: any) => t.status === group.key),
  }))

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/title/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Clock className="w-6 h-6 text-yellow-600" />
            Order Status
          </h1>
        </div>
      </div>
      {grouped.filter((g) => g.items.length > 0).map((group) => (
        <div key={group.key}>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
            {group.label} <Badge className={group.color + ' border-0'}>{group.items.length}</Badge>
          </h3>
          <div className="space-y-2">
            {group.items.map((t: any) => (
              <Card key={t.id}>
                <CardContent className="p-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{t.property_address || 'Address TBD'}</p>
                    <p className="text-xs text-gray-500">{t.client_name}</p>
                  </div>
                  {t.close_date && <span className="text-xs text-gray-400">{new Date(t.close_date).toLocaleDateString()}</span>}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
