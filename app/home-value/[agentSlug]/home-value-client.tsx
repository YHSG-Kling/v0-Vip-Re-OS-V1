"use client"

import { useState } from "react"
import { Loader2, Home, MapPin, TrendingUp, AlertTriangle, CheckCircle2, Phone, Mail } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { evaluatePropertyAction } from "@/app/actions/property-evaluation"
import { captureHomeValueLead } from "@/app/actions/home-value-lead"
import type { PropertyEvaluation, EvaluationAudience } from "@/lib/property/property-evaluation"

interface BrandingProps {
  agentId: string
  userId: string
  brokerageId: string
  agentName: string
  brokerageName: string | null
  brokeragePhone: string | null
  agentPhone: string | null
  agentEmail: string | null
  agentLicense: string | null
  licenseState: string | null
  photoUrl: string | null
  primaryColor: string | null
}

type Stage = "form" | "evaluating" | "results" | "captured"

function fmt(v: number | null) {
  if (v == null) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v)
}

export function HomeValueClient({ branding }: { branding: BrandingProps }) {
  const [stage, setStage] = useState<Stage>("form")
  const [audience, setAudience] = useState<EvaluationAudience>("homeowner")

  const [address, setAddress] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState(branding.licenseState ?? "")
  const [zip, setZip] = useState("")
  const [evaluation, setEvaluation] = useState<PropertyEvaluation | null>(null)
  const [evalError, setEvalError] = useState<string | null>(null)

  // Lead capture form
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function runEvaluation(e: React.FormEvent) {
    e.preventDefault()
    setEvalError(null)
    if (!address.trim() || !city.trim() || !state.trim()) {
      setEvalError("Please enter address, city, and state.")
      return
    }
    setStage("evaluating")
    try {
      const result = await evaluatePropertyAction({
        address: address.trim(),
        city: city.trim(),
        state: state.trim().toUpperCase(),
        zip: zip.trim() || undefined,
        audience,
        // Investor mode pulls REAL rental comparables, which are metered against
        // a tenant. The action resolves the brokerage from this id server-side —
        // it deliberately does not accept a brokerage id from the browser.
        agentId: branding.agentId,
      })
      setEvaluation(result)
      setStage("results")
    } catch (err: any) {
      setEvalError(err?.message ?? "Could not generate estimate")
      setStage("form")
    }
  }

  async function submitLead(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    if (!fullName.trim() || (!email.trim() && !phone.trim()) || !consent) {
      setSubmitError("Name, contact info, and consent are all required.")
      return
    }
    setSubmitting(true)
    const result = await captureHomeValueLead({
      agentId: branding.agentId,
      brokerageId: branding.brokerageId,
      agentUserId: branding.userId,
      fullName: fullName.trim(),
      email: email.trim(),
      phone: phone.trim() || undefined,
      consentToContact: consent,
      property: {
        address: address.trim(),
        city: city.trim(),
        state: state.trim().toUpperCase(),
        zip: zip.trim() || undefined,
        estimatedValue: evaluation?.estimatedValue ?? null,
      },
    })
    setSubmitting(false)
    if (result.success) {
      setStage("captured")
    } else {
      setSubmitError(result.error ?? "Submission failed")
    }
  }

  const brand = branding.primaryColor ?? "#0f172a"

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Branded header */}
      <header className="bg-white border-b" style={{ borderTopColor: brand, borderTopWidth: 4 }}>
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-4">
          {branding.photoUrl ? (
            <img src={branding.photoUrl} alt={branding.agentName} className="h-12 w-12 rounded-full object-cover" />
          ) : (
            <div
              className="h-12 w-12 rounded-full flex items-center justify-center text-white font-semibold"
              style={{ backgroundColor: brand }}
            >
              {branding.agentName.charAt(0)}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-gray-900">{branding.agentName}</p>
            {branding.brokerageName && (
              <p className="text-xs text-gray-500 truncate">{branding.brokerageName}</p>
            )}
          </div>
          <div className="hidden sm:flex items-center gap-3 text-xs text-gray-500">
            {branding.agentPhone && (
              <a href={`tel:${branding.agentPhone}`} className="flex items-center gap-1 hover:text-gray-900">
                <Phone className="h-3 w-3" /> {branding.agentPhone}
              </a>
            )}
            {branding.agentEmail && (
              <a href={`mailto:${branding.agentEmail}`} className="flex items-center gap-1 hover:text-gray-900">
                <Mail className="h-3 w-3" />
                Contact
              </a>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        {stage === "form" && (
          <FormStage
            address={address} setAddress={setAddress}
            city={city} setCity={setCity}
            state={state} setState={setState}
            zip={zip} setZip={setZip}
            audience={audience} setAudience={setAudience}
            onSubmit={runEvaluation}
            error={evalError}
            brand={brand}
          />
        )}

        {stage === "evaluating" && (
          <Card>
            <CardContent className="p-12 flex flex-col items-center text-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
              <p className="text-sm font-medium">Analyzing comparable sales…</p>
              <p className="text-xs text-gray-500">This usually takes 10–20 seconds.</p>
            </CardContent>
          </Card>
        )}

        {stage === "results" && evaluation && (
          <ResultsStage
            evaluation={evaluation}
            audience={audience}
            address={address}
            city={city}
            state={state}
            fullName={fullName} setFullName={setFullName}
            email={email} setEmail={setEmail}
            phone={phone} setPhone={setPhone}
            consent={consent} setConsent={setConsent}
            submitting={submitting}
            submitError={submitError}
            onSubmit={submitLead}
            agentName={branding.agentName}
            brand={brand}
          />
        )}

        {stage === "captured" && (
          <Card className="border-green-200">
            <CardContent className="p-8 text-center space-y-3">
              <CheckCircle2 className="h-10 w-10 text-green-600 mx-auto" />
              <h2 className="text-xl font-semibold">Thanks, {fullName.split(" ")[0]}!</h2>
              <p className="text-sm text-gray-600">
                {branding.agentName} will reach out shortly with your full report
                and answer any questions about {address}, {city}.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Always-on disclosures footer */}
        <Disclaimers evaluation={evaluation} state={state} agentLicense={branding.agentLicense} />
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stage: Address form
// ---------------------------------------------------------------------------

function FormStage(props: {
  address: string; setAddress: (v: string) => void
  city: string; setCity: (v: string) => void
  state: string; setState: (v: string) => void
  zip: string; setZip: (v: string) => void
  audience: EvaluationAudience; setAudience: (v: EvaluationAudience) => void
  onSubmit: (e: React.FormEvent) => void
  error: string | null
  brand: string
}) {
  return (
    <Card>
      <CardContent className="p-6 sm:p-8">
        <div className="text-center mb-6">
          <Home className="h-10 w-10 mx-auto mb-3" style={{ color: props.brand }} />
          <h1 className="text-2xl font-bold mb-1">What's your home worth?</h1>
          <p className="text-sm text-gray-600">
            Get an instant AI-powered estimate based on real comparable sales.
          </p>
        </div>

        <form onSubmit={props.onSubmit} className="space-y-4">
          {/* Audience toggle */}
          <div>
            <Label className="text-xs">I'm a</Label>
            <div className="grid grid-cols-2 gap-2 mt-1">
              {(["homeowner", "investor"] as const).map((a) => (
                <button
                  type="button"
                  key={a}
                  onClick={() => props.setAudience(a)}
                  className={`p-2 rounded border text-sm capitalize transition-colors ${
                    props.audience === a
                      ? "border-gray-900 bg-gray-900 text-white font-medium"
                      : "border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
            {props.audience === "investor" && (
              <p className="text-xs text-gray-500 mt-1">
                You'll get cap rate, cash-on-cash, ARV, and rental comps.
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="address">Street Address</Label>
            <Input id="address" required value={props.address}
              onChange={(e) => props.setAddress(e.target.value)} placeholder="123 Main St" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Label htmlFor="city">City</Label>
              <Input id="city" required value={props.city}
                onChange={(e) => props.setCity(e.target.value)} placeholder="Tampa" />
            </div>
            <div>
              <Label htmlFor="state">State</Label>
              <Input id="state" required value={props.state} maxLength={2}
                onChange={(e) => props.setState(e.target.value.toUpperCase())} placeholder="FL" />
            </div>
          </div>

          <div>
            <Label htmlFor="zip">ZIP (optional)</Label>
            <Input id="zip" value={props.zip}
              onChange={(e) => props.setZip(e.target.value)} placeholder="33601" />
          </div>

          {props.error && (
            <p className="text-xs text-red-600 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> {props.error}
            </p>
          )}

          <Button type="submit" className="w-full" style={{ backgroundColor: props.brand }}>
            Get My Estimate
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Stage: Results + lead capture
// ---------------------------------------------------------------------------

function ResultsStage(props: {
  evaluation: PropertyEvaluation
  audience: EvaluationAudience
  address: string; city: string; state: string
  fullName: string; setFullName: (v: string) => void
  email: string; setEmail: (v: string) => void
  phone: string; setPhone: (v: string) => void
  consent: boolean; setConsent: (v: boolean) => void
  submitting: boolean
  submitError: string | null
  onSubmit: (e: React.FormEvent) => void
  agentName: string
  brand: string
}) {
  const e = props.evaluation
  const insufficient = e.confidenceLevel === "insufficient_data"

  return (
    <div className="space-y-6">
      {/* Estimated value */}
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-xs text-gray-500 flex items-center justify-center gap-1 mb-2">
            <MapPin className="h-3 w-3" />
            {props.address}, {props.city}, {props.state}
          </p>

          {insufficient ? (
            <div className="space-y-3">
              <AlertTriangle className="h-8 w-8 mx-auto text-amber-500" />
              <p className="text-sm text-gray-700">
                We couldn't find enough recent comparable sales to generate a confident estimate.
              </p>
              <p className="text-xs text-gray-500">
                {e.methodology.rationale ||
                  "A manual CMA from your agent will be more accurate."}
              </p>
            </div>
          ) : (
            <>
              <div className="text-4xl font-bold mb-1" style={{ color: props.brand }}>
                {fmt(e.estimatedValue)}
              </div>
              <p className="text-xs text-gray-500">
                Estimated value · range {fmt(e.valueRangeLow)} – {fmt(e.valueRangeHigh)}
              </p>
              <ConfidenceBadge level={e.confidenceLevel} />

              {props.audience === "homeowner" && (
                <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                  <PriceTile label="Quick Sale" value={e.quickSalePrice} />
                  <PriceTile label="Recommended" value={e.recommendedListPrice} highlight />
                  <PriceTile label="Premium" value={e.premiumPrice} />
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Investor metrics.
          The `!insufficient` condition was removed deliberately. The rent and
          the rental listings are PROVIDER-SOURCED and do not depend on the
          model's comparable SALES, so hiding them because the sales side was
          thin would delete real data to hide the absence of other data — the
          silent-omission failure. The four ratios need a value estimate, which
          the quality gate nulls, so they simply read "—" and the derivation note
          beneath says what they are made of. */}
      {props.audience === "investor" && e.investor && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="h-4 w-4 text-gray-400" />
              <h3 className="text-sm font-semibold">Investor Metrics</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <Metric label="Median Asking Rent / mo" value={fmt(e.investor.estimatedMonthlyRent)} />
              <Metric label="Cap Rate" value={e.investor.capRate ? `${e.investor.capRate.toFixed(2)}%` : "—"} />
              <Metric label="Gross Yield" value={e.investor.grossYield ? `${e.investor.grossYield.toFixed(2)}%` : "—"} />
              <Metric label="Cash-on-Cash" value={e.investor.cashOnCashReturn ? `${e.investor.cashOnCashReturn.toFixed(2)}%` : "—"} />
              <Metric label="ARV" value={fmt(e.investor.arv)} />
              <Metric label="Est. Rehab" value={fmt(e.investor.estimatedRehab)} />
              <Metric label="DSCR" value={e.investor.dscr ? e.investor.dscr.toFixed(2) : "—"} />
            </div>

            {/* WHERE THE RENT CAME FROM — or that it came from nowhere.
                These numbers used to be authored by a language model and shown
                with no attribution at all. A rent on an agent-branded page is
                read as market data, so the source is stated on the same card as
                the figure, and an ABSENT rent is stated too rather than leaving
                a dash the reader has to interpret. */}
            {e.investor.rentSource.available ? (
              <div className="mt-3 rounded-md bg-gray-50 border border-gray-200 p-3">
                <p className="text-[11px] text-gray-600">
                  <span className="font-medium">Rent source:</span> median asking rent of{" "}
                  {e.investor.rentSource.sampleSize} comparable rental listing
                  {e.investor.rentSource.sampleSize === 1 ? "" : "s"} published by RentCast
                  {e.investor.rentSource.rangeLow != null && e.investor.rentSource.rangeHigh != null
                    ? ` (range ${fmt(e.investor.rentSource.rangeLow)}–${fmt(e.investor.rentSource.rangeHigh)}/mo)`
                    : ""}
                  . These are asking rents, not an appraisal and not a guarantee of rental income.
                </p>
                <p className="text-[11px] text-gray-500 mt-2">{e.investor.derivationNote}</p>
              </div>
            ) : (
              <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-3">
                <p className="text-[11px] text-amber-900">
                  <span className="font-medium">No rental data available.</span>{" "}
                  {e.investor.rentSource.unavailableNote}
                </p>
                <p className="text-[11px] text-amber-800 mt-1">
                  No rent was estimated in its place, so the rent-based figures above are blank
                  rather than approximated.
                </p>
              </div>
            )}

            {/* The rental listings the median was measured over — real published
                listings, shown so the figure can be checked. */}
            {e.investor.rentComps.length > 0 && (
              <div className="mt-3">
                <h4 className="text-xs font-semibold mb-2">
                  Comparable rental listings ({e.investor.rentComps.length})
                </h4>
                <div className="space-y-1 text-xs">
                  {e.investor.rentComps.slice(0, 5).map((r, i) => (
                    <div key={i} className="flex justify-between border-b last:border-0 pb-1.5">
                      <div className="text-gray-600 truncate flex-1">{r.address}</div>
                      <div className="font-medium ml-3">{fmt(r.monthlyRent)}/mo</div>
                      <div className="text-gray-400 ml-2 text-right w-16">
                        {r.beds != null ? `${r.beds} bd` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Comparables summary */}
      {e.comparables.length > 0 && (
        <Card>
          <CardContent className="p-6">
            <h3 className="text-sm font-semibold mb-3">
              Based on {e.comparables.length} comparable sale{e.comparables.length === 1 ? "" : "s"}
            </h3>
            <div className="space-y-2 text-xs">
              {e.comparables.slice(0, 4).map((c, i) => (
                <div key={i} className="flex justify-between border-b last:border-0 pb-1.5">
                  <div className="text-gray-600 truncate flex-1">{c.address}</div>
                  <div className="font-medium ml-3">{fmt(c.salePrice)}</div>
                  <div className="text-gray-400 ml-2 text-right w-20">
                    {c.distanceMiles ? `${c.distanceMiles.toFixed(1)} mi` : ""}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-3">
              {e.methodology.rationale}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Lead capture */}
      <Card style={{ borderTopColor: props.brand, borderTopWidth: 3 }}>
        <CardContent className="p-6">
          <h3 className="text-base font-semibold mb-1">Get your full report</h3>
          <p className="text-xs text-gray-600 mb-4">
            {props.agentName} will send you a detailed analysis with neighborhood trends and answer any questions.
          </p>

          <form onSubmit={props.onSubmit} className="space-y-3">
            <div>
              <Label htmlFor="fullName">Full Name</Label>
              <Input id="fullName" required value={props.fullName}
                onChange={(ev) => props.setFullName(ev.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={props.email}
                  onChange={(ev) => props.setEmail(ev.target.value)} />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" type="tel" value={props.phone}
                  onChange={(ev) => props.setPhone(ev.target.value)} />
              </div>
            </div>

            <label className="flex items-start gap-2 text-xs text-gray-600 pt-1">
              <Checkbox
                checked={props.consent}
                onCheckedChange={(c) => props.setConsent(Boolean(c))}
                className="mt-0.5"
              />
              <span>
                I agree to be contacted by {props.agentName} about real estate services
                via the contact methods I provided. I understand I can opt out at any time.
              </span>
            </label>

            {props.submitError && (
              <p className="text-xs text-red-600">{props.submitError}</p>
            )}

            <Button
              type="submit"
              disabled={props.submitting}
              className="w-full"
              style={{ backgroundColor: props.brand }}
            >
              {props.submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send My Full Report"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function ConfidenceBadge({ level }: { level: string }) {
  const map: Record<string, { label: string; color: string }> = {
    high: { label: "High confidence", color: "text-green-700 bg-green-50" },
    medium: { label: "Medium confidence", color: "text-amber-700 bg-amber-50" },
    low: { label: "Low confidence", color: "text-orange-700 bg-orange-50" },
    insufficient_data: { label: "Insufficient data", color: "text-red-700 bg-red-50" },
  }
  const m = map[level] ?? map.low
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full mt-2 ${m.color}`}>
      {m.label}
    </span>
  )
}

function PriceTile({ label, value, highlight }: { label: string; value: number | null; highlight?: boolean }) {
  return (
    <div className={`p-2 rounded ${highlight ? "bg-gray-100 font-semibold" : "bg-gray-50"}`}>
      <div className="text-gray-500 text-[10px] uppercase tracking-wide">{label}</div>
      <div className="text-sm">{fmt(value)}</div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  )
}

function Disclaimers({
  evaluation,
  state,
  agentLicense,
}: {
  evaluation: PropertyEvaluation | null
  state: string
  agentLicense: string | null
}) {
  if (!evaluation) {
    return (
      <p className="text-[10px] text-gray-400 mt-6 text-center">
        Estimates are not appraisals. Consult a licensed appraiser for legally binding valuations.
      </p>
    )
  }

  return (
    <div className="mt-8 pt-6 border-t text-[10px] text-gray-500 space-y-2">
      <p className="font-semibold uppercase tracking-wide">Disclosures</p>
      <p>{evaluation.disclosures.avmDisclosure}</p>
      {evaluation.disclosures.stateSpecific.map((s, i) => (
        <p key={i}>{s}</p>
      ))}
      <p>{evaluation.disclosures.fairHousing}</p>
      <p>{evaluation.disclosures.dataSourceCitation}</p>
      {agentLicense && state && (
        <p>License: {agentLicense} ({state})</p>
      )}
    </div>
  )
}
