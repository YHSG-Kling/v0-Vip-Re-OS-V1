"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { submitHomeValueRequest } from "@/app/actions/home-value"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ArrowRight, ArrowLeft, Loader2, Home, ClipboardList, User, Shield, CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { PROPERTY_TYPE_OPTIONS } from "@/lib/constants"

interface ActiveQuestions {
  sellTimeline?: boolean
  motivation?: boolean
  mortgageStatus?: boolean
  priceExpectation?: boolean
  hasAgent?: boolean
  buyAfterSell?: boolean
  additionalNotes?: boolean
}

interface QuestionLabels {
  sellTimeline?: string | null
  motivation?: string | null
  mortgageStatus?: string | null
  priceExpectation?: string | null
  hasAgent?: string | null
  buyAfterSell?: string | null
}

interface AddressSearchFormProps {
  agentSlug?: string
  brokerageId?: string
  utmSource?: string
  activeQuestions?: ActiveQuestions
  questionLabels?: QuestionLabels
  ctaButtonText?: string
  accentColor?: string
}

type FormStep = 1 | 2 | 3

const STEPS = [
  { number: 1, label: "Property", icon: Home },
  { number: 2, label: "Your Situation", icon: ClipboardList },
  { number: 3, label: "Contact", icon: User },
]

