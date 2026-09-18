"use client"

import { useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Slider } from "@/components/ui/slider"
import { toast } from "sonner"
import {
  Sparkles, Calculator, Bot, ShieldCheck, Megaphone, CheckCircle2, ArrowRight, Loader2,
  Network, HeartPulse, PiggyBank,
} from "lucide-react"
import { submitRecruitInquiry } from "./actions"

interface BrokerageView {
  id:             string
  name:           string
  slug:           string
  logoUrl:        string | null
  primaryColor:   string | null
  licenseNumber:  string | null
  licenseState:   string | null
  website:        string | null
  aboutText:      string | null
  pitch:          string | null
  splitToAgent:   number | null
  monthlyFee:     number | null
  valueProps:     string[]
  /** Benefit offerings — fail-closed booleans resolved server-side (`=== true`);
   *  when all are false the benefits section does not render at all. */
  offersRevenueShare: boolean
  offersMedical:      boolean
  offersRetirement:   boolean
}

interface ReferringAgent {
  id:   string
  name: string | null
}

interface Props {
  brokerage:       BrokerageView
  referringAgent:  ReferringAgent | null
}

// Default selling points when the brokerage hasn't customised theirs.
const DEFAULT_VALUE_PROPS = [
  { icon: Bot,         title: "AI ISA that books appointments",   body: "Every new lead gets a personalised conversation 24/7. Qualified appointments hit your calendar — you just show up." },
  { icon: Megaphone,   title: "Marketing engine on autopilot",    body: "Branded videos, social posts, and email campaigns are auto-drafted from your listings and SOI. Approve in one click." },
  { icon: ShieldCheck, title: "Compliance done for you",          body: "Documents auto-scanned, required-doc audits, EM deadlines tracked, packets dispatched to TC. You sell, the platform handles paperwork." },
]

