'use client'

import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Loader2, Plus, Save, Trash2, RefreshCw, Star } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { upsertPlanTierAction, removePlanTierAction, syncPlanTierFromStripeAction, publishTierToStripeAction, listPlanTiersAction, syncCatalogFromStripeAction } from '@/app/actions/superadmin/plan-catalog'

const CANON = ['solo_agent', 'team', 'brokerage', 'multi_location']

interface Tier {
  id?: string
  tier_name: string
  display_name: string
  description: string | null
  monthly_price_cents: number
  annual_price_cents: number
  setup_fee_cents: number
  marketing_bullets: string[]
  is_featured: boolean
  is_active: boolean
  max_agents: number | null
  stripe_price_id: string | null
  seat_package_size?: number | null
  seat_package_price_cents?: number | null
  stripe_seat_price_id?: string | null
}

const BLANK: Tier = {
  tier_name: 'solo_agent', display_name: '', description: '', monthly_price_cents: 0, annual_price_cents: 0,
  setup_fee_cents: 0, marketing_bullets: [], is_featured: false, is_active: true, max_agents: null, stripe_price_id: null,
  seat_package_size: null, seat_package_price_cents: null, stripe_seat_price_id: null,
}

const dollars = (c: number) => (c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })

export function PlanCatalogManager({ initialTiers }: { initialTiers: Tier[] }) {
  const [tiers, setTiers] = useState<Tier[]>(initialTiers)
  const [editing, setEditing] = useState<Tier | null>(null)
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  function reload() {
    listPlanTiersAction().then((r) => { if (r.ok) setTiers(r.tiers as Tier[]) })
  }

  function save() {
    if (!editing) return
    startTransition(async () => {
      const r = await upsertPlanTierAction({
        id: editing.id,
        tierName: editing.tier_name,
        displayName: editing.display_name,
        description: editing.description,
        monthlyPriceCents: Number(editing.monthly_price_cents) || 0,
        annualPriceCents: Number(editing.annual_price_cents) || 0,
        setupFeeCents: Number(editing.setup_fee_cents) || 0,
        marketingBullets: editing.marketing_bullets,
        isFeatured: editing.is_featured,
        isActive: editing.is_active,
        maxAgents: editing.max_agents,
        stripePriceId: editing.stripe_price_id,
        seatPackageSize: editing.seat_package_size ?? null,
        seatPackagePriceCents: editing.seat_package_price_cents ?? null,
        stripeSeatPriceId: editing.stripe_seat_price_id ?? null,
      })
      if (r.ok) { toast({ title: 'Saved' }); setEditing(null); reload() }
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }

  // STRIPE IS THE CATALOGUE SOURCE (wave 79A): one click pulls every active
  // recurring price (plan + seat package, by tier_name metadata) onto the tiers.
  function syncAll() {
    startTransition(async () => {
      const r = await syncCatalogFromStripeAction()
      if (r.ok) {
        toast({ title: `Synced ${r.updated.length} tier${r.updated.length === 1 ? '' : 's'} from Stripe`, description: [r.unmatched.length ? `${r.unmatched.length} price(s) not placed` : null, r.tiersWithoutPlanPrice.length ? `no plan price for: ${r.tiersWithoutPlanPrice.join(', ')}` : null].filter(Boolean).join(' · ') || undefined })
        reload()
      } else toast({ title: 'Sync failed', description: r.error, variant: 'destructive' })
    })
  }

  function remove(id: string) {
    startTransition(async () => {
      const r = await removePlanTierAction(id)
      if (r.ok) { toast({ title: r.removed === 'soft' ? 'Deactivated (tenants on plan)' : 'Removed' }); reload() }
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }

  function sync(id: string) {
    startTransition(async () => {
      const r = await syncPlanTierFromStripeAction(id)
      if (r.ok) { toast({ title: `Synced from Stripe — $${dollars(r.monthlyPriceCents)}` }); reload() }
      else toast({ title: 'Sync failed', description: r.error, variant: 'destructive' })
    })
  }

  // Pricing day is one click: save the tier's price here, then Publish —
  // creates the Stripe price from the DB value and links it (the old
  // price's product is archived; existing subscriptions keep billing).
  function publish(id: string) {
    startTransition(async () => {
      const r = await publishTierToStripeAction(id)
      if (r.ok) { toast({ title: `Published to Stripe — ${r.priceId}` }); reload() }
      else toast({ title: 'Publish failed', description: r.error, variant: 'destructive' })
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={syncAll} title="Pull every active Stripe price (plan + seat package, by tier_name metadata) onto the catalogue"><RefreshCw className="h-4 w-4 mr-1.5" />Sync catalogue from Stripe</Button>
        <Button size="sm" onClick={() => setEditing({ ...BLANK })}><Plus className="h-4 w-4 mr-1.5" />New plan</Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {tiers.map((t) => (
          <Card key={t.id} className={t.is_active ? '' : 'opacity-60'}>
            <CardHeader className="pb-2 flex-row items-start justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  {t.display_name} {t.is_featured && <Star className="h-4 w-4 text-amber-500 fill-amber-500" />}
                  {!t.is_active && <Badge variant="outline" className="text-[10px]">inactive</Badge>}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{t.tier_name}</p>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold">${dollars(t.monthly_price_cents)}<span className="text-xs font-normal text-muted-foreground">/mo</span></p>
                {t.setup_fee_cents > 0 && <p className="text-[11px] text-muted-foreground">+${dollars(t.setup_fee_cents)} setup</p>}
                <p className="text-[11px] text-muted-foreground">{t.max_agents == null ? 'custom seats' : `${t.max_agents} seats`}{t.seat_package_size ? ` · +${t.seat_package_size}-seat pack ${t.seat_package_price_cents ? `$${dollars(t.seat_package_price_cents)}/mo` : '(unpriced)'}` : ''}</p>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
              <ul className="text-[11px] space-y-0.5">{(t.marketing_bullets ?? []).slice(0, 4).map((b, i) => <li key={i}>• {b}</li>)}</ul>
              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => setEditing({ ...t, marketing_bullets: t.marketing_bullets ?? [] })}>Edit</Button>
                {t.stripe_price_id && <Button size="sm" variant="ghost" disabled={pending} onClick={() => sync(t.id!)}><RefreshCw className="h-3.5 w-3.5" /></Button>}
                {t.id && <Button size="sm" variant="outline" disabled={pending} onClick={() => publish(t.id!)} title="Publish this tier's price to Stripe (creates + links the live price)">Publish</Button>}
                <Button size="sm" variant="ghost" className="text-red-600" disabled={pending} onClick={() => remove(t.id!)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {editing && (
        <Card className="border-primary">
          <CardHeader className="pb-3"><CardTitle className="text-sm">{editing.id ? 'Edit plan' : 'New plan'}</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div><Label className="text-xs">Tier key</Label>
              <select className="w-full rounded border p-2 text-sm" value={editing.tier_name} onChange={(e) => setEditing({ ...editing, tier_name: e.target.value })}>
                {CANON.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div><Label className="text-xs">Display name</Label><Input value={editing.display_name} onChange={(e) => setEditing({ ...editing, display_name: e.target.value })} /></div>
            <div className="md:col-span-2"><Label className="text-xs">Blurb</Label><Input value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>
            <div><Label className="text-xs">Monthly ($)</Label><Input type="number" value={editing.monthly_price_cents / 100} onChange={(e) => setEditing({ ...editing, monthly_price_cents: Math.round(Number(e.target.value) * 100) })} /></div>
            <div><Label className="text-xs">Annual ($)</Label><Input type="number" value={editing.annual_price_cents / 100} onChange={(e) => setEditing({ ...editing, annual_price_cents: Math.round(Number(e.target.value) * 100) })} /></div>
            <div><Label className="text-xs">Setup fee ($)</Label><Input type="number" value={editing.setup_fee_cents / 100} onChange={(e) => setEditing({ ...editing, setup_fee_cents: Math.round(Number(e.target.value) * 100) })} /></div>
            <div><Label className="text-xs">Max agents (blank = unlimited)</Label><Input type="number" value={editing.max_agents ?? ''} onChange={(e) => setEditing({ ...editing, max_agents: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="md:col-span-2"><Label className="text-xs">Marketing bullets (one per line)</Label>
              <textarea className="w-full rounded border p-2 text-sm" rows={4} value={(editing.marketing_bullets ?? []).join('\n')} onChange={(e) => setEditing({ ...editing, marketing_bullets: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
            </div>
            <div className="md:col-span-2"><Label className="text-xs">Stripe price id (optional)</Label><Input value={editing.stripe_price_id ?? ''} onChange={(e) => setEditing({ ...editing, stripe_price_id: e.target.value || null })} placeholder="price_..." /></div>
            <div><Label className="text-xs">Seat package size (seats per pack; blank = none)</Label><Input type="number" value={editing.seat_package_size ?? ''} onChange={(e) => setEditing({ ...editing, seat_package_size: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div><Label className="text-xs">Seat package price ($/mo per pack; blank = unpriced)</Label><Input type="number" value={editing.seat_package_price_cents == null ? '' : editing.seat_package_price_cents / 100} onChange={(e) => setEditing({ ...editing, seat_package_price_cents: e.target.value === '' ? null : Math.round(Number(e.target.value) * 100) })} /></div>
            <div className="md:col-span-2"><Label className="text-xs">Stripe seat-package price id (metadata kind=seat_package)</Label><Input value={editing.stripe_seat_price_id ?? ''} onChange={(e) => setEditing({ ...editing, stripe_seat_price_id: e.target.value || null })} placeholder="price_..." /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.is_featured} onChange={(e) => setEditing({ ...editing, is_featured: e.target.checked })} />Highlighted plan</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} />Active (shown at signup)</label>
            <div className="md:col-span-2 flex gap-2">
              <Button size="sm" disabled={pending} onClick={save}>{pending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}Save</Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
