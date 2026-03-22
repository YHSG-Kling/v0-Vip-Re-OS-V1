import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Users } from 'lucide-react'
import { InviteUserButton } from './invite-user-button'
import { EditUserButton } from './edit-user-button'

export const dynamic = 'force-dynamic'

export default async function AdminUsersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('users').select('role, brokerage_id').eq('id', user.id).single()
  if (!['admin', 'superadmin'].includes(profile?.role)) redirect('/dashboard')

  const query = supabase
    .from('users')
    .select('id, first_name, last_name, email, user_type, status, created_at, brokerage_id')
    .order('created_at', { ascending: false })
    .limit(50)

  if (profile?.role === 'admin' && profile.brokerage_id) {
    query.eq('brokerage_id', profile.brokerage_id)
  }

  const { data: users } = await query
  const userList = users || []

  const roleColor: Record<string, string> = {
    agent: 'bg-blue-100 text-blue-700',
    broker: 'bg-purple-100 text-purple-700',
    admin: 'bg-red-100 text-red-700',
    tc: 'bg-orange-100 text-orange-700',
    isa: 'bg-green-100 text-green-700',
    team_lead: 'bg-indigo-100 text-indigo-700',
    contact: 'bg-gray-100 text-gray-600',
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="w-6 h-6 text-blue-600" />
            User Management
          </h1>
          <p className="text-gray-500 text-sm">{userList.length} users</p>
        </div>
        <InviteUserButton
          callerRole={profile?.role ?? "admin"}
          brokerageId={profile?.brokerage_id}
        />
      </div>

      {userList.length === 0 ? (
        <Card><CardContent className="text-center py-12 text-gray-500">No users found</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {userList.map((u: any) => (
            <Card key={u.id}>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium">{[u.first_name, u.last_name].filter(Boolean).join(' ') || 'Unnamed User'}</p>
                  <p className="text-sm text-gray-500">{u.email}</p>
                  <p className="text-xs text-gray-400">Joined {new Date(u.created_at).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={roleColor[u.user_type] || 'bg-gray-100 text-gray-600'} title={u.user_type}>
                    {u.user_type || 'user'}
                  </Badge>
                  <Badge variant={u.status === 'active' ? 'outline' : 'secondary'} className="text-xs">
                    {u.status || 'active'}
                  </Badge>
                  <EditUserButton userId={u.id} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