export function AddressSearchForm({
  agentSlug,
  brokerageId,
  utmSource,
  activeQuestions,
  questionLabels,
  ctaButtonText,
  accentColor,
}: AddressSearchFormProps) {
  // Build a resolved show-map so callers don't have to pass everything
  const show = {
    sellTimeline: activeQuestions?.sellTimeline ?? true,
    motivation: activeQuestions?.motivation ?? true,
    mortgageStatus: activeQuestions?.mortgageStatus ?? true,
    priceExpectation: activeQuestions?.priceExpectation ?? true,
    hasAgent: activeQuestions?.hasAgent ?? true,
    buyAfterSell: activeQuestions?.buyAfterSell ?? true,
    additionalNotes: activeQuestions?.additionalNotes ?? true,
  }
  const labels = {
    sellTimeline: questionLabels?.sellTimeline ?? "When are you thinking about selling?",
    motivation: questionLabels?.motivation ?? "What's driving the potential sale?",
    mortgageStatus: questionLabels?.mortgageStatus ?? "What's the mortgage situation?",
    priceExpectation: questionLabels?.priceExpectation ?? "What price range are you expecting?",
    hasAgent: questionLabels?.hasAgent ?? "Are you currently working with a real estate agent?",
    buyAfterSell: questionLabels?.buyAfterSell ?? "Will you be buying after you sell?",
  }
  // Step 2 is valid only if all *shown* required questions are answered

  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [step, setStep] = useState<FormStep>(1)
  const [error, setError] = useState<string | null>(null)

  // Step 1: Property Details
  const [propertyAddress, setPropertyAddress] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [zipCode, setZipCode] = useState("")
  const [propertyType, setPropertyType] = useState("")
  const [bedrooms, setBedrooms] = useState("")
  const [bathrooms, setBathrooms] = useState("")
  const [squareFeet, setSquareFeet] = useState("")
  const [yearBuilt, setYearBuilt] = useState("")
  const [condition, setCondition] = useState("")

  // Step 2: Seller Qualification
  const [sellTimeline, setSellTimeline] = useState("")
  const [motivation, setMotivation] = useState("")
  const [hasAgent, setHasAgent] = useState("")
  const [mortgageStatus, setMortgageStatus] = useState("")
  const [priceExpectation, setPriceExpectation] = useState("")
  const [buyAfterSell, setBuyAfterSell] = useState("")
  const [additionalNotes, setAdditionalNotes] = useState("")

  // Step 3: Contact Info
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [tcpaConsent, setTcpaConsent] = useState(false)

  // City OR zip is sufficient (seller may only know one)
  const hasCityOrZip = city.trim() !== "" || zipCode.trim() !== ""

  const isStep1Valid =
    propertyAddress.trim() !== "" &&
    hasCityOrZip &&
    state.trim() !== "" &&
    bedrooms !== "" &&
    bathrooms !== "" &&
    squareFeet.trim() !== "" &&
    yearBuilt.trim() !== "" &&
    condition !== ""

  // Only require answers for shown questions
  const isStep2Valid =
    (!show.sellTimeline || sellTimeline !== "") &&
    (!show.motivation || motivation !== "") &&
    (!show.hasAgent || hasAgent !== "") &&
    (!show.mortgageStatus || mortgageStatus !== "") &&
    (!show.priceExpectation || priceExpectation !== "") &&
    (!show.buyAfterSell || buyAfterSell !== "")

  const isStep3Valid =
    firstName.trim() !== "" &&
    lastName.trim() !== "" &&
    email.trim() !== "" &&
    phone.trim() !== ""

  async function handleSubmit() {
    if (!isStep3Valid) return
    setError(null)

    startTransition(async () => {
      const result = await submitHomeValueRequest({
        propertyAddress,
        city,
        state,
        zipCode,
        propertyType,
        bedrooms: parseInt(bedrooms, 10),
        bathrooms: parseFloat(bathrooms),
        squareFeet: parseInt(squareFeet, 10),
        yearBuilt: parseInt(yearBuilt, 10),
        condition,
        firstName,
        lastName,
        email,
        phone,
        agentSlug,
          brokerageId,
          utmSource,
          tcpaConsent,
          tcpaConsentText: tcpaConsent
            ? "I agree to receive calls, texts, and emails regarding real estate services. Consent is not required for purchase. Message and data rates may apply."
            : undefined,
          qualificationData: {
          sellTimeline,
          motivation,
          hasAgent,
          mortgageStatus,
          priceExpectation,
          buyAfterSell,
          additionalNotes: additionalNotes.trim() || undefined,
        },
      })

      if (result.success && result.requestId) {
        router.push(`/home-value/result/${result.requestId}`)
      } else {
        setError(result.error || "Something went wrong. Please try again.")
      }
    })
  }

  return (
    <Card className="shadow-lg">
      <CardHeader className="text-center pb-2">
        {/* Step indicator */}
        <div className="flex justify-center mb-5">
          <div className="flex items-center gap-0">
            {STEPS.map((s, i) => {
              const done = step > s.number
              const active = step === s.number
              return (
                <div key={s.number} className="flex items-center">
                  <div className="flex flex-col items-center gap-1">
                    <div
                      className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold border-2 transition-all",
                        done
                          ? "bg-primary border-primary text-primary-foreground"
                          : active
                          ? "border-primary text-primary bg-primary/10"
                          : "border-muted-foreground/30 text-muted-foreground/50 bg-background",
                      )}
                    >
                      {done ? <CheckCircle2 className="h-4 w-4" /> : s.number}
                    </div>
                    <span
                      className={cn(
                        "text-[10px] font-medium",
                        active ? "text-primary" : "text-muted-foreground/50",
                      )}
                    >
                      {s.label}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div
                      className={cn(
                        "h-0.5 w-10 mb-5 transition-all",
                        done ? "bg-primary" : "bg-muted",
                      )}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <CardTitle className="text-lg">
          {step === 1 && "Property Details"}
          {step === 2 && "Tell Us About Your Situation"}
          {step === 3 && "Where Do We Send Your Report?"}
        </CardTitle>
        <CardDescription>
          {step === 1 && "A few details help us find the right comps"}
          {step === 2 && "Helps us give you the most relevant guidance"}
          {step === 3 && "Your free estimate will be emailed instantly"}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        {/* ── STEP 1: Property ── */}
        {step === 1 && (
          <>
            <div className="space-y-2">
              <Label htmlFor="address">Street Address</Label>
              <Input
                id="address"
                placeholder="123 Main Street"
                value={propertyAddress}
                onChange={(e) => setPropertyAddress(e.target.value)}
              />
            </div>

            {/* City (or) Zip — only one required */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="city">
                  City
                  {!city && !zipCode && (
                    <span className="ml-1 text-xs text-muted-foreground">(or enter ZIP)</span>
                  )}
                </Label>
                <Input
                  id="city"
                  placeholder="Austin"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">State</Label>
                <Input
                  id="state"
                  placeholder="TX"
                  maxLength={2}
                  value={state}
                  onChange={(e) => setState(e.target.value.toUpperCase())}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zip">
                  ZIP
                  {!zipCode && !city && (
                    <span className="ml-1 text-xs text-muted-foreground">(or enter City)</span>
                  )}
                </Label>
                <Input
                  id="zip"
                  placeholder="78701"
                  maxLength={5}
                  value={zipCode}
                  onChange={(e) => setZipCode(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="propertyType">Property Type</Label>
              <Select value={propertyType} onValueChange={setPropertyType}>
                <SelectTrigger id="propertyType">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                {/* Canonical options. This list previously offered "mobile_home" (no
                    canonical equivalent — it now maps to "other"), omitted townhouse and
                    commercial entirely, and folded townhomes into Condo. A seller with a
                    townhouse had to mis-classify their own home, and the value they picked
                    could not survive into a listing. */}
                <SelectContent>
                  {PROPERTY_TYPE_OPTIONS.map((pt) => (
                    <SelectItem key={pt.value} value={pt.value}>{pt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="bedrooms">Bedrooms</Label>
                <Select value={bedrooms} onValueChange={setBedrooms}>
                  <SelectTrigger id="bedrooms">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n === 8 ? "8+" : n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bathrooms">Bathrooms</Label>
                <Select value={bathrooms} onValueChange={setBathrooms}>
                  <SelectTrigger id="bathrooms">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n === 7 ? "7+" : n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sqft">Square Feet</Label>
                <Input
                  id="sqft"
                  type="number"
                  placeholder="2,000"
                  value={squareFeet}
                  onChange={(e) => setSquareFeet(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="year">Year Built</Label>
                <Input
                  id="year"
                  type="number"
                  placeholder="1995"
                  value={yearBuilt}
                  onChange={(e) => setYearBuilt(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="condition">Home Condition</Label>
              <Select value={condition} onValueChange={setCondition}>
                <SelectTrigger id="condition">
                  <SelectValue placeholder="Select condition" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="excellent">Excellent — move-in ready, recent upgrades</SelectItem>
                  <SelectItem value="good">Good — well maintained, minor wear</SelectItem>
                  <SelectItem value="fair">Fair — needs some updating</SelectItem>
                  <SelectItem value="poor">Poor — needs significant work</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {!hasCityOrZip && propertyAddress && (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                Please enter your city or ZIP code so we can find comparable sales.
              </p>
            )}

            <Button
              className="w-full mt-2"
              size="lg"
              onClick={() => isStep1Valid && setStep(2)}
              disabled={!isStep1Valid}
              style={accentColor ? { background: accentColor, borderColor: accentColor } : undefined}
            >
              {ctaButtonText ?? "Next: Your Situation"}
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </>
        )}

        {/* ── STEP 2: Qualification ── */}
        {step === 2 && (
          <>
            {show.sellTimeline && (
              <div className="space-y-2">
                <Label htmlFor="sellTimeline">{labels.sellTimeline}</Label>
                <Select value={sellTimeline} onValueChange={setSellTimeline}>
                  <SelectTrigger id="sellTimeline"><SelectValue placeholder="Select timeline" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="asap">As soon as possible</SelectItem>
                    <SelectItem value="1_3_months">1–3 months</SelectItem>
                    <SelectItem value="3_6_months">3–6 months</SelectItem>
                    <SelectItem value="6_12_months">6–12 months</SelectItem>
                    <SelectItem value="1_2_years">1–2 years</SelectItem>
                    <SelectItem value="just_curious">Just curious about value</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {show.motivation && (
              <div className="space-y-2">
                <Label htmlFor="motivation">{labels.motivation}</Label>
                <Select value={motivation} onValueChange={setMotivation}>
                  <SelectTrigger id="motivation"><SelectValue placeholder="Select reason" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="upsizing">Upsizing / growing family</SelectItem>
                    <SelectItem value="downsizing">Downsizing</SelectItem>
                    <SelectItem value="relocating">Job relocation</SelectItem>
                    <SelectItem value="financial">Financial reasons</SelectItem>
                    <SelectItem value="divorce">Divorce / separation</SelectItem>
                    <SelectItem value="inherited">Inherited property</SelectItem>
                    <SelectItem value="investment">Selling investment property</SelectItem>
                    <SelectItem value="lifestyle">Lifestyle change</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {show.mortgageStatus && (
              <div className="space-y-2">
                <Label htmlFor="mortgageStatus">{labels.mortgageStatus}</Label>
                <Select value={mortgageStatus} onValueChange={setMortgageStatus}>
                  <SelectTrigger id="mortgageStatus"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="owned_free_clear">Own free and clear</SelectItem>
                    <SelectItem value="mortgage_current">Have a mortgage — current</SelectItem>
                    <SelectItem value="mortgage_behind">Behind on mortgage</SelectItem>
                    <SelectItem value="heloc">Have a HELOC</SelectItem>
                    <SelectItem value="not_sure">Not sure</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {show.priceExpectation && (
              <div className="space-y-2">
                <Label htmlFor="priceExpectation">{labels.priceExpectation}</Label>
                <Select value={priceExpectation} onValueChange={setPriceExpectation}>
                  <SelectTrigger id="priceExpectation"><SelectValue placeholder="Select expectation" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="under_200k">Under $200k</SelectItem>
                    <SelectItem value="200_400k">$200k – $400k</SelectItem>
                    <SelectItem value="400_600k">$400k – $600k</SelectItem>
                    <SelectItem value="600_800k">$600k – $800k</SelectItem>
                    <SelectItem value="800k_1m">$800k – $1M</SelectItem>
                    <SelectItem value="over_1m">Over $1M</SelectItem>
                    <SelectItem value="no_idea">Not sure yet</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {show.hasAgent && (
              <div className="space-y-2">
                <Label htmlFor="hasAgent">{labels.hasAgent}</Label>
                <Select value={hasAgent} onValueChange={setHasAgent}>
                  <SelectTrigger id="hasAgent"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no">No, looking for an agent</SelectItem>
                    <SelectItem value="yes_committed">Yes, I have one</SelectItem>
                    <SelectItem value="interviewing">Interviewing agents</SelectItem>
                    <SelectItem value="fsbo">Planning to sell myself (FSBO)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {show.buyAfterSell && (
              <div className="space-y-2">
                <Label htmlFor="buyAfterSell">{labels.buyAfterSell}</Label>
                <Select value={buyAfterSell} onValueChange={setBuyAfterSell}>
                  <SelectTrigger id="buyAfterSell"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes_local">Yes, staying in the area</SelectItem>
                    <SelectItem value="yes_relocating">Yes, relocating</SelectItem>
                    <SelectItem value="no">No, not buying</SelectItem>
                    <SelectItem value="not_sure">Not sure yet</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {show.additionalNotes && (
              <div className="space-y-2">
                <Label htmlFor="additionalNotes">
                  Anything else we should know?{" "}
                  <span className="text-muted-foreground text-xs">(optional)</span>
                </Label>
                <Textarea
                  id="additionalNotes"
                  placeholder="e.g. we've done a kitchen remodel, there's an easement issue, we need a specific close date..."
                  value={additionalNotes}
                  onChange={(e) => setAdditionalNotes(e.target.value)}
                  rows={3}
                  className="resize-none"
                />
              </div>
            )}

            <div className="flex gap-3 mt-2">
              <Button variant="outline" onClick={() => setStep(1)}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
              <Button
                className="flex-1"
                size="lg"
                onClick={() => isStep2Valid && setStep(3)}
                disabled={!isStep2Valid}
              >
                Next: Get My Estimate
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </>
        )}

        {/* ── STEP 3: Contact ── */}
        {step === 3 && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name</Label>
                <Input
                  id="firstName"
                  placeholder="Jane"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name</Label>
                <Input
                  id="lastName"
                  placeholder="Smith"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                placeholder="jane@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="(512) 555-0123"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>

            {/* TCPA consent — governs channel permission, not lead creation */}
            <label className="flex items-start gap-2 mt-1 cursor-pointer">
              <Checkbox
                id="tcpa-hv"
                checked={tcpaConsent}
                onCheckedChange={(v) => setTcpaConsent(!!v)}
                className="mt-0.5 shrink-0"
              />
              <span className="text-xs text-muted-foreground leading-relaxed">
                I agree to receive calls, texts, and emails from this brokerage and its agents regarding
                real estate services. Consent is not required for purchase. Message and data rates may apply.
              </span>
            </label>

            {!tcpaConsent && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                Without consent, we can only contact you by email.
              </p>
            )}

            <div className="flex items-start gap-2 text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
              <Shield className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
              <p>We never sell your information. Your data is used only to provide your estimate and connect you with a local expert.</p>
            </div>

            {error && (
              <p className="text-sm text-destructive text-center rounded-md bg-destructive/10 px-3 py-2">{error}</p>
            )}

            <div className="flex gap-3 mt-2">
              <Button variant="outline" onClick={() => setStep(2)} disabled={isPending}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
              <Button
                className="flex-1"
                size="lg"
                onClick={handleSubmit}
                disabled={!isStep3Valid || isPending}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating Estimate...
                  </>
                ) : (
                  <>
                    Get My Free Estimate
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
