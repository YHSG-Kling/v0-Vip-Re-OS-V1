'use client'

import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Loader2, UserPlus, ShieldOff, Shield, LifeBuoy } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { createPlatformStaffAction, updatePlatformStaffRoleAction, revokePlatformStaffAction, listPlatformStaffAction } from '@/app/actions/superadmin/platform-staff'

const ROLES = ['support', 'marketing', 'admin', 'superadmin']

interface Staff {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  user_type: string | null
  platform_role: string | null
  status: string | null
}

export function PlatformStaffManager({ initialStaff, currentUserId }: { initialStaff: Staff[]; currentUserId: string }) {
  const [staff, setStaff] = useState<Staff[]>(initialStaff)
  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [role, setRole] = useState('support')
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  function reload() { listPlatformStaffAction().then((r) => { if (r.ok) setStaff(r.staff as Staff[]) }) }

  function create() {
    startTransition(async () => {
      const r = await createPlatformStaffAction({ email, firstName, lastName, role })
      if (r.ok) { toast({ title: 'Staff invited', description: `${email} as ${role}` }); setEmail(''); setFirstName(''); setLastName(''); reload() }
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }
  function changeRole(userId: string, newRole: string) {
    startTransition(async () => {
      const r = await updatePlatformStaffRoleAction({ userId, role: newRole })
      if (r.ok) { toast({ title: 'Role updated' }); reload() } else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }
  function revoke(userId: string) {
    startTransition(async () => {
      const r = await revokePlatformStaffAction(userId)
      if (r.ok) { toast({ title: 'Access revoked' }); reload() } else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><UserPlus className="h-4 w-4" />Add a platform employee</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div><Label className="text-xs">Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></div>
          <div><Label className="text-xs">Role</Label>
            <select className="w-full rounded border p-2 text-sm" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div><Label className="text-xs">First name</Label><Input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></div>
          <div><Label className="text-xs">Last name</Label><Input value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
          <div className="md:col-span-2">
            <Button size="sm" disabled={pending || !email || !firstName} onClick={create}>
              {pending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <UserPlus className="h-4 w-4 mr-1.5" />}Invite staff
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Staff ({staff.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/10 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2">Name</th><th className="px-4 py-2">Email</th><th className="px-4 py-2">Role</th><th className="px-4 py-2">Status</th><th className="px-4 py-2 text-right">Actions</th>
            </tr></thead>
            <tbody>
              {staff.map((s) => {
                const activeRole = s.platform_role ?? s.user_type ?? ''
                const isSelf = s.id === currentUserId
                return (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="px-4 py-2 font-medium">{[s.first_name, s.last_name].filter(Boolean).join(' ') || '—'}{isSelf && <span className="ml-1 text-[10px] text-muted-foreground">(you)</span>}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{s.email}</td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1">
                        {activeRole === 'superadmin' ? <Shield className="h-3.5 w-3.5 text-indigo-600" /> : <LifeBuoy className="h-3.5 w-3.5 text-cyan-600" />}
                        <Badge variant="outline" className="text-[10px]">{activeRole || '—'}</Badge>
                      </span>
                    </td>
                    <td className="px-4 py-2"><span className={'rounded px-1.5 py-0.5 text-[11px] ' + (s.status === 'inactive' ? 'bg-slate-100 text-slate-500' : 'bg-emerald-100 text-emerald-800')}>{s.status ?? 'active'}</span></td>
                    <td className="px-4 py-2 text-right">
                      {!isSelf && (
                        <div className="inline-flex items-center gap-2">
                          <select className="rounded border p-1 text-xs" value={activeRole} disabled={pending} onChange={(e) => changeRole(s.id, e.target.value)}>
                            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                          <Button size="sm" variant="ghost" className="text-red-600" disabled={pending} onClick={() => revoke(s.id)} title="Revoke access"><ShieldOff className="h-3.5 w-3.5" /></Button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
              {staff.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">No platform staff yet.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}
