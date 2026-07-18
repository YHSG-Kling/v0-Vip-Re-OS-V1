'use client'

// Public demo-request capture → platform growth funnel (source 'demo_request').
// Honest confirmation: a human follows up to schedule — nothing is auto-booked.
import { useState, useTransition } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { requestPlatformDemoAction } from '@/app/actions/superadmin/platform-growth'

const ROLES = [
  { v: 'solo_agent', l: 'Solo agent' }, { v: 'team', l: 'Team' },
  { v: 'brokerage', l: 'Brokerage' }, { v: 'multi_location', l: 'Multi-location' },
]

export function DemoRequestForm() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [role, setRole] = useState('brokerage')
  const [times, setTimes] = useState('')
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    setErr(null)
    startTransition(async () => {
      const r = await requestPlatformDemoAction({ name, email, company, roleInterest: role, preferredTimes: times })
      if (r.ok) setDone(true)
      else setErr(r.error)
    })
  }

  if (done) {
    return (
      <Card><CardContent className="p-8 text-center">
        <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-600" />
        <p className="font-medium">Request received.</p>
        <p className="text-sm text-muted-foreground mt-1">
          A real person on our team will email you{times.trim() ? ' about the times you suggested' : ''} to confirm a
          15-minute slot — usually within one business day. Nothing has been scheduled automatically.
        </p>
      </CardContent></Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div><Label className="text-xs">Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><Label className="text-xs">Work email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@brokerage.com" /></div>
          <div><Label className="text-xs">Brokerage / company</Label><Input value={company} onChange={(e) => setCompany(e.target.value)} /></div>
          <div><Label className="text-xs">You&apos;re a…</Label>
            <select className="w-full rounded border p-2 text-sm" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
            </select>
          </div>
        </div>
        <div>
          <Label className="text-xs">Times that work for you (free-form)</Label>
          <Textarea rows={3} value={times} onChange={(e) => setTimes(e.target.value)}
            placeholder="e.g. weekday mornings ET, or Tue/Thu after 3pm" />
        </div>
        {err && <p className="text-xs text-red-600">{err}</p>}
        <Button disabled={pending || !email} onClick={submit} className="w-full">
          {pending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}Request the demo
        </Button>
        <p className="text-[11px] text-muted-foreground text-center">A human follows up to schedule — no auto-booking, no credit card.</p>
      </CardContent>
    </Card>
  )
}