const dollars = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`

export function RecruitingLandingClient({ brokerage, referringAgent }: Props) {
  const searchParams = useSearchParams()
  const refParam = searchParams.get("ref") ?? null

  // ── Lead form state ─────────────────────────────────────────────────────
  const [form, setForm] = useState({
    firstName: "", lastName: "", email: "", phone: "",
    licenseState: brokerage.licenseState ?? "", currentBrokerage: "",
    yearsExperience: "", annualVolume: "", notes: "",
  })
  const [submitting, setSubmitting] = useState(false)
  const [submitted,  setSubmitted]  = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  // ── ROI calculator inputs (sliders + computed outputs) ──────────────────
  // GCI = Gross Commission Income for the year. Split = % the agent keeps.
  const [currentGCI, setCurrentGCI]     = useState<number>(120_000)
  const [currentSplit, setCurrentSplit] = useState<number>(70)
  const [currentMonthlyFee, setCurrentMonthlyFee] = useState<number>(150)

  const roi = useMemo(() => {
    // Conservative estimate: the platform's AI ISA + auto-marketing lifts an
    // average agent's deal count by ~30% per year. Real-world data we've
    // seen during pilot ranges 18-42%; using 30 as a defensible mid-point.
    const productivityLift = 1.30

    const oldNet = currentGCI * (currentSplit / 100) - currentMonthlyFee * 12

    const newSplit = brokerage.splitToAgent ?? 80
    const newFee   = brokerage.monthlyFee ?? 99
    const newGCI   = currentGCI * productivityLift
    const newNet   = newGCI * (newSplit / 100) - newFee * 12

    const annualSavings  = Math.max(0, newNet - oldNet)
    const breakevenMonths = annualSavings > 0 ? Math.ceil((newFee * 12) / annualSavings * 12) : null

    return {
      oldNet:         Math.round(oldNet),
      newNet:         Math.round(newNet),
      annualSavings:  Math.round(annualSavings),
      newGCI:         Math.round(newGCI),
      newSplit,
      newFee,
      lift:           Math.round((productivityLift - 1) * 100),
      breakevenMonths,
    }
  }, [currentGCI, currentSplit, currentMonthlyFee, brokerage.splitToAgent, brokerage.monthlyFee])

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const result = await submitRecruitInquiry({
        brokerageSlug:    brokerage.slug,
        firstName:        form.firstName,
        lastName:         form.lastName,
        email:            form.email,
        phone:            form.phone || undefined,
        licenseState:     form.licenseState || undefined,
        currentBrokerage: form.currentBrokerage || undefined,
        yearsExperience:  form.yearsExperience ? Number(form.yearsExperience) : undefined,
        annualVolume:     form.annualVolume ? Number(form.annualVolume) : undefined,
        notes:            form.notes || undefined,
        referringAgentId: refParam,
      })
      if (result.success) {
        setSubmitted(true)
        toast.success("Got it — the broker will be in touch within 24 hours.")
      } else {
        setError(result.error ?? "Something went wrong. Please try again.")
      }
    } catch (err: any) {
      setError(err?.message ?? "Submission failed")
    } finally {
      setSubmitting(false)
    }
  }

  const valuePropList = brokerage.valueProps.length > 0
    ? brokerage.valueProps.map(text => ({ icon: CheckCircle2, title: text, body: "" }))
    : DEFAULT_VALUE_PROPS

  const heroBg = brokerage.primaryColor ?? "#4f46e5"

  return (
    <div className="min-h-screen bg-background">
      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <header
        className="relative px-4 py-12 sm:py-16 text-white"
        style={{ background: `linear-gradient(135deg, ${heroBg} 0%, #1e1b4b 100%)` }}
      >
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            {brokerage.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brokerage.logoUrl} alt={`${brokerage.name} logo`} className="h-10 w-auto bg-white rounded p-1" />
            )}
            <span className="text-sm uppercase tracking-wide opacity-80">Careers</span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-bold mb-3 max-w-3xl">
            {brokerage.pitch ?? `Why agents are switching to ${brokerage.name}.`}
          </h1>
          <p className="text-base sm:text-lg opacity-90 max-w-2xl">
            We give you back the hours you spend on admin and turn them into closed deals.
            AI ISA, brand-compliant marketing, and compliance automation run for you 24/7.
          </p>
          {referringAgent && (
            <p className="mt-4 text-sm bg-white/15 backdrop-blur inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full">
              <Sparkles className="h-3 w-3" />
              Referred by {referringAgent.name ?? "one of our agents"}
            </p>
          )}
          <div className="mt-6 flex gap-3 flex-wrap">
            <Button asChild size="lg" className="bg-white text-indigo-900 hover:bg-white/90">
              <a href="#apply">Tell me more <ArrowRight className="h-4 w-4 ml-1" /></a>
            </Button>
            <Button asChild size="lg" variant="outline" className="bg-transparent text-white border-white/40 hover:bg-white/10">
              <a href="#calculator">See what you'd earn</a>
            </Button>
          </div>
        </div>
      </header>

      {/* ── Value props ─────────────────────────────────────────────────── */}
      <section className="px-4 py-12 sm:py-16">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-semibold mb-8 text-center">What's actually different here</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {valuePropList.map((vp, i) => {
              const Icon = vp.icon
              return (
                <Card key={i}>
                  <CardHeader className="pb-2">
                    <div className="h-9 w-9 rounded-md bg-indigo-100 flex items-center justify-center mb-2">
                      <Icon className="h-5 w-5 text-indigo-700" />
                    </div>
                    <CardTitle className="text-base">{vp.title}</CardTitle>
                  </CardHeader>
                  {vp.body && (
                    <CardContent>
                      <p className="text-sm text-muted-foreground">{vp.body}</p>
                    </CardContent>
                  )}
                </Card>
              )
            })}
          </div>
        </div>
      </section>

      {/* ── Benefit offerings (m574 + m264) — only what the broker marked; nothing
             offered → no section. Wording states the offering, never plan terms. */}
      {(brokerage.offersRevenueShare || brokerage.offersMedical || brokerage.offersRetirement) && (
        <section className="px-4 pb-12 sm:pb-16">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-2xl font-semibold mb-2 text-center">Benefits {brokerage.name} offers</h2>
            <p className="text-sm text-muted-foreground text-center mb-8">
              Eligibility, enrollment windows, and plan details are governed by the brokerage&apos;s plan
              documents and independent-contractor agreement.
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              {brokerage.offersRevenueShare && (
                <Card>
                  <CardHeader className="pb-2">
                    <div className="h-9 w-9 rounded-md bg-emerald-100 flex items-center justify-center mb-2">
                      <Network className="h-5 w-5 text-emerald-700" />
                    </div>
                    <CardTitle className="text-base">Residual income — revenue share</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      Earn a share of the production of the agents you help bring aboard — income that
                      keeps paying beyond your own closings.
                    </p>
                  </CardContent>
                </Card>
              )}
              {brokerage.offersMedical && (
                <Card>
                  <CardHeader className="pb-2">
                    <div className="h-9 w-9 rounded-md bg-rose-100 flex items-center justify-center mb-2">
                      <HeartPulse className="h-5 w-5 text-rose-700" />
                    </div>
                    <CardTitle className="text-base">Medical benefits</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      Access to medical benefits — rare in this industry, offered here.
                    </p>
                  </CardContent>
                </Card>
              )}
              {brokerage.offersRetirement && (
                <Card>
                  <CardHeader className="pb-2">
                    <div className="h-9 w-9 rounded-md bg-amber-100 flex items-center justify-center mb-2">
                      <PiggyBank className="h-5 w-5 text-amber-700" />
                    </div>
                    <CardTitle className="text-base">Retirement savings</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      A retirement savings option, so commission income can build long-term wealth.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── ROI calculator ──────────────────────────────────────────────── */}
      <section id="calculator" className="px-4 py-12 sm:py-16 bg-muted/40">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-8">
            <Calculator className="h-8 w-8 text-indigo-600 mx-auto mb-2" />
            <h2 className="text-2xl font-semibold">See what you'd earn at {brokerage.name}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Plug in where you are today. The math below is the difference for your first 12 months —
              including the platform&apos;s typical ~30% deal-volume lift from AI ISA + marketing automation.
            </p>
          </div>

          <Card>
            <CardContent className="py-6 space-y-6">
              <div>
                <Label className="flex items-center justify-between mb-2">
                  <span>Your current annual GCI</span>
                  <span className="text-sm text-muted-foreground">{dollars(currentGCI)}</span>
                </Label>
                <Slider value={[currentGCI]} min={40_000} max={500_000} step={5_000} onValueChange={(v) => setCurrentGCI(v[0])} />
              </div>
              <div>
                <Label className="flex items-center justify-between mb-2">
                  <span>Your current split (% you keep)</span>
                  <span className="text-sm text-muted-foreground">{currentSplit}%</span>
                </Label>
                <Slider value={[currentSplit]} min={50} max={100} step={1} onValueChange={(v) => setCurrentSplit(v[0])} />
              </div>
              <div>
                <Label className="flex items-center justify-between mb-2">
                  <span>Your current monthly fees</span>
                  <span className="text-sm text-muted-foreground">{dollars(currentMonthlyFee)}/mo</span>
                </Label>
                <Slider value={[currentMonthlyFee]} min={0} max={1000} step={25} onValueChange={(v) => setCurrentMonthlyFee(v[0])} />
              </div>

              <div className="grid gap-3 sm:grid-cols-3 pt-2 border-t">
                <div className="text-center">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Today take-home</p>
                  <p className="text-2xl font-bold mt-1">{dollars(roi.oldNet)}</p>
                </div>
                <div className="text-center bg-emerald-50 rounded-lg py-3">
                  <p className="text-xs uppercase tracking-wide text-emerald-700">At {brokerage.name}</p>
                  <p className="text-2xl font-bold mt-1 text-emerald-900">{dollars(roi.newNet)}</p>
                  <p className="text-[10px] text-emerald-700/80 mt-0.5">{roi.newSplit}% split · {dollars(roi.newFee)}/mo fee</p>
                </div>
                <div className="text-center bg-indigo-50 rounded-lg py-3">
                  <p className="text-xs uppercase tracking-wide text-indigo-700">Annual difference</p>
                  <p className="text-2xl font-bold mt-1 text-indigo-900">+{dollars(roi.annualSavings)}</p>
                  <p className="text-[10px] text-indigo-700/80 mt-0.5">Includes +{roi.lift}% deal-volume lift</p>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground text-center">
                Estimate only — actual outcomes depend on your market, lead volume, and time-on-platform.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ── Apply form ──────────────────────────────────────────────────── */}
      <section id="apply" className="px-4 py-12 sm:py-16">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-6">
            <h2 className="text-2xl font-semibold">Talk to {brokerage.name}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Fill out the form — broker will reach out within 24 hours. No pressure, no recruiter scripts.
            </p>
          </div>

          {submitted ? (
            <Card className="border-emerald-300 bg-emerald-50/60">
              <CardContent className="py-10 text-center space-y-2">
                <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
                <p className="text-base font-medium text-emerald-900">Got it — broker will reach out shortly.</p>
                <p className="text-sm text-emerald-950/70">
                  {referringAgent ? `Thanks for using ${referringAgent.name ?? "your contact"}'s referral link.` : "Check your inbox for a personal note from the broker."}
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-6">
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="firstName">First name *</Label>
                      <Input id="firstName" required value={form.firstName} onChange={(e) => setForm(f => ({ ...f, firstName: e.target.value }))} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="lastName">Last name *</Label>
                      <Input id="lastName" required value={form.lastName} onChange={(e) => setForm(f => ({ ...f, lastName: e.target.value }))} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="email">Email *</Label>
                      <Input id="email" type="email" required value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="phone">Phone</Label>
                      <Input id="phone" type="tel" value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="licenseState">License state</Label>
                      <Input id="licenseState" maxLength={2} placeholder="TX" value={form.licenseState} onChange={(e) => setForm(f => ({ ...f, licenseState: e.target.value.toUpperCase() }))} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="yearsExperience">Years licensed</Label>
                      <Input id="yearsExperience" type="number" min={0} max={60} value={form.yearsExperience} onChange={(e) => setForm(f => ({ ...f, yearsExperience: e.target.value }))} />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="currentBrokerage">Current brokerage</Label>
                    <Input id="currentBrokerage" value={form.currentBrokerage} onChange={(e) => setForm(f => ({ ...f, currentBrokerage: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="annualVolume">Last 12-month sales volume ($)</Label>
                    <Input id="annualVolume" type="number" min={0} value={form.annualVolume} onChange={(e) => setForm(f => ({ ...f, annualVolume: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="notes">What matters most to you in a brokerage?</Label>
                    <Textarea id="notes" rows={3} value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} />
                  </div>

                  {error && <p className="text-sm text-destructive">{error}</p>}

                  <Button type="submit" size="lg" className="w-full" disabled={submitting}>
                    {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                    Send my information
                  </Button>
                  <p className="text-[10px] text-muted-foreground text-center">
                    Your information is only shared with {brokerage.name}. We never share recruit data with third parties.
                  </p>
                </form>
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      {/* ── Footer attribution ─────────────────────────────────────────── */}
      <footer className="px-4 py-6 border-t bg-muted/30">
        <div className="max-w-5xl mx-auto text-center text-xs text-muted-foreground space-y-1">
          <p>
            {brokerage.name}
            {brokerage.licenseNumber && ` · License #${brokerage.licenseNumber}${brokerage.licenseState ? ` (${brokerage.licenseState})` : ""}`}
          </p>
          {brokerage.website && (
            <p>
              <a href={brokerage.website} target="_blank" rel="noreferrer" className="hover:underline">
                {brokerage.website}
              </a>
            </p>
          )}
          <p className="opacity-70">Equal Housing Opportunity</p>
        </div>
      </footer>
    </div>
  )
}
