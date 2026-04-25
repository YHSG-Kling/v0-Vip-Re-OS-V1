"use client"
/**
 * app/dashboard/listings/components/listing-initiation-flow.tsx
 *
 * Kernel-aware multi-step listing initiation wizard.
 *
 * Steps:
 *   address          → Collect seller + property details
 *   pricing          → AI-suggested list price / CMA briefing
 *   forms            → Select listing agreement + addenda
 *   send_for_signatures → SendListingForSignaturesPanel
 *
 * Mirrors the offer-initiation-flow pattern precisely.
 */

import { useState, useTransition } from "react"
import { cn } from "@/lib/utils"
import { createListingWithSellerContact } from "@/app/actions/listings-kernel"
import { submitListingForSignature } from "@/app/actions/listing/submit-listing-for-signature"
import { FormSelectorStep, type FormFieldValues } from "@/app/components/forms/form-selector-step"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertCircle,
  Check,
  ChevronRight,
  Home,
  Loader2,
  PenLine,
  Sparkles,
  Tag,
  Trash2,
  UserPlus,
} from "lucide-react"

// ── Types ──────────────────────────────────────────────────────────────────────

type ListingFlowStep = "address" | "pricing" | "forms" | "send_for_signatures"

interface Signer {
  name:  string
  email: string
  role:  "seller" | "co_seller" | "agent"
}

interface ListingInitiationFlowProps {
  agentUserId:      string
  agentName:        string
  agentEmail:       string
  brokerageId:      string
  /** Optional — if pre-filled from CRM seller contact */
  initialFirstName?: string
  initialLastName?:  string
  initialEmail?:     string
  initialPhone?:     string
  initialAddress?:   string
  onSuccess: (listingId: string) => void
  onCancel:  () => void
}

// ── US States ─────────────────────────────────────────────────────────────────

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  "DC",
]

const PROPERTY_TYPES = [
  { value: "single_family",  label: "Single Family" },
  { value: "condo",          label: "Condo" },
  { value: "townhouse",      label: "Townhouse" },
  { value: "multi_family",   label: "Multi-Family" },
  { value: "land",           label: "Land" },
  { value: "commercial",     label: "Commercial" },
  { value: "other",          label: "Other" },
]

// ── Step indicator ─────────────────────────────────────────────────────────────

const STEP_LABELS: Record<ListingFlowStep, string> = {
  address:             "Property Details",
  pricing:             "Pricing Strategy",
  forms:               "Listing Documents",
  send_for_signatures: "Send for Signatures",
}

const STEP_ORDER: ListingFlowStep[] = ["address", "pricing", "forms", "send_for_signatures"]

// ── Main component ─────────────────────────────────────────────────────────────

