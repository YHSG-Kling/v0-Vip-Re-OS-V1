"use client"

import { useState, useTransition } from "react"
import { captureFormSubmissionAction } from "@/app/actions/lead-magnet-capture"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CheckCircle2, Home, Loader2 } from "lucide-react"

interface Props {
  formId: string
  brokerageId: string
  source?: string
  headline?: string
  subheadline?: string
  ctaText?: string
  tcpaText?: string
  thankYouMessage?: string
  primaryColor?: string
  onSubmitted?: (submissionId: string) => void
}

// valuation_requests.condition admits exactly: excellent | good | fair | poor.
// The last option here was "needs_work", which the column rejects — so a
// homeowner who picked the honest answer about their own house had their
// valuation request refused and the LEAD LOST, at the very top of the funnel.
// 'poor' is the column's word for it; the label is what the visitor reads.
const CONDITION_OPTIONS = [
  { value: "excellent", label: "Excellent — Move-in ready" },
  { value: "good",      label: "Good — Minor updates needed" },
  { value: "fair",      label: "Fair — Some work required" },
  { value: "poor",      label: "Needs Work — Major renovation" },
]

export function HomeValueForm({
  formId,
  brokerageId,
  source = "landing_page",
  headline = "What Is Your Home Worth?",
  subheadline = "Get a free, instant estimate from a local expert.",
  ctaText = "Get My Free Home Valuation",
  tcpaText = "By submitting, you consent to receive communications. You may opt out at any time.",
  thankYouMessage = "Thank you! Your request has been received. We will be in touch shortly.",
  onSubmitted,
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tcpaChecked, setTcpaChecked] = useState(false)

  // Form fields — matching `home_valuation` default fields in the kernel
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [address, setAddress] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [zip, setZip] = useState("")
  const [bedrooms, setBedrooms] = useState("")
  const [bathrooms, setBathrooms] = useState("")
  const [sqft, setSqft] = useState("")
  const [condition, setCondition] = useState("")
  const [motivation, setMotivation] = useState("")

  function validate(): string | null {
    if (!firstName.trim())  return "First name is required"
    if (!lastName.trim())   return "Last name is required"
    if (!email.trim() || !email.includes("@")) return "Valid email is required"
    if (!address.trim())    return "Property address is required"
    if (!city.trim())       return "City is required"
    if (!state.trim())      return "State is required"
    if (!zip.trim())        return "ZIP code is required"
    if (!tcpaChecked)       return "Please acknowledge the consent statement"
    return null
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const validationError = validate()
    if (validationError) { setError(validationError); return }
    setError(null)

    startTransition(async () => {
      const result = await captureFormSubmissionAction({
        formId,
        brokerageId,
        source,
        tcpaConsentGiven: tcpaChecked,
        submissionData: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          property_address: address.trim(),
          city: city.trim(),
          state: state.trim(),
          zip_code: zip.trim(),
          bedrooms: bedrooms ? Number(bedrooms) : undefined,
          bathrooms: bathrooms ? Number(bathrooms) : undefined,
          square_feet: sqft ? Number(sqft) : undefined,
          condition: condition || undefined,
          motivation: motivation.trim() || undefined,
        },
      })

      if (!result.success) {
        setError(result.error ?? "Submission failed. Please try again.")
        return
      }

      setSubmitted(true)
      onSubmitted?.(result.submissionId!)
    })
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center gap-5 py-12 text-center">
        <div className="p-4 bg-green-100 rounded-full">
          <CheckCircle2 className="h-10 w-10 text-green-600" />
        </div>
        <div>
          <p className="text-xl font-semibold">Request Received!</p>
          <p className="text-muted-foreground mt-2 max-w-sm">{thankYouMessage}</p>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="p-2 bg-primary/10 rounded-lg shrink-0">
          <Home className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-xl font-semibold leading-tight">{headline}</h2>
          <p className="text-sm text-muted-foreground mt-1">{subheadline}</p>
        </div>
      </div>

      {/* Contact info */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="hv-first">First Name *</Label>
          <Input id="hv-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Jane" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hv-last">Last Name *</Label>
          <Input id="hv-last" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Smith" required />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="hv-email">Email *</Label>
          <Input id="hv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hv-phone">Phone</Label>
          <Input id="hv-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 000-0000" />
        </div>
      </div>

      {/* Property info */}
      <div className="space-y-1">
        <Label htmlFor="hv-addr">Property Address *</Label>
        <Input id="hv-addr" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St" required />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1">
          <Label htmlFor="hv-city">City *</Label>
          <Input id="hv-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Austin" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hv-state">State *</Label>
          <Input id="hv-state" value={state} onChange={(e) => setState(e.target.value)} placeholder="TX" maxLength={2} required />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="hv-zip">ZIP Code *</Label>
          <Input id="hv-zip" value={zip} onChange={(e) => setZip(e.target.value)} placeholder="78701" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hv-sqft">Square Feet</Label>
          <Input id="hv-sqft" type="number" value={sqft} onChange={(e) => setSqft(e.target.value)} placeholder="2,000" min={0} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="hv-bed">Bedrooms</Label>
          <Input id="hv-bed" type="number" value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} placeholder="3" min={0} max={20} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hv-bath">Bathrooms</Label>
          <Input id="hv-bath" type="number" value={bathrooms} onChange={(e) => setBathrooms(e.target.value)} placeholder="2" min={0} max={20} step={0.5} />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="hv-condition">Home Condition</Label>
        <Select value={condition} onValueChange={setCondition}>
          <SelectTrigger id="hv-condition">
            <SelectValue placeholder="Select condition..." />
          </SelectTrigger>
          <SelectContent>
            {CONDITION_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="hv-motivation">Why are you considering selling? (optional)</Label>
        <Textarea id="hv-motivation" value={motivation} onChange={(e) => setMotivation(e.target.value)} rows={2} placeholder="Downsizing, relocating, investment..." />
      </div>

      {/* TCPA Consent */}
      <label className="flex items-start gap-3 cursor-pointer">
        <Checkbox
          checked={tcpaChecked}
          onCheckedChange={(v) => setTcpaChecked(Boolean(v))}
          className="mt-0.5 shrink-0"
          required
        />
        <span className="text-xs text-muted-foreground leading-relaxed">{tcpaText}</span>
      </label>

      {error && (
        <p className="text-sm text-destructive font-medium" role="alert">{error}</p>
      )}

      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
        {ctaText}
      </Button>
    </form>
  )
}
