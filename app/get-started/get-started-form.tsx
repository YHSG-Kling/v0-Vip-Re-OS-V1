'use client'

import { useState, useTransition } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { capturePlatformProspectAction } from '@/app/actions/superadmin/platform-growth'

const ROLES = [
  { v: 'solo_agent', l: 'Solo agent' }, { v: 'team', l: 'Team' },
  { v: 'brokerage', l: 'Brokerage' }, { v: 'multi_location', l: 'Multi-location' },
]

// Public top-of-funnel capture — a prospect raises their hand for VIP Agents. Feeds
// the platform growth funnel (/dashboard/superadmin/growth).
export function GetStartedForm() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [role, setRole] = useState('brokerage')
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    setErr(null)
    startTransition(async () => {
      const r = await capturePlatformProspectAction({ name, email, company, roleInterest: role, source: 'get_started' })
      if (r.ok) setDone(true)
      else setErr(r.error)
    })
  }

  if (done) {
    return (
      <Card><CardContent className="p-8 text-center">
        <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-600" />
        <p className="font-medium">Thanks — you're on the list.</p>
        <p className="text-sm text-muted-foreground mt-1">We'll show you the AI team handing a real deal between managers, live.</p>
      </CardContent></Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div><Label className="text-xs">Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><Label className="text-xs">Work email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@brokerage.com" /></div>
          <div><Label className="text-xs">Company</Label><Input value={company} onChange={(e) => setCompany(e.target.value)} /></div>
          <div><Label className="text-xs">You're a…</Label>
            <select className="w-full rounded border p-2 text-sm" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
            </select>
          </div>
        </div>
        {err && <p className="text-xs text-red-600">{err}</p>}
        <Button disabled={pending || !email} onClick={submit} className="w-full">
          {pending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}Show me the AI team
        </Button>
        <p className="text-[11px] text-muted-foreground text-center">No credit card. See it before you sign up.</p>
      </CardContent>
    </Card>
  )
}
