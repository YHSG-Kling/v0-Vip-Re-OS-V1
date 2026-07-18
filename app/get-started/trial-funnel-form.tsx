"use client"

// app/get-started/trial-funnel-form.tsx
// ─────────────────────────────────────────────────────────────────────────────
// SELF-SERVE TRIAL FUNNEL — pick a tier (DB-driven pricing), optionally apply a
// coupon (live validation via checkFunnelCouponAction; redeemed server-side at
// signup), then the same signup fields /signup uses → signupBrokerageAction,
// which provisions the tenant and applies the tier's LIVE funnel snapshot
// (newest snapshot recommending that tier). Everything degrades honestly: no
// snapshots ⇒ plain signup; bad coupon ⇒ signup still succeeds and says so.

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, Loader2, User, Briefcase, Building2, MapPin, Tag, Sparkles, AlertTriangle } from "lucide-react"
import { signupBrokerageAction, type CanonicalTier, type SignupBrokerageResult } from "@/app/actions/auth/signup-brokerage"
import { formatTierPrice, type PublicTier } from "@/lib/platform/public-tiers"
import { recordTosAcceptanceAction, getCurrentTosVersionAction } from "@/app/actions/public/tos-acceptance"
import { checkFunnelCouponAction } from "./actions"

// Per-tier icon is the only UI-side mapping — every tier fact is DB-driven.
const TIER_ICON: Record<string, typeof User> = {
  solo_agent: User, team: Briefcase, brokerage: Building2, multi_location: MapPin,
}

/** id+name of the LIVE funnel snapshot per tier (resolved server-side on the page). */
export type FunnelSnapshotMap = Record<string, { id: string; name: string }>

type CouponState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "valid"; code: string; summary: string }
  | { status: "invalid"; message: string }

