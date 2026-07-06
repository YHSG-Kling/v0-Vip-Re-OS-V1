'use client'

// Referrer love loop controls: configure the appreciation (decided by the agent /
// team / brokerage — most-specific wins, value hard-capped), link a referrer as a
// CONTACT so the loop knows who to update, and record when a gift actually went out.
import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Gift, Loader2, Link2, Check } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import {
  setReferralAppreciationSettingAction,
  linkReferrerContactAction,
  recordReferralGiftSentAction,
} from '@/app/actions/referrals/referral-appreciation'

export function ReferralAppreciationPanel({ canSetBrokerage }: { canSetBrokerage: boolean }) {
  const [scope, setScope] = useState<'agent' | 'team' | 'brokerage'>(canSetBrokerage ? 'brokerage' : 'agent')
  const [enabled, setEnabled] = useState(true)
  const [dollars, setDollars] = useState(50)
  const [kind, setKind] = useState('handwritten card + gift card')
  const [referralId, setReferralId] = useState('')
  const [referrerContactId, setReferrerContactId] = useState('')
  const [giftReferralId, setGiftReferralId] = useState('')
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) =>
    startTransition(async () => {
      const r = await fn()
      if (r.ok) toast({ title: okMsg })
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2"><Gift className="h-4 w-4 text-primary" />Referrer appreciation</CardTitle>
        <p className="text-xs text-muted-foreground">
          When a contact refers a friend, the Sphere manager keeps them updated at each milestone and proposes
          the configured thank-you on close. Modest, non-cash — never a referral fee.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs">Appreciation ({scope} scope)</Label>
          <div className="flex gap-2">
            <select className="rounded border p-1.5 text-xs" value={scope} onChange={(e) => setScope(e.target.value as any)}>
              <option value="agent">my default</option>
              <option value="team">team</option>
              {canSetBrokerage && <option value="brokerage">brokerage</option>}
            </select>
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />enabled</label>
            <Input className="w-20 h-8 text-xs" type="number" value={dollars} onChange={(e) => setDollars(Number(e.target.value))} />
            <span className="text-xs self-center text-muted-foreground">$ cap</span>
          </div>
          <Input className="h-8 text-xs" value={kind} onChange={(e) => setKind(e.target.value)} placeholder="e.g. flowers, gift card" />
          <Button size="sm" disabled={pending} onClick={() => run(() => setReferralAppreciationSettingAction({ scope, enabled, maxValueCents: Math.round(dollars * 100), kind }), 'Appreciation saved')}>
            {pending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}Save
          </Button>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">Link a referrer contact / record a gift</Label>
          <div className="flex gap-2">
            <Input className="h-8 text-xs" value={referralId} onChange={(e) => setReferralId(e.target.value)} placeholder="referral id" />
            <Input className="h-8 text-xs" value={referrerContactId} onChange={(e) => setReferrerContactId(e.target.value)} placeholder="referrer contact id" />
            <Button size="sm" variant="outline" disabled={pending || !referralId || !referrerContactId}
              onClick={() => run(() => linkReferrerContactAction({ referralId, referrerContactId }), 'Referrer linked')}>
              <Link2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex gap-2">
            <Input className="h-8 text-xs" value={giftReferralId} onChange={(e) => setGiftReferralId(e.target.value)} placeholder="referral id (gift went out)" />
            <Button size="sm" variant="outline" disabled={pending || !giftReferralId}
              onClick={() => run(() => recordReferralGiftSentAction(giftReferralId), 'Gift recorded')}>
              <Gift className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
