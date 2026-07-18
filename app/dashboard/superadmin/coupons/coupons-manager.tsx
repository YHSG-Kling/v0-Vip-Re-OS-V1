'use client'

// Superadmin coupon manager — create form, coupon list with redemption counts
// + status badges, apply-to-tenant picker, and a publish-to-Stripe button that
// is HONEST about mock vs live (mock_… ledger ids render as "Mock", and the
// header banner says up front whether Stripe creds are configured).

import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Loader2, Plus, Save, Trash2, Ticket, UploadCloud } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import {
  listCouponsAction, createCouponAction, setCouponActiveAction, removeCouponAction,
  redeemCouponForBrokerageAction, publishCouponToStripeAction, type CouponListRow,
} from '@/app/actions/superadmin/coupons'
import { isMockStripeCouponId, normalizeCouponCode } from '@/lib/platform/coupons'

const TIERS = ['solo_agent', 'team', 'brokerage', 'multi_location'] as const

interface BrokerageOption { id: string; name: string; tier: string | null }

interface Draft {
  code: string
  description: string
  kind: 'percent' | 'amount'
  percentOff: string
  amountOffDollars: string
  duration: 'once' | 'repeating' | 'forever'
  durationMonths: string
  appliesToTier: string
  maxRedemptions: string
  expiresAt: string
}

const BLANK: Draft = {
  code: '', description: '', kind: 'percent', percentOff: '20', amountOffDollars: '',
  duration: 'once', durationMonths: '3', appliesToTier: '', maxRedemptions: '', expiresAt: '',
}

