import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Building2, Users, Plus, MapPin } from 'lucide-react'
import Link from 'next/link'
import { getAgentContext } from '@/lib/identity'
import { toCanonicalRoleOrDefault } from '@/lib/security'

export const dynamic = 'force-dynamic'

export default async function AdminBrokeragesPage() {
  // Kernel OS: getAgentContext — canonical identity, never raw auth.getUser()
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect('/login')

  const userRole = toCanonicalRoleOrDefault(ctx.userType, 'agent')
  if (!['admin', 'superadmin'].includes(userRole)) redirect('/dashboard')

  const supabase = await createClient()

  const { data: brokerages } = await supabase
    .from('brokerages')
    .select('id, name, city, state, status, created_at, subscription_tier')
    .order('created_at', { ascending: false })
    .limit(50)

  const brokerageList = brokerages || []

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="w-6 h-6 text-blue-600" />
            Brokerages
          </h1>
          <p className="text-gray-500 text-sm">{brokerageList.length} brokerage{brokerageList.length !== 1 ? 's' : ''} on platform</p>
        </div>
        <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white">
          <Plus className="w-4 h-4 mr-2" />
          Add Brokerage
        </Button>
      </div>

      {brokerageList.length === 0 ? (
        <Card><CardContent className="text-center py-12 text-gray-500">No brokerages found</CardContent></Card>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {brokerageList.map((b: any) => (
            <Card key={b.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-semibold">{b.name}</p>
                    {(b.city || b.state) && (
                      <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                        <MapPin className="w-3 h-3" />
                        {[b.city, b.state].filter(Boolean).join(', ')}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {b.subscription_tier && <Badge variant="outline" className="text-xs">{b.subscription_tier}</Badge>}
                    <Badge className={b.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}>
                      {b.status || 'active'}
                    </Badge>
                  </div>
                </div>
                <p className="text-xs text-gray-400">Added {new Date(b.created_at).toLocaleDateString()}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
