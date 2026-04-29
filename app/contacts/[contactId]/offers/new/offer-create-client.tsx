"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ArrowLeft, ArrowRight, Check, Loader2, FileText, Send } from "lucide-react"
import { createOffer, type OfferFormData } from "@/app/actions/buyer-offers"
import { submitForSignature } from "@/app/actions/buyer-offer/submit-for-signature"

// ── Types ──────────────────────────────────────────────────────────────────────
interface Contact {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  [key: string]: any
}

interface EsignProvider {
  platform: string
  accountName: string | null
}

interface Props {
  contact: Contact
  brokerageId: string
  agentUserId: string
  agentId: string | null
  esignProvider: EsignProvider | null
}

// ── Step definitions ───────────────────────────────────────────────────────────
const STEPS = ["Property", "Offer Terms", "Contingencies", "Send for Signing"]

const FINANCING_TYPES = [
  { value: "conventional", label: "Conventional" },
  { value: "fha", label: "FHA" },
  { value: "va", label: "VA" },
  { value: "usda", label: "USDA" },
  { value: "cash", label: "Cash" },
  { value: "jumbo", label: "Jumbo" },
  { value: "other", label: "Other" },
]

const POSSESSION_OPTIONS = [
  { value: "at_closing", label: "At Closing" },
  { value: "seller_occupancy", label: "Seller Occupancy After Close" },
  { value: "negotiable", label: "Negotiable" },
]

