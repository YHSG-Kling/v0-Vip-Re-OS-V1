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
// Lane 79D — the seat band is lane 79A's ONE derivation (client-reachable pure
// module); the form never restates a seat number. The routing rule itself
// (sales-assisted vs self-serve) runs SERVER-SIDE in signupBrokerageAction
// (lib/platform/subscriber-door.ts) — this file only previews it.
import { tierForSeatCount, TIER_SEAT_BANDS } from "@/lib/billing/plan-catalog"

/** The band line beside a tier card — derived from TIER_SEAT_BANDS, never a literal. */
function seatBandLine(tierName: string): string {
  const band = (TIER_SEAT_BANDS as Record<string, number | null>)[tierName]
  if (band === undefined) return ""
  if (band === null) return tierName === "multi_location" ? "Custom seat pricing — a person quotes it" : "Unlimited producing seats"
  return `Up to ${band} producing seat${band === 1 ? "" : "s"} · staff & admins free`
}

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

export function TrialFunnelForm({ tiers = [], funnelSnapshots = {}, initialTier = null, initialZip = null }: {
  tiers?: PublicTier[]
  funnelSnapshots?: FunnelSnapshotMap
  initialTier?: string | null
  initialZip?: string | null
}) {
  const defaultTier = (initialTier && tiers.some((t) => t.tierName === initialTier)
    ? initialTier
    : (tiers.find((t) => t.featured)?.tierName ?? tiers[0]?.tierName ?? "team")) as CanonicalTier
  const [tier, setTier] = useState<CanonicalTier>(defaultTier)
  // Wave 78A — not everyone wants the trial. 'paid' = activate now: the server
  // mints a hosted checkout (plan + the tier's one-time setup fee) and we send
  // the signer there; access opens when it clears. The fee shown is the
  // tier row's own setup_fee_cents — never a number this form knows.
  const [activation, setActivation] = useState<"trial" | "paid">("trial")
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly")
  const selectedTier = tiers.find((t) => t.tierName === tier) ?? null
  // Lane 79D — producing seats pick the band; a custom-pricing ask or the
  // multi-location shape means a PERSON prices it (sales-assisted, no tenant
  // until then). What they use today opens the white-glove import task.
  const [producerSeats, setProducerSeats] = useState("")
  const [customPricing, setCustomPricing] = useState(false)
  const [currentTools, setCurrentTools] = useState("")
  // Honeypot — hidden from humans; a filled value is refused server-side.
  const [website, setWebsite] = useState("")
  const seatsNumber = Number(producerSeats)
  const fittedTier = producerSeats.trim() && Number.isFinite(seatsNumber) && seatsNumber > 0 ? tierForSeatCount(seatsNumber) : null
  const fittedPublicTier = fittedTier ? tiers.find((t) => t.tierName === fittedTier) ?? null : null
  const salesAssisted = tier === "multi_location" || customPricing

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
        // Territory carry from /pricing (merged in from the retired /signup form).
        territoryZip: initialZip ?? undefined,
        activation,
        billingCycle: activation === "paid" ? billingCycle : undefined,
        producerSeats: fittedTier ? Math.round(seatsNumber) : null,
        customPricingRequested: customPricing,
        currentTools: currentTools.trim() || null,
        website,
      })
      if (!r.ok) { setError(r.error ?? "Sign-up failed."); return }
      setSuccess(r)
      // Paid activation: straight to the hosted checkout. The success card
      // below still renders behind it (and stays if the redirect is blocked).
      if (r.activation === "paid" && r.checkoutUrl) window.location.assign(r.checkoutUrl)
    })
  }

  if (success && success.route === "existing_subscriber") {
    return (
      <Card>
        <CardContent className="p-8 text-center space-y-2">
          <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-600" />
          <p className="font-medium">{email} already has an account.</p>
          <p className="text-sm text-muted-foreground">Sign in instead — plan changes, seats and billing all live inside the app. <a className="underline" href="/login">Go to sign-in</a>.</p>
        </CardContent>
      </Card>
    )
  }

  if (success && success.route === "sales_assisted") {
    return (
      <Card>
        <CardContent className="p-8 space-y-3">
          <div className="text-center">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-600" />
            <p className="font-medium">Got it — a person prices this one.</p>
            <p className="text-sm text-muted-foreground mt-1">
              {success.tier === "multi_location" ? "Multi-location seats are priced per office, so we don't charge a card until someone has quoted you." : "You asked for custom pricing, so nothing is charged until a person has quoted you."}
              {" "}Your details are with our team ({success.staffNotified ?? 0} notified) and nothing has been created or charged.
            </p>
          </div>
          <div className="text-sm text-center space-y-1.5">
            <p>Want it faster? <a className="underline font-medium" href={success.bookingPath ?? "/demo"}>Book a 15-minute call</a> — same details, no re-typing.</p>
            <p className="text-xs text-muted-foreground">Once you have a number you like, your workspace is created on the spot — trial or activate now, your call.</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (success) {
    const paid = success.activation === "paid"
    return (
      <Card>
        <CardContent className="p-8 space-y-3">
          <div className="text-center">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-600" />
            <p className="font-medium">You&apos;re in — check {email} for your invite link.</p>
            {paid ? (
              success.checkoutUrl ? (
                <p className="text-sm text-muted-foreground mt-1">
                  Taking you to the secure checkout to activate your plan{success.setupFeeCents && success.setupFeeCents > 0 ? ` (plus a one-time ${formatTierPrice(success.setupFeeCents)} setup fee)` : ""}.
                  If nothing happens, <a className="underline" href={success.checkoutUrl}>open the checkout</a>{success.checkoutEmailed ? " — we also emailed it to you" : ""}. Your workspace opens the moment it clears.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground mt-1">
                  Your account is reserved, but the checkout couldn&apos;t be created right now{success.checkoutError ? ` (${success.checkoutError})` : ""}. Sign in with your invite link and activate from the billing page.
                </p>
              )
            ) : (
              <p className="text-sm text-muted-foreground mt-1">
                Your free trial ends {success.trialEndsAt ? new Date(success.trialEndsAt).toLocaleDateString() : "in 14 days"}. No card on file until you add billing.
              </p>
            )}
          </div>
          <div className="text-sm space-y-1.5 max-w-md mx-auto">
            {(success.humanReasons?.length ?? 0) > 0 && (
              <p className="flex items-start gap-1.5"><User className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                A person from our team will reach out about your data import — your AI managers start onboarding you in the meantime.</p>
            )}
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
        {/* Lane 79D — producing seats fit the plan (staff & admins never take a seat) */}
        <div className="rounded-lg border bg-muted/30 p-3 mb-3 flex flex-col md:flex-row md:items-center gap-3">
          <div className="flex-1">
            <Label htmlFor="gs-seats" className="text-xs">How many producing agents (licensed, closing deals)?</Label>
            <p className="text-[11px] text-muted-foreground">Staff, admins and your compliance officer are free — only producers take a seat. Hit a limit later and you can add seat packages or move tiers either way.</p>
          </div>
          <div className="flex items-center gap-2">
            <Input id="gs-seats" type="number" min={1} max={100000} inputMode="numeric" className="w-24" placeholder="e.g. 4" value={producerSeats} onChange={(e) => setProducerSeats(e.target.value)} />
            {fittedTier && fittedTier !== tier && fittedPublicTier && (
              <Button type="button" size="sm" variant="outline" onClick={() => pickTier(fittedTier as CanonicalTier)}>Fit: {fittedPublicTier.displayName}</Button>
            )}
            {fittedTier && fittedTier === tier && <span className="text-xs text-emerald-700 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" />fits {selectedTier?.displayName ?? tier}</span>}
          </div>
        </div>
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
                    {seatBandLine(t.tierName) ? <p className="text-[11px] text-muted-foreground">{seatBandLine(t.tierName)}</p> : null}
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

      {/* 1b — Trial or activate now (wave 78A). The setup fee is the tier row's own number. */}
      <Card>
        <CardHeader className="pb-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">How do you want to start?</div>
        </CardHeader>
        <CardContent className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="gs-activation" className="mt-1" checked={activation === "trial"} onChange={() => setActivation("trial")} />
            <span><span className="font-medium">Free 14-day trial</span> — no card now; add billing inside the app when you&apos;re ready.</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="gs-activation" className="mt-1" checked={activation === "paid"} onChange={() => setActivation("paid")} />
            <span>
              <span className="font-medium">Activate now</span> — skip the trial and go straight to a secure checkout for the {selectedTier?.displayName ?? "plan"}
              {selectedTier && selectedTier.setupCents > 0
                ? <> plus a one-time <span className="font-medium">{formatTierPrice(selectedTier.setupCents)} setup fee</span> (onboarding, data import, your AI twin and voice setup).</>
                : <>. This plan lists no setup fee.</>}
              {" "}Your workspace opens the moment it clears.
            </span>
          </label>
          {activation === "paid" && (
            <div className="flex items-center gap-3 pl-6 text-xs">
              <span className="text-muted-foreground">Bill me</span>
              <label className="flex items-center gap-1"><input type="radio" name="gs-cycle" checked={billingCycle === "monthly"} onChange={() => setBillingCycle("monthly")} /> monthly {selectedTier ? `(${formatTierPrice(selectedTier.monthlyCents)}/mo)` : ""}</label>
              <label className="flex items-center gap-1"><input type="radio" name="gs-cycle" checked={billingCycle === "annual"} onChange={() => setBillingCycle("annual")} /> annually {selectedTier && selectedTier.annualCents > 0 ? `(${formatTierPrice(selectedTier.annualCents)}/yr)` : ""}</label>
            </div>
          )}
        </CardContent>
      </Card>

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
          {initialZip && (
            <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground flex items-start gap-2">
              <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Territory carried from pricing: <span className="font-medium text-foreground">{initialZip}</span>.
                We&apos;ll suggest it as your first market during onboarding — nothing is claimed until you create the market.
              </span>
            </div>
          )}
          <div>
            <Label htmlFor="gs-email" className="flex items-center gap-1.5"><Briefcase className="h-3.5 w-3.5" /> Work email</Label>
            <Input id="gs-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@brokerage.com" />
            <p className="text-xs text-muted-foreground mt-1">We&apos;ll email a magic link to finish setup. No password needed yet.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="gs-tools">What do you use today? (optional)</Label>
              <Input id="gs-tools" value={currentTools} onChange={(e) => setCurrentTools(e.target.value)} placeholder="e.g. Follow Up Boss, kvCORE, spreadsheets" />
              <p className="text-[11px] text-muted-foreground mt-1">Coming off a CRM? A person handles the import for you — your account is created either way.</p>
            </div>
            <label className="flex items-start gap-2 text-sm pt-5">
              <input type="checkbox" className="mt-1" checked={customPricing} onChange={(e) => setCustomPricing(e.target.checked)} />
              <span>I need custom pricing or a contract <span className="block text-[11px] text-muted-foreground">A person quotes it before anything is charged.</span></span>
            </label>
          </div>
          {/* Honeypot — invisible to people, filled only by bots. */}
          <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
            <label>Website<input type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
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
          {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{salesAssisted ? "Sending…" : "Provisioning…"}</> : salesAssisted ? "Get my quote" : activation === "paid" ? "Activate now" : "Start free trial"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground text-center">
        {salesAssisted
          ? "Multi-location and custom pricing are quoted by a person first — nothing is created or charged until you've agreed a number."
          : activation === "paid"
          ? "You'll complete payment on the next screen (we email the checkout too). Cancel any time from your billing page."
          : "No charge for 14 days. Cancel any time from your billing page."}
      </p>
    </form>
  )
}
