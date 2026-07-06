"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, Loader2, User, Briefcase, Building2, MapPin } from "lucide-react"
import { signupBrokerageAction, type CanonicalTier } from "@/app/actions/auth/signup-brokerage"

// Shape/blurb/features describe each tier; PRICE is never hardcoded here — it comes
// from subscription_tiers via the priceByTier prop (production price changes = DB only).
const TIERS: Array<{
  id:        CanonicalTier
  name:      string
  blurb:     string
  features:  string[]
  highlight: boolean
}> = [
  {
    id:    "solo_agent",
    name:  "Solo Agent",
    blurb: "Single agent operating independently",
    features: ["2M AI tokens / month", "Full kernel + marketing OS", "Up to 500 contacts", "1 active transaction"],
    highlight: false,
  },
  {
    id:    "team",
    name:  "Team",
    blurb: "Lead agent + 2–5 team members (TC, ISA, marketing)",
    features: ["10M AI tokens / month", "Team P&L + per-agent ROI", "Shared brand voice", "Multi-channel campaigns"],
    highlight: true,
  },
  {
    id:    "brokerage",
    name:  "Brokerage",
    blurb: "Full brokerage with broker-of-record + multiple teams",
    features: ["30M AI tokens / month", "Compliance + audit", "Custom brand voice", "Unlimited agents"],
    highlight: false,
  },
  {
    id:    "multi_location",
    name:  "Multi-Location",
    blurb: "Franchise / multi-office network",
    features: ["100M AI tokens / month", "Cross-location reporting", "Dedicated success manager", "SLA + priority support"],
    highlight: false,
  },
]

export interface TierPrice { monthlyCents: number; annualCents: number; setupCents: number }

/** Format cents → "$X" / "$X,XXX" (whole dollars); "—" when the tier has no price yet. */
function fmtPrice(cents: number | undefined): string {
  if (!cents || cents <= 0) return "—"
  return "$" + Math.round(cents / 100).toLocaleString("en-US")
}

export function SignupForm({ priceByTier = {} }: { priceByTier?: Record<string, TierPrice> }) {
  const [tier, setTier] = useState<CanonicalTier>("team")
  const [brokerageName, setBrokerageName] = useState("")
  const [city, setCity]                   = useState("")
  const [state, setState]                 = useState("")
  const [firstName, setFirstName]         = useState("")
  const [lastName, setLastName]           = useState("")
  const [email, setEmail]                 = useState("")
  // Solo-agent only: is the agent's managing brokerage / team also on the platform? This decides
  // whether broker-side steps (CDA signature, compliance) run in-app or route to their external
  // form platform.
  const [brokerageOnPlatform, setBrokerageOnPlatform] = useState(false)
  const [teamOnPlatform, setTeamOnPlatform]           = useState(false)

  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string; trialEndsAt?: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFeedback(null)
    startTransition(async () => {
      const r = await signupBrokerageAction({
        brokerageName, adminFirstName: firstName, adminLastName: lastName, adminEmail: email,
        tier, brokerageCity: city || undefined, brokerageState: state || undefined,
        brokerageOnPlatform: tier === "solo_agent" ? brokerageOnPlatform : undefined,
        teamOnPlatform:      tier === "solo_agent" ? teamOnPlatform : undefined,
      })
      if (!r.ok) {
        setFeedback({ kind: "error", message: r.error ?? "Sign-up failed." })
        return
      }
      setFeedback({
        kind: "success",
        message: `Check ${email} for your invite link. Your trial ends ${r.trialEndsAt ? new Date(r.trialEndsAt).toLocaleDateString() : "in 14 days"}.`,
        trialEndsAt: r.trialEndsAt,
      })
    })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      {/* Tier selection */}
      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-3">1. Pick your tier</div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {TIERS.map(t => (
            <Card
              key={t.id}
              onClick={() => setTier(t.id)}
              className={`cursor-pointer transition relative ${
                tier === t.id ? "ring-2 ring-primary border-primary" : "hover:border-muted-foreground/40"
              }`}
            >
              {t.highlight && tier !== t.id && (
                <Badge className="absolute -top-2 right-3 bg-amber-100 text-amber-800">Most popular</Badge>
              )}
              {tier === t.id && (
                <CheckCircle2 className="absolute top-3 right-3 h-5 w-5 text-primary" />
              )}
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{t.name}</CardTitle>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold">{fmtPrice(priceByTier[t.id]?.monthlyCents)}</span>
                  <span className="text-xs text-muted-foreground">/ month</span>
                </div>
                {priceByTier[t.id]?.setupCents ? (
                  <p className="text-[11px] text-muted-foreground">+ {fmtPrice(priceByTier[t.id]?.setupCents)} one-time setup</p>
                ) : null}
                <CardDescription className="text-xs mt-1">{t.blurb}</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="text-xs space-y-1.5">
                  {t.features.map(f => (
                    <li key={f} className="flex items-start gap-1.5">
                      <CheckCircle2 className="h-3 w-3 text-primary mt-0.5 shrink-0" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Brokerage + admin */}
      <Card>
        <CardHeader className="pb-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">2. Tell us about your shop</div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="brokerageName" className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5" /> Brokerage / team name
              </Label>
              <Input id="brokerageName" required value={brokerageName} onChange={e => setBrokerageName(e.target.value)} placeholder="VIP Premier Realty" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <Label htmlFor="city" className="flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5" /> City
                </Label>
                <Input id="city" value={city} onChange={e => setCity(e.target.value)} placeholder="Austin" />
              </div>
              <div>
                <Label htmlFor="state">State</Label>
                <Input id="state" value={state} maxLength={2} onChange={e => setState(e.target.value.toUpperCase())} placeholder="TX" />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="firstName" className="flex items-center gap-1.5"><User className="h-3.5 w-3.5" /> First name</Label>
              <Input id="firstName" required value={firstName} onChange={e => setFirstName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="lastName">Last name</Label>
              <Input id="lastName" required value={lastName} onChange={e => setLastName(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="email" className="flex items-center gap-1.5"><Briefcase className="h-3.5 w-3.5" /> Work email</Label>
            <Input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@brokerage.com" />
            <p className="text-xs text-muted-foreground mt-1">
              We&apos;ll email a magic link to finish setup. No password needed yet.
            </p>
          </div>

          {tier === "solo_agent" && (
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-medium">Is your brokerage already on the platform?</p>
              <p className="text-[11px] text-muted-foreground">
                This tells us where your contracts &amp; CDAs go for broker signature + compliance. If your
                brokerage/team isn&apos;t on the platform, we&apos;ll route them to your external form platform (set
                that up later in Settings → Integrations).
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={brokerageOnPlatform} onChange={e => setBrokerageOnPlatform(e.target.checked)} className="h-4 w-4" />
                My brokerage is on the platform
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={teamOnPlatform} onChange={e => setTeamOnPlatform(e.target.checked)} className="h-4 w-4" />
                My team is on the platform
              </label>
            </div>
          )}
        </CardContent>
      </Card>

      {feedback && (
        <div className={`rounded-md border p-4 text-sm ${
          feedback.kind === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"
        }`}>
          {feedback.message}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={isPending}>
          {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Provisioning…</> : "Start free trial"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground text-center">
        By signing up you agree to our terms + privacy policy. No charge for 14 days.
      </p>
    </form>
  )
}