export function TrialFunnelForm({ tiers = [], funnelSnapshots = {}, initialTier = null }: {
  tiers?: PublicTier[]
  funnelSnapshots?: FunnelSnapshotMap
  initialTier?: string | null
}) {
  const defaultTier = (initialTier && tiers.some((t) => t.tierName === initialTier)
    ? initialTier
    : (tiers.find((t) => t.featured)?.tierName ?? tiers[0]?.tierName ?? "team")) as CanonicalTier
  const [tier, setTier] = useState<CanonicalTier>(defaultTier)

  const [couponInput, setCouponInput] = useState("")
  const [coupon, setCoupon] = useState<CouponState>({ status: "idle" })

  const [brokerageName, setBrokerageName] = useState("")
  const [city, setCity]                   = useState("")
  const [state, setState]                 = useState("")
  const [firstName, setFirstName]         = useState("")
  const [lastName, setLastName]           = useState("")
  const [email, setEmail]                 = useState("")
  const [tosAccepted, setTosAccepted]     = useState(false)
  // Solo-agent only: routes broker-side steps (CDA signature, compliance) in-app vs external.
  const [brokerageOnPlatform, setBrokerageOnPlatform] = useState(false)
  const [teamOnPlatform, setTeamOnPlatform]           = useState(false)

  const [error, setError]     = useState<string | null>(null)
  const [success, setSuccess] = useState<SignupBrokerageResult | null>(null)
  const [isPending, startTransition] = useTransition()

  function checkCoupon(forTier: CanonicalTier, raw: string) {
    if (!raw.trim()) { setCoupon({ status: "idle" }); return }
    setCoupon({ status: "checking" })
    startTransition(async () => {
      const r = await checkFunnelCouponAction(raw, forTier)
      if (r.ok && r.code && r.summary) setCoupon({ status: "valid", code: r.code, summary: r.summary })
      else setCoupon({ status: "invalid", message: r.message ?? "That code isn't valid" })
    })
  }

  function pickTier(next: CanonicalTier) {
    setTier(next)
    // Coupons can be tier-restricted — re-check a typed code against the new tier.
    if (couponInput.trim()) checkCoupon(next, couponInput)
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      // Durable ToS acceptance record (version from platform settings) BEFORE provisioning.
      const tosV = await getCurrentTosVersionAction()
      await recordTosAcceptanceAction({ email, version: tosV.ok ? tosV.version : "2026-07-01" })
      const r = await signupBrokerageAction({
        brokerageName, adminFirstName: firstName, adminLastName: lastName, adminEmail: email,
        tier, brokerageCity: city || undefined, brokerageState: state || undefined,
        brokerageOnPlatform: tier === "solo_agent" ? brokerageOnPlatform : undefined,
        teamOnPlatform:      tier === "solo_agent" ? teamOnPlatform : undefined,
        // The tier's LIVE funnel snapshot (may be absent — plain signup then).
        snapshotId: funnelSnapshots[tier]?.id,
        // Send the validated code when we have one, else whatever was typed —
        // the server re-validates and reports the outcome honestly either way.
        couponCode: coupon.status === "valid" ? coupon.code : (couponInput.trim() || undefined),
      })
      if (!r.ok) { setError(r.error ?? "Sign-up failed."); return }
      setSuccess(r)
    })
  }

  if (success) {
    return (
      <Card>
        <CardContent className="p-8 space-y-3">
          <div className="text-center">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-600" />
            <p className="font-medium">You&apos;re in — check {email} for your invite link.</p>
            <p className="text-sm text-muted-foreground mt-1">
              Your free trial ends {success.trialEndsAt ? new Date(success.trialEndsAt).toLocaleDateString() : "in 14 days"}. No card on file until you add billing.
            </p>
          </div>
          <div className="text-sm space-y-1.5 max-w-md mx-auto">
            {success.snapshotApplied && success.snapshotApplied.length > 0 && (
              <p className="flex items-start gap-1.5"><Sparkles className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                Your workspace and day-one website were preloaded from our starter setup ({success.snapshotApplied.join(", ")}).</p>
            )}
            {success.snapshotError && (
              <p className="flex items-start gap-1.5 text-muted-foreground"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                Starter setup couldn&apos;t be applied ({success.snapshotError}) — your account works fine; you&apos;ll start from defaults.</p>
            )}
            {success.couponApplied && (
              <p className="flex items-start gap-1.5"><Tag className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                {success.couponApplied.code}: {success.couponApplied.summary} — applied when you add billing at checkout.</p>
            )}
            {success.couponError && (
              <p className="flex items-start gap-1.5 text-muted-foreground"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                Coupon not applied: {success.couponError}. Your trial is unaffected.</p>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      {/* 1 — Tier selection (DB-driven pricing; the same rows /pricing renders) */}
      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-3">1. Pick your plan</div>
        {tiers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Plans are being set up — you can still create your account below and pick a plan later.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {tiers.map((t) => {
              const Icon = TIER_ICON[t.tierName] ?? Building2
              const selected = tier === t.tierName
              return (
                <Card
                  key={t.tierName}
                  onClick={() => pickTier(t.tierName as CanonicalTier)}
                  className={`cursor-pointer transition relative ${selected ? "ring-2 ring-primary border-primary" : "hover:border-muted-foreground/40"}`}
                >
                  {t.featured && !selected && (
                    <Badge className="absolute -top-2 right-3 bg-amber-100 text-amber-800">Most popular</Badge>
                  )}
                  {selected && <CheckCircle2 className="absolute top-3 right-3 h-5 w-5 text-primary" />}
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-1.5"><Icon className="h-4 w-4 text-muted-foreground" />{t.displayName}</CardTitle>
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold">{formatTierPrice(t.monthlyCents)}</span>
                      <span className="text-xs text-muted-foreground">/ month</span>
                    </div>
                    {t.setupCents > 0 ? (
                      <p className="text-[11px] text-muted-foreground">+ {formatTierPrice(t.setupCents)} one-time setup</p>
                    ) : null}
                    {t.description ? <CardDescription className="text-xs mt-1">{t.description}</CardDescription> : null}
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <ul className="text-xs space-y-1.5">
                      {t.bullets.map((f) => (
                        <li key={f} className="flex items-start gap-1.5">
                          <CheckCircle2 className="h-3 w-3 text-primary mt-0.5 shrink-0" />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                    {funnelSnapshots[t.tierName] && (
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1 pt-1 border-t">
                        <Sparkles className="h-3 w-3 text-primary shrink-0" />
                        Day-one branded website + preloaded starter setup included
                      </p>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* 2 — Optional coupon with live validation (validated now, redeemed at signup, billed at checkout) */}
      <Card>
        <CardHeader className="pb-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">2. Have a code? (optional)</div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Tag className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8 uppercase"
                placeholder="e.g. LAUNCH20"
                value={couponInput}
                onChange={(e) => { setCouponInput(e.target.value); if (coupon.status !== "idle") setCoupon({ status: "idle" }) }}
                onBlur={() => checkCoupon(tier, couponInput)}
                aria-label="Coupon code"
              />
            </div>
            <Button type="button" variant="outline" disabled={isPending || !couponInput.trim()} onClick={() => checkCoupon(tier, couponInput)}>
              {coupon.status === "checking" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Check code"}
            </Button>
          </div>
          {coupon.status === "valid" && (
            <p className="text-xs text-emerald-700 flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" />{coupon.code}: {coupon.summary} — applied at checkout
            </p>
          )}
          {coupon.status === "invalid" && <p className="text-xs text-red-600">{coupon.message}</p>}
          <p className="text-[11px] text-muted-foreground">
            Your 14-day trial is free either way — a code discounts the plan price once you add billing.
          </p>
        </CardContent>
      </Card>

      {/* 3 — The signup form (same fields as /signup) */}
      <Card>
        <CardHeader className="pb-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">3. Tell us about your shop</div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="gs-brokerageName" className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5" /> Brokerage / team name
              </Label>
              <Input id="gs-brokerageName" required value={brokerageName} onChange={(e) => setBrokerageName(e.target.value)} placeholder="VIP Premier Realty" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <Label htmlFor="gs-city" className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> City</Label>
                <Input id="gs-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Austin" />
              </div>
              <div>
                <Label htmlFor="gs-state">State</Label>
                <Input id="gs-state" value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="TX" />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="gs-firstName" className="flex items-center gap-1.5"><User className="h-3.5 w-3.5" /> First name</Label>
              <Input id="gs-firstName" required value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="gs-lastName">Last name</Label>
              <Input id="gs-lastName" required value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="gs-email" className="flex items-center gap-1.5"><Briefcase className="h-3.5 w-3.5" /> Work email</Label>
            <Input id="gs-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@brokerage.com" />
            <p className="text-xs text-muted-foreground mt-1">We&apos;ll email a magic link to finish setup. No password needed yet.</p>
          </div>

          {tier === "solo_agent" && (
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-medium">Is your brokerage already on the platform?</p>
              <p className="text-[11px] text-muted-foreground">
                This tells us where your contracts &amp; CDAs go for broker signature + compliance. If your
                brokerage/team isn&apos;t on the platform, we&apos;ll route them to your external form platform
                (set that up later in Settings → Integrations).
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={brokerageOnPlatform} onChange={(e) => setBrokerageOnPlatform(e.target.checked)} className="h-4 w-4" />
                My brokerage is on the platform
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={teamOnPlatform} onChange={(e) => setTeamOnPlatform(e.target.checked)} className="h-4 w-4" />
                My team is on the platform
              </label>
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      <div className="flex flex-col md:flex-row md:items-center md:justify-end gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" required checked={tosAccepted} onChange={(e) => setTosAccepted(e.target.checked)} />
          I agree to the Terms of Service and Privacy Policy (acceptance is recorded with the current terms version).
        </label>
        <Button type="submit" size="lg" disabled={isPending || !tosAccepted}>
          {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Provisioning…</> : "Start free trial"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground text-center">No charge for 14 days. Cancel any time from your billing page.</p>
    </form>
  )
}