export function ListingInitiationFlow({
  agentUserId,
  agentName,
  agentEmail,
  brokerageId,
  initialFirstName = "",
  initialLastName  = "",
  initialEmail     = "",
  initialPhone     = "",
  initialAddress   = "",
  onSuccess,
  onCancel,
}: ListingInitiationFlowProps) {
  const [step, setStep]         = useState<ListingFlowStep>("address")
  const [listingId, setListingId] = useState<string | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [isPending, startTrans] = useTransition()

  // ── Step 1: Address / seller fields ─────────────────────────────────────────
  const [form, setForm] = useState({
    sellerFirstName: initialFirstName,
    sellerLastName:  initialLastName,
    sellerEmail:     initialEmail,
    sellerPhone:     initialPhone,
    address:         initialAddress,
    city:            "",
    state:           "",
    zip:             "",
    listPrice:       "",
    bedrooms:        "",
    bathrooms:       "",
    sqft:            "",
    propertyType:    "single_family",
  })

  function patchForm(key: keyof typeof form, value: string) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function handleSubmitAddress() {
    if (!form.address.trim() || !form.city.trim() || !form.state) {
      setError("Address, city, and state are required.")
      return
    }
    if (!form.sellerFirstName.trim() || !form.sellerLastName.trim()) {
      setError("Seller first and last name are required.")
      return
    }
    setError(null)
    setStep("pricing")
  }

  // ── Step 2: Pricing strategy (AI briefing) ───────────────────────────────────
  const [pricingConfirmed, setPricingConfirmed] = useState(false)

  function handleConfirmPricing() {
    setPricingConfirmed(true)
    setStep("forms")
  }

  // ── Step 3: Forms — handled by FormSelectorStep ───────────────────────────────
  const [selectedFormIds, setSelectedFormIds]     = useState<string[]>([])
  const [formFieldValues, setFormFieldValues]     = useState<FormFieldValues>({})

  function handleFormsComplete(ids: string[], values: FormFieldValues) {
    // Guard: prevent double-submit if a transition is already in flight
    if (isPending) return
    setSelectedFormIds(ids)
    setFormFieldValues(values)
    handleCreateListing(ids, values)
  }

  // Create the listing then advance to send_for_signatures
  function handleCreateListing(selectedIds: string[], fieldValues: FormFieldValues) {
    setError(null)
    startTrans(async () => {
      const result = await createListingWithSellerContact({
        sellerFirstName: form.sellerFirstName,
        sellerLastName:  form.sellerLastName,
        sellerEmail:     form.sellerEmail     || undefined,
        sellerPhone:     form.sellerPhone     || undefined,
        address:         form.address,
        city:            form.city,
        state:           form.state,
        zip:             form.zip             || "",
        listPrice:       form.listPrice       ? Number(form.listPrice)  : undefined,
        bedrooms:        form.bedrooms        ? Number(form.bedrooms)   : undefined,
        bathrooms:       form.bathrooms       ? Number(form.bathrooms)  : undefined,
        sqft:            form.sqft            ? Number(form.sqft)       : undefined,
        propertyType:    form.propertyType    || undefined,
        selectedFormIds: selectedIds,
        formFieldValues: fieldValues,
      })

      if (!result.success) {
        setError(result.error ?? "Failed to create listing")
        return
      }

      setListingId(result.listingId!)
      setStep("send_for_signatures")
    })
  }

  // ── Step 4: Send for signatures ───────────────────────────────────────────────
  const [signers, setSigners] = useState<Signer[]>(() => {
    const initial: Signer[] = []
    if (initialEmail) {
      initial.push({ name: `${initialFirstName} ${initialLastName}`.trim(), email: initialEmail, role: "seller" })
    }
    if (agentEmail) {
      initial.push({ name: agentName, email: agentEmail, role: "agent" })
    }
    return initial
  })
  const [newSignerName, setNewSignerName]   = useState("")
  const [newSignerEmail, setNewSignerEmail] = useState("")
  const [sendResult, setSendResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [isSending, startSend] = useTransition()

  function addCoSeller() {
    if (!newSignerEmail.trim()) return
    setSigners(prev => [...prev, { name: newSignerName.trim(), email: newSignerEmail.trim(), role: "co_seller" }])
    setNewSignerName("")
    setNewSignerEmail("")
  }

  function removeSigner(index: number) {
    setSigners(prev => prev.filter((_, i) => i !== index))
  }

  function handleSend() {
    if (!listingId || signers.length === 0) return
    setSendResult(null)
    startSend(async () => {
      const res = await submitListingForSignature({ listingId, userId: agentUserId, signers })
      setSendResult(res)
      if (res.success) {
        setTimeout(() => onSuccess(listingId), 1200)
      }
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const currentStepIndex = STEP_ORDER.indexOf(step)

  return (
    <div className="space-y-6">
      {/* Step progress */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {STEP_ORDER.map((s, i) => (
          <div key={s} className="flex items-center gap-2 shrink-0">
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                i < currentStepIndex  && "bg-primary/10 text-primary",
                i === currentStepIndex && "bg-primary text-primary-foreground",
                i > currentStepIndex  && "bg-muted text-muted-foreground",
              )}
            >
              {i < currentStepIndex && <Check className="h-3 w-3" />}
              {STEP_LABELS[s]}
            </div>
            {i < STEP_ORDER.length - 1 && (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
          </div>
        ))}
      </div>

      {/* Step 1: Property Details */}
      {step === "address" && (
        <div className="space-y-5">
          <div>
            <h2 className="text-base font-semibold">Property &amp; Seller Details</h2>
            <p className="text-sm text-muted-foreground">
              Enter the property address and seller information to create the listing record.
            </p>
          </div>

          {/* Seller */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-primary" />
                Seller Contact
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">First Name *</Label>
                <Input value={form.sellerFirstName} onChange={e => patchForm("sellerFirstName", e.target.value)} placeholder="Jane" className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Last Name *</Label>
                <Input value={form.sellerLastName} onChange={e => patchForm("sellerLastName", e.target.value)} placeholder="Smith" className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Email</Label>
                <Input type="email" value={form.sellerEmail} onChange={e => patchForm("sellerEmail", e.target.value)} placeholder="jane@example.com" className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Phone</Label>
                <Input value={form.sellerPhone} onChange={e => patchForm("sellerPhone", e.target.value)} placeholder="(555) 000-0000" className="h-8 text-sm" />
              </div>
            </CardContent>
          </Card>

          {/* Property */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Home className="h-4 w-4 text-primary" />
                Property
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-xs">Street Address *</Label>
                <Input value={form.address} onChange={e => patchForm("address", e.target.value)} placeholder="123 Main St" className="h-8 text-sm" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <Label className="text-xs">City *</Label>
                  <Input value={form.city} onChange={e => patchForm("city", e.target.value)} placeholder="Austin" className="h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">State *</Label>
                  <Select value={form.state} onValueChange={v => patchForm("state", v)}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="TX" /></SelectTrigger>
                    <SelectContent>
                      {US_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">ZIP</Label>
                  <Input value={form.zip} onChange={e => patchForm("zip", e.target.value)} placeholder="78701" className="h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Property Type</Label>
                  <Select value={form.propertyType} onValueChange={v => patchForm("propertyType", v)}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PROPERTY_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div>
                  <Label className="text-xs">Beds</Label>
                  <Input type="number" value={form.bedrooms} onChange={e => patchForm("bedrooms", e.target.value)} placeholder="3" className="h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Baths</Label>
                  <Input type="number" value={form.bathrooms} onChange={e => patchForm("bathrooms", e.target.value)} placeholder="2" className="h-8 text-sm" />
                </div>
                <div className="col-span-2">
                  <Label className="text-xs">Sq Ft</Label>
                  <Input type="number" value={form.sqft} onChange={e => patchForm("sqft", e.target.value)} placeholder="1800" className="h-8 text-sm" />
                </div>
              </div>
              <div>
                <Label className="text-xs">Asking Price ($)</Label>
                <div className="relative">
                  <Tag className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="number"
                    value={form.listPrice}
                    onChange={e => patchForm("listPrice", e.target.value)}
                    placeholder="450000"
                    className="h-8 text-sm pl-7"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onCancel}>Cancel</Button>
            <Button onClick={handleSubmitAddress}>
              Next: Pricing Strategy
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Pricing Strategy */}
      {step === "pricing" && (
        <div className="space-y-5">
          <div>
            <h2 className="text-base font-semibold">Pricing Strategy</h2>
            <p className="text-sm text-muted-foreground">
              Review the AI-assisted pricing briefing for{" "}
              <span className="font-medium">{form.address}</span>.
            </p>
          </div>

          <Card className="border-primary/20 bg-primary/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                AI Pricing Brief
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {form.listPrice ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Suggested Ask</span>
                    <span className="font-semibold text-foreground">
                      ${Number(form.listPrice).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Based on the information provided, your asking price of{" "}
                    <strong>${Number(form.listPrice).toLocaleString()}</strong> will be used
                    as the list price. Run a full CMA from the listing lifecycle page to
                    validate market comps once the record is created.
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  No list price provided. You can add a price now or set it later from the
                  listing lifecycle page. A CMA tool is available after the listing is created.
                </p>
              )}
              <div className="rounded border border-primary/20 bg-background px-3 py-2 text-xs text-muted-foreground">
                <strong>Tip:</strong> The listing agreement will be generated in the next step.
                You can update the price at any time before going live.
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-2 justify-between">
            <Button variant="outline" onClick={() => setStep("address")}>Back</Button>
            <Button onClick={handleConfirmPricing}>
              Next: Listing Documents
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 3: Forms — select + fill inline */}
      {step === "forms" && (
        <FormSelectorStep
          contextType="listing"
          state={form.state || undefined}
          autoLoad
          nextLabel={isPending ? "Creating Listing…" : "Create Listing & Send for Signatures"}
          nextDisabled={isPending}
          onBack={() => setStep("pricing")}
          onComplete={handleFormsComplete}
        />
      )}

      {/* Step 4: Send for Signatures */}
      {step === "send_for_signatures" && listingId && (
        <div className="space-y-5">
          <div>
            <h2 className="text-base font-semibold">Send for Signatures</h2>
            <p className="text-sm text-muted-foreground">
              Send the listing agreement to all parties for e-signature.
            </p>
          </div>

          {/* Signer list */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Signers</p>
            {signers.length === 0 && (
              <p className="text-xs text-muted-foreground">No signers added yet.</p>
            )}
            {signers.map((signer, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{signer.name || signer.email}</p>
                  <p className="text-xs text-muted-foreground truncate">{signer.email}</p>
                </div>
                <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground capitalize">
                  {signer.role.replace("_", " ")}
                </span>
                {signer.role !== "seller" && (
                  <button
                    onClick={() => removeSigner(i)}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                    aria-label="Remove signer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Add co-seller */}
          <div className="space-y-2">
            <p className="text-sm font-medium flex items-center gap-1.5">
              <UserPlus className="h-3.5 w-3.5" />
              Add Co-Seller
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Name</Label>
                <Input
                  value={newSignerName}
                  onChange={e => setNewSignerName(e.target.value)}
                  placeholder="Full name"
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs">Email</Label>
                <Input
                  type="email"
                  value={newSignerEmail}
                  onChange={e => setNewSignerEmail(e.target.value)}
                  placeholder="email@example.com"
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={addCoSeller}
              disabled={!newSignerEmail.trim()}
              className="w-full"
            >
              <UserPlus className="h-3.5 w-3.5 mr-1.5" />
              Add Co-Seller
            </Button>
          </div>

          {/* Send result */}
          {sendResult && !sendResult.success && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {sendResult.error ?? "Failed to send for signatures"}
            </div>
          )}
          {sendResult?.success && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              <Check className="h-4 w-4 shrink-0" />
              Listing agreement sent for signature
            </div>
          )}

          <div className="border-t border-border pt-4 flex flex-col gap-2">
            <Button
              className="w-full"
              onClick={handleSend}
              disabled={isSending || signers.length === 0 || !!sendResult?.success}
            >
              {isSending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Sending…</>
              ) : sendResult?.success ? (
                <><Check className="h-4 w-4 mr-2" />Sent</>
              ) : (
                <><PenLine className="h-4 w-4 mr-2" />Send for Signatures</>
              )}
            </Button>
            {/* Skip — go to listing lifecycle */}
            {!sendResult?.success && (
              <Button
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={() => onSuccess(listingId)}
                disabled={isSending}
              >
                Skip — Go to Listing
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