export function CouponsManager({ initialCoupons, brokerages, stripeConfigured }: {
  initialCoupons: CouponListRow[]
  brokerages: BrokerageOption[]
  stripeConfigured: boolean
}) {
  const [coupons, setCoupons] = useState<CouponListRow[]>(initialCoupons)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [applyFor, setApplyFor] = useState<string | null>(null) // coupon id with picker open
  const [pickedBrokerage, setPickedBrokerage] = useState<string>('')
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  function reload() {
    listCouponsAction().then((r) => { if (r.ok) setCoupons(r.coupons) })
  }

  function create() {
    if (!draft) return
    startTransition(async () => {
      const r = await createCouponAction({
        code: draft.code,
        description: draft.description || null,
        percentOff: draft.kind === 'percent' ? Number(draft.percentOff) : null,
        amountOffCents: draft.kind === 'amount' ? Math.round(Number(draft.amountOffDollars) * 100) : null,
        duration: draft.duration,
        durationMonths: draft.duration === 'repeating' ? Number(draft.durationMonths) : null,
        appliesToTier: draft.appliesToTier || null,
        maxRedemptions: draft.maxRedemptions ? Number(draft.maxRedemptions) : null,
        expiresAt: draft.expiresAt || null,
      })
      if (r.ok) { toast({ title: `Coupon ${r.code} created` }); setDraft(null); reload() }
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }

  function toggleActive(c: CouponListRow) {
    startTransition(async () => {
      const r = await setCouponActiveAction(c.id, !c.active)
      if (r.ok) { toast({ title: c.active ? `${c.code} deactivated` : `${c.code} activated` }); reload() }
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }

  function remove(c: CouponListRow) {
    startTransition(async () => {
      const r = await removeCouponAction(c.id)
      if (r.ok) { toast({ title: r.removed === 'soft' ? `${c.code} has redemptions — deactivated instead of deleted` : `${c.code} deleted` }); reload() }
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }

  function applyToTenant(c: CouponListRow) {
    if (!pickedBrokerage) return
    startTransition(async () => {
      const r = await redeemCouponForBrokerageAction(c.id, pickedBrokerage)
      if (r.ok) { toast({ title: `${r.code} applied to ${r.brokerageName}`, description: r.summary }); setApplyFor(null); setPickedBrokerage(''); reload() }
      else toast({ title: 'Could not apply', description: r.error, variant: 'destructive' })
    })
  }

  function publish(c: CouponListRow) {
    startTransition(async () => {
      const r = await publishCouponToStripeAction(c.id)
      if (r.ok) {
        toast({
          title: r.mode === 'live' ? `Published to Stripe — ${r.stripeCouponId}` : 'Recorded as MOCK (Stripe not configured)',
          description: r.note,
        })
        reload()
      } else toast({ title: 'Publish failed', description: r.error, variant: 'destructive' })
    })
  }

  const now = Date.now()

  return (
    <div className="space-y-4">
      {/* Honest Stripe state — up front, before any button is pressed */}
      <div className={'rounded-md border px-3 py-2 text-xs ' + (stripeConfigured ? 'text-emerald-700' : 'text-amber-700')}>
        {stripeConfigured
          ? 'Stripe is configured — Publish creates a live Stripe coupon.'
          : 'Stripe is NOT configured (STRIPE_SECRET_KEY unset) — Publish records an honest mock ledger entry only; nothing reaches Stripe until creds are added.'}
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDraft({ ...BLANK })}><Plus className="h-4 w-4 mr-1.5" />New coupon</Button>
      </div>

      {draft && (
        <Card className="border-primary">
          <CardHeader className="pb-3"><CardTitle className="text-sm">New coupon</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div>
              <Label className="text-xs">Code (A-Z, 0-9, - or _)</Label>
              <Input value={draft.code} placeholder="LAUNCH20" onChange={(e) => setDraft({ ...draft, code: e.target.value })} onBlur={(e) => setDraft({ ...draft, code: normalizeCouponCode(e.target.value) })} />
            </div>
            <div><Label className="text-xs">Description (internal)</Label><Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
            <div>
              <Label className="text-xs">Discount</Label>
              <div className="flex gap-2">
                <select className="rounded border p-2 text-sm" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft['kind'] })}>
                  <option value="percent">% off</option>
                  <option value="amount">$ off</option>
                </select>
                {draft.kind === 'percent'
                  ? <Input type="number" min={1} max={100} value={draft.percentOff} onChange={(e) => setDraft({ ...draft, percentOff: e.target.value })} placeholder="20" />
                  : <Input type="number" min={0.01} step="0.01" value={draft.amountOffDollars} onChange={(e) => setDraft({ ...draft, amountOffDollars: e.target.value })} placeholder="50.00" />}
              </div>
            </div>
            <div>
              <Label className="text-xs">Duration</Label>
              <div className="flex gap-2">
                <select className="rounded border p-2 text-sm flex-1" value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: e.target.value as Draft['duration'] })}>
                  <option value="once">Once (first invoice)</option>
                  <option value="repeating">Repeating (N months)</option>
                  <option value="forever">Forever</option>
                </select>
                {draft.duration === 'repeating' && (
                  <Input className="w-24" type="number" min={1} max={36} value={draft.durationMonths} onChange={(e) => setDraft({ ...draft, durationMonths: e.target.value })} placeholder="3" />
                )}
              </div>
            </div>
            <div>
              <Label className="text-xs">Applies to tier</Label>
              <select className="w-full rounded border p-2 text-sm" value={draft.appliesToTier} onChange={(e) => setDraft({ ...draft, appliesToTier: e.target.value })}>
                <option value="">Any tier</option>
                {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div><Label className="text-xs">Max redemptions (blank = unlimited)</Label><Input type="number" min={1} value={draft.maxRedemptions} onChange={(e) => setDraft({ ...draft, maxRedemptions: e.target.value })} /></div>
            <div><Label className="text-xs">Expires (blank = never)</Label><Input type="date" value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} /></div>
            <div className="md:col-span-2 flex gap-2">
              <Button size="sm" disabled={pending} onClick={create}>{pending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}Create</Button>
              <Button size="sm" variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {coupons.length === 0 && !draft && (
        <div className="rounded-lg border p-10 text-center text-sm text-muted-foreground">
          <Ticket className="h-6 w-6 mx-auto mb-2 opacity-50" />
          No coupons yet — create the first discount code above.
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {coupons.map((c) => {
          const expired = !!c.expires_at && Date.parse(c.expires_at) <= now
          const exhausted = c.max_redemptions != null && c.redeemed_count >= c.max_redemptions
          return (
            <Card key={c.id} className={c.active && !expired ? '' : 'opacity-60'}>
              <CardHeader className="pb-2 flex-row items-start justify-between">
                <div>
                  <CardTitle className="text-base font-mono flex items-center gap-2 flex-wrap">
                    {c.code}
                    {!c.active && <Badge variant="outline" className="text-[10px]">inactive</Badge>}
                    {expired && <Badge variant="outline" className="text-[10px] text-red-600 border-red-300">expired</Badge>}
                    {exhausted && <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">limit reached</Badge>}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">{c.summary}{c.applies_to_tier ? ` · ${c.applies_to_tier} tier only` : ' · any tier'}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold tabular-nums">{c.ledger_redemptions}{c.max_redemptions != null ? ` / ${c.max_redemptions}` : ''}</p>
                  <p className="text-[11px] text-muted-foreground">redeemed</p>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
                <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
                  {c.expires_at && !expired && <span>expires {new Date(c.expires_at).toLocaleDateString('en-US')}</span>}
                  {c.last_redeemed_at && <span>last redeemed {new Date(c.last_redeemed_at).toLocaleDateString('en-US')}</span>}
                  {c.stripe_coupon_id
                    ? isMockStripeCouponId(c.stripe_coupon_id)
                      ? <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300">Stripe: mock (no creds)</Badge>
                      : <Badge variant="outline" className="text-[10px] text-emerald-700 border-emerald-300">Live on Stripe · {c.stripe_coupon_id}</Badge>
                    : <Badge variant="outline" className="text-[10px]">Not published to Stripe</Badge>}
                </div>
                <div className="flex gap-2 pt-1 flex-wrap">
                  <Button size="sm" variant="outline" disabled={pending || !c.active || expired || exhausted} onClick={() => { setApplyFor(applyFor === c.id ? null : c.id); setPickedBrokerage('') }}>
                    Apply to tenant
                  </Button>
                  <Button size="sm" variant="outline" disabled={pending || !c.active} onClick={() => publish(c)}
                    title={stripeConfigured ? 'Create this coupon on Stripe' : 'Stripe not configured — records an honest mock ledger entry'}>
                    <UploadCloud className="h-3.5 w-3.5 mr-1.5" />{stripeConfigured ? 'Publish to Stripe' : 'Publish (mock)'}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => toggleActive(c)}>{c.active ? 'Deactivate' : 'Activate'}</Button>
                  <Button size="sm" variant="ghost" className="text-red-600" disabled={pending} onClick={() => remove(c)}
                    title="Deletes only while unredeemed; a redeemed coupon is deactivated (ledger preserved)">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {applyFor === c.id && (
                  <div className="rounded-md border p-2 space-y-2">
                    {brokerages.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No tenants to apply this coupon to yet.</p>
                    ) : (
                      <>
                        <Label className="text-xs">Tenant{c.applies_to_tier ? ` (must be on ${c.applies_to_tier})` : ''}</Label>
                        <select className="w-full rounded border p-2 text-sm" value={pickedBrokerage} onChange={(e) => setPickedBrokerage(e.target.value)}>
                          <option value="">Select a brokerage…</option>
                          {brokerages.map((b) => <option key={b.id} value={b.id}>{b.name}{b.tier ? ` — ${b.tier}` : ''}</option>)}
                        </select>
                        <div className="flex gap-2">
                          <Button size="sm" disabled={pending || !pickedBrokerage} onClick={() => applyToTenant(c)}>
                            {pending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}Redeem for tenant
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => { setApplyFor(null); setPickedBrokerage('') }}>Cancel</Button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