// ── Component ──────────────────────────────────────────────────────────────────
export default function OfferCreateClient({
  contact,
  brokerageId,
  agentUserId,
  agentId,
  esignProvider,
}: Props) {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createdOfferId, setCreatedOfferId] = useState<string | null>(null)

  // Step 0: Property
  const [propertyAddress, setPropertyAddress] = useState("")
  const [propertyCity, setPropertyCity] = useState("")
  const [propertyState, setPropertyState] = useState("")
  const [propertyZip, setPropertyZip] = useState("")

  // Step 1: Offer terms
  const [offerPrice, setOfferPrice] = useState("")
  const [earnestMoney, setEarnestMoney] = useState("")
  const [downPaymentPct, setDownPaymentPct] = useState("")
  const [financingType, setFinancingType] = useState("conventional")
  const [closingDate, setClosingDate] = useState("")
  const [possessionTerms, setPossessionTerms] = useState("at_closing")
  const [escalation, setEscalation] = useState(false)
  const [escalationCap, setEscalationCap] = useState("")

  // Step 2: Contingencies
  const [financingContingency, setFinancingContingency] = useState(true)
  const [financingDays, setFinancingDays] = useState("21")
  const [inspectionContingency, setInspectionContingency] = useState(true)
  const [inspectionDays, setInspectionDays] = useState("10")
  const [appraisalContingency, setAppraisalContingency] = useState(true)
  const [appraisalDays, setAppraisalDays] = useState("14")
  const [buyerNotes, setBuyerNotes] = useState("")

  const contactName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim()
  const parsedOfferPrice = Number(offerPrice.replace(/[^0-9.]/g, ""))
  const parsedEarnest = Number(earnestMoney.replace(/[^0-9.]/g, ""))

  function canProceed(): boolean {
    if (step === 0) return propertyAddress.trim().length > 0
    if (step === 1) return parsedOfferPrice > 0 && parsedEarnest >= 0 && !!closingDate
    return true
  }

  async function handleCreateOffer() {
    setSubmitting(true)
    setError(null)
    try {
      const form: OfferFormData = {
        property_address: propertyAddress,
        property_city: propertyCity,
        property_state: propertyState,
        property_zip: propertyZip,
        offer_price: parsedOfferPrice,
        earnest_money: parsedEarnest,
        earnest_money_amount: parsedEarnest,
        down_payment_percent: downPaymentPct ? Number(downPaymentPct) : undefined,
        financing_type: financingType,
        financing_contingency: financingContingency,
        financing_contingency_days: Number(financingDays),
        inspection_contingency: inspectionContingency,
        inspection_period_days: Number(inspectionDays),
        appraisal_contingency: appraisalContingency,
        appraisal_contingency_days: Number(appraisalDays),
        closing_date: closingDate,
        possession_terms: possessionTerms,
        escalation_clause: escalation,
        escalation_cap: escalation && escalationCap ? Number(escalationCap.replace(/[^0-9.]/g, "")) : undefined,
        buyer_notes: buyerNotes || undefined,
        form_source: "app",
        esign_provider: esignProvider?.platform ?? undefined,
      }

      const result = await createOffer(contact.id, brokerageId, agentUserId, form)
      if (!result.success || !result.offerId) {
        setError(result.error ?? "Failed to create offer")
        return
      }
      setCreatedOfferId(result.offerId)
      setStep(3)
    } catch (err: any) {
      setError(err.message ?? "Unexpected error")
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSendForSignature() {
    if (!createdOfferId) return
    setSubmitting(true)
    setError(null)
    try {
      const signers = [
        {
          name: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim(),
          email: contact.email ?? "",
          role: "buyer" as const,
        },
      ]
      const result = await submitForSignature({
        offerId: createdOfferId,
        userId: agentUserId,
        signers,
      })
      if (!result.success) {
        setError(result.error ?? "Failed to send for signature")
        return
      }
      router.push(`/offers?highlight=${createdOfferId}`)
    } catch (err: any) {
      setError(err.message ?? "Unexpected error")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/contacts/${contact.id}`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-xl font-semibold">Create Offer</h1>
          <p className="text-sm text-muted-foreground">Buyer: {contactName}</p>
        </div>
      </div>

      {/* Progress */}
      <div className="space-y-2">
        <div className="flex justify-between text-xs text-muted-foreground">
          {STEPS.map((s, i) => (
            <span key={s} className={i === step ? "text-primary font-medium" : ""}>{s}</span>
          ))}
        </div>
        <Progress value={((step) / (STEPS.length - 1)) * 100} className="h-1.5" />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* ── Step 0: Property ───────────────────────────────────── */}
      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Property Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Property Address <span className="text-destructive">*</span></Label>
              <Input
                value={propertyAddress}
                onChange={(e) => setPropertyAddress(e.target.value)}
                placeholder="123 Main St"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>City</Label>
                <Input value={propertyCity} onChange={(e) => setPropertyCity(e.target.value)} placeholder="Austin" />
              </div>
              <div>
                <Label>State</Label>
                <Input value={propertyState} onChange={(e) => setPropertyState(e.target.value)} placeholder="TX" maxLength={2} />
              </div>
            </div>
            <div>
              <Label>ZIP Code</Label>
              <Input value={propertyZip} onChange={(e) => setPropertyZip(e.target.value)} placeholder="78701" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Step 1: Offer Terms ────────────────────────────────── */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Offer Terms</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Offer Price <span className="text-destructive">*</span></Label>
                <Input
                  value={offerPrice}
                  onChange={(e) => setOfferPrice(e.target.value)}
                  placeholder="$500,000"
                />
              </div>
              <div>
                <Label>Earnest Money <span className="text-destructive">*</span></Label>
                <Input
                  value={earnestMoney}
                  onChange={(e) => setEarnestMoney(e.target.value)}
                  placeholder="$5,000"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Down Payment %</Label>
                <Input
                  type="number"
                  value={downPaymentPct}
                  onChange={(e) => setDownPaymentPct(e.target.value)}
                  placeholder="20"
                  min={0}
                  max={100}
                />
              </div>
              <div>
                <Label>Financing Type</Label>
                <Select value={financingType} onValueChange={setFinancingType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FINANCING_TYPES.map((f) => (
                      <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Closing Date <span className="text-destructive">*</span></Label>
                <Input
                  type="date"
                  value={closingDate}
                  onChange={(e) => setClosingDate(e.target.value)}
                />
              </div>
              <div>
                <Label>Possession</Label>
                <Select value={possessionTerms} onValueChange={setPossessionTerms}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {POSSESSION_OPTIONS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox
                id="escalation"
                checked={escalation}
                onCheckedChange={(v) => setEscalation(!!v)}
              />
              <Label htmlFor="escalation" className="cursor-pointer">Escalation Clause</Label>
              {escalation && (
                <Input
                  className="w-40"
                  value={escalationCap}
                  onChange={(e) => setEscalationCap(e.target.value)}
                  placeholder="Cap: $550,000"
                />
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Step 2: Contingencies ──────────────────────────────── */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Contingencies</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <Checkbox
                  id="fin"
                  checked={financingContingency}
                  onCheckedChange={(v) => setFinancingContingency(!!v)}
                />
                <Label htmlFor="fin" className="flex-1 cursor-pointer">Financing Contingency</Label>
                {financingContingency && (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-16 h-7"
                      value={financingDays}
                      onChange={(e) => setFinancingDays(e.target.value)}
                    />
                    <span className="text-xs text-muted-foreground">days</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-4">
                <Checkbox
                  id="insp"
                  checked={inspectionContingency}
                  onCheckedChange={(v) => setInspectionContingency(!!v)}
                />
                <Label htmlFor="insp" className="flex-1 cursor-pointer">Inspection Contingency</Label>
                {inspectionContingency && (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-16 h-7"
                      value={inspectionDays}
                      onChange={(e) => setInspectionDays(e.target.value)}
                    />
                    <span className="text-xs text-muted-foreground">days</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-4">
                <Checkbox
                  id="appr"
                  checked={appraisalContingency}
                  onCheckedChange={(v) => setAppraisalContingency(!!v)}
                />
                <Label htmlFor="appr" className="flex-1 cursor-pointer">Appraisal Contingency</Label>
                {appraisalContingency && (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-16 h-7"
                      value={appraisalDays}
                      onChange={(e) => setAppraisalDays(e.target.value)}
                    />
                    <span className="text-xs text-muted-foreground">days</span>
                  </div>
                )}
              </div>
            </div>
            <div>
              <Label>Notes for Listing Agent (optional)</Label>
              <Textarea
                value={buyerNotes}
                onChange={(e) => setBuyerNotes(e.target.value)}
                placeholder="Any special considerations or requests..."
                rows={3}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Step 3: Confirmation / Send ────────────────────────── */}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Check className="h-4 w-4 text-green-600" />
              Offer Created
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Property</span>
                <span className="font-medium">{propertyAddress}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Offer Price</span>
                <span className="font-medium">${parsedOfferPrice.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Closing</span>
                <span className="font-medium">{closingDate}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Buyer</span>
                <span className="font-medium">{contactName}</span>
              </div>
            </div>

            {esignProvider ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Send this offer to <strong>{contactName}</strong> for e-signature via{" "}
                  <Badge variant="outline" className="capitalize">{esignProvider.platform}</Badge>
                </p>
                <Button
                  className="w-full"
                  onClick={handleSendForSignature}
                  disabled={submitting}
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4 mr-2" />
                  )}
                  Send for Signature ({esignProvider.platform})
                </Button>
              </div>
            ) : (
              <Alert>
                <FileText className="h-4 w-4" />
                <AlertDescription>
                  No e-sign provider connected. Go to{" "}
                  <Link href="/admin/integrations" className="underline">Settings → Integrations</Link>{" "}
                  to connect DocuSign, DotLoop, or similar.
                </AlertDescription>
              </Alert>
            )}

            <Button variant="outline" className="w-full" asChild>
              <Link href="/offers">View Offers Pipeline</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Navigation */}
      {step < 3 && (
        <div className="flex justify-between">
          <Button
            variant="outline"
            onClick={() => step === 0 ? router.push(`/contacts/${contact.id}`) : setStep(s => s - 1)}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            {step === 0 ? "Cancel" : "Back"}
          </Button>

          {step < 2 ? (
            <Button
              onClick={() => setStep(s => s + 1)}
              disabled={!canProceed()}
            >
              Next
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          ) : (
            <Button
              onClick={handleCreateOffer}
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FileText className="h-4 w-4 mr-2" />
              )}
              Create Offer
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
