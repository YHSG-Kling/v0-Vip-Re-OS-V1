"use client"

import { useState, useCallback, useTransition, useRef } from "react"
import { cn } from "@/lib/utils"
import {
  searchListingsByAddress,
  resolveFormSource,
  type StrategyRecommendation,
} from "@/app/actions/buyer-offers"
import { StrategyAdvisor }   from "./strategy-advisor"
import { OfferFormWizard }   from "./offer-form-wizard"

type FlowStep = "address" | "form_source" | "strategy" | "wizard"

interface ResolvedProperty {
  address:         string
  city:            string
  state:           string
  zip:             string
  listingId:       string | null
  listPrice:       number | null
  aiFilledAddress: boolean
}

interface ResolvedFormSource {
  source:       "uploaded_doc" | "platform" | "in_app"
  label:        string
  providerName?: string
  providerRef?:  string
}

interface OfferInitiationFlowProps {
  contactId:    string
  brokerageId:  string
  agentUserId:  string
  contactName:  string
  contactEmail: string
  onSuccess:    () => void
  onCancel:     () => void
}

export function OfferInitiationFlow({
  contactId, brokerageId, agentUserId,
  contactName, contactEmail, onSuccess, onCancel,
}: OfferInitiationFlowProps) {
  const [flowStep, setFlowStep]   = useState<FlowStep>("address")
  const [addressInput, setAddressInput] = useState("")
  const [suggestions, setSuggestions]   = useState<{ id: string; address: string; city: string; state: string; zip: string; list_price: number }[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [property, setProperty]   = useState<ResolvedProperty | null>(null)
  const [formSrc, setFormSrc]     = useState<ResolvedFormSource | null>(null)
  const [recommendation, setRecommendation] = useState<StrategyRecommendation | null>(null)
  const [isLoadingAddress, startAddressLoad] = useTransition()
  const [isLoadingFormSrc, startFormSrcLoad] = useTransition()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Step 1: Address search ──────────────────────────────────────────────────

  const onAddressChange = useCallback((value: string) => {
    setAddressInput(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.length < 3) { setSuggestions([]); setShowDropdown(false); return }

    debounceRef.current = setTimeout(() => {
      startAddressLoad(async () => {
        const results = await searchListingsByAddress(value, brokerageId)
        setSuggestions(results)
        setShowDropdown(results.length > 0)
      })
    }, 500)
  }, [brokerageId])

  function selectListing(s: typeof suggestions[0]) {
    setAddressInput(s.address)
    setShowDropdown(false)
    setSuggestions([])
    setProperty({
      address:         s.address,
      city:            s.city ?? "",
      state:           s.state ?? "",
      zip:             s.zip ?? "",
      listingId:       s.id,
      listPrice:       s.list_price,
      aiFilledAddress: false,
    })
  }

  function confirmAddress() {
    if (!addressInput.trim()) return
    const resolved: ResolvedProperty = property ?? {
      address:         addressInput.trim(),
      city:            "",
      state:           "",
      zip:             "",
      listingId:       null,
      listPrice:       null,
      aiFilledAddress: !property,
    }
    setProperty(resolved)
    // Proceed to form source
    startFormSrcLoad(async () => {
      const src = await resolveFormSource(contactId, brokerageId)
      setFormSrc(src)
      setFlowStep("form_source")
    })
  }

  // ── Step 2: Form source ─────────────────────────────────────────────────────

  function proceedFromFormSource() {
    setFlowStep("strategy")
  }

  // ── Step 3: Strategy ────────────────────────────────────────────────────────

  function onUseStrategy(rec: StrategyRecommendation) {
    setRecommendation(rec)
    setFlowStep("wizard")
  }

  function onCustomizeStrategy(rec: StrategyRecommendation) {
    setRecommendation(rec)
    setFlowStep("wizard")
  }

  function onSkipStrategy() {
    setRecommendation(null)
    setFlowStep("wizard")
  }

  // ── RENDER ──────────────────────────────────────────────────────────────────

  if (flowStep === "strategy") {
    return (
      <div className="flex flex-col h-full overflow-y-auto">
        <div className="px-5 py-4 border-b border-border flex items-center gap-3">
          <button onClick={() => setFlowStep("form_source")} className="text-sm text-muted-foreground hover:underline">
            Back
          </button>
          <p className="text-sm font-semibold">AI Strategy Recommendation</p>
        </div>
        <div className="flex-1 px-5 py-4">
          <StrategyAdvisor
            contactId={contactId}
            listingId={property?.listingId ?? null}
            brokerageId={brokerageId}
            agentUserId={agentUserId}
            onUse={onUseStrategy}
            onCustomize={onCustomizeStrategy}
            onSkip={onSkipStrategy}
            onBack={() => setFlowStep("form_source")}
          />
        </div>
      </div>
    )
  }

  if (flowStep === "wizard" && property) {
    return (
      <OfferFormWizard
        contactId={contactId}
        brokerageId={brokerageId}
        agentUserId={agentUserId}
        contactName={contactName}
        contactEmail={contactEmail}
        recommendation={recommendation}
        formSource={formSrc?.source === "platform" ? formSrc.providerName! : formSrc?.source ?? "in_app"}
        formProviderRef={formSrc?.providerRef}
        esignProvider={formSrc?.source === "platform" ? formSrc.providerName : undefined}
        propertyAddress={property.address}
        propertyCity={property.city}
        propertyState={property.state}
        propertyZip={property.zip}
        listingId={property.listingId}
        propertyAddressAiFilled={property.aiFilledAddress}
        onBack={() => setFlowStep("strategy")}
        onSuccess={onSuccess}
      />
    )
  }

  // Steps 1 & 2
  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <p className="text-sm font-semibold">
          {flowStep === "address" ? "Step 1 — Property Address" : "Step 2 — Form Source"}
        </p>
        <button onClick={onCancel} className="text-xs text-muted-foreground hover:underline">Cancel</button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
        {/* Step 1 — address */}
        <div className="space-y-3">
          <label className="block text-sm font-medium">Property address</label>
          <div className="relative">
            <input
              type="text"
              value={addressInput}
              onChange={e => onAddressChange(e.target.value)}
              placeholder="123 Main St..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {isLoadingAddress && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              </div>
            )}
            {showDropdown && suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 z-20 mt-1 rounded-md border border-border bg-popover shadow-md overflow-hidden">
                {suggestions.map(s => (
                  <button
                    key={s.id}
                    onClick={() => selectListing(s)}
                    className="w-full text-left px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors border-b border-border/50 last:border-0"
                  >
                    <span className="font-medium">{s.address}</span>
                    <span className="text-muted-foreground ml-2 text-xs">
                      {s.city}, {s.state} {s.zip}
                      {s.list_price ? ` — $${Number(s.list_price).toLocaleString()}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {property?.listingId && (
            <div className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-md px-3 py-1.5">
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Internal listing — details loaded
              {property.listPrice && ` ($${Number(property.listPrice).toLocaleString()})`}
            </div>
          )}

          {addressInput.length > 3 && suggestions.length === 0 && !isLoadingAddress && !property?.listingId && (
            <p className="text-xs text-muted-foreground">
              External property — AI will fill what it can
            </p>
          )}
        </div>

        {/* Step 2 — form source (shown after address confirmed) */}
        {flowStep === "form_source" && formSrc && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Form Source</p>
            {isLoadingFormSrc ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                Checking for forms...
              </div>
            ) : (
              <div className="rounded-md border border-border bg-muted/30 px-4 py-3 flex items-center gap-2">
                <span className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
                  formSrc.source === "uploaded_doc" && "bg-blue-50 border-blue-200 text-blue-700",
                  formSrc.source === "platform"     && "bg-green-50 border-green-200 text-green-700",
                  formSrc.source === "in_app"       && "bg-muted border-border text-muted-foreground"
                )}>
                  {formSrc.source === "uploaded_doc" ? "Uploaded Doc"
                    : formSrc.source === "platform" ? "Platform"
                    : "In-App"}
                </span>
                <span className="text-sm text-muted-foreground">{formSrc.label}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-5 py-4 flex items-center gap-3">
        <button
          onClick={onCancel}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
        >
          Cancel
        </button>
        {flowStep === "address" ? (
          <button
            onClick={confirmAddress}
            disabled={!addressInput.trim() || isLoadingFormSrc}
            className="ml-auto rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {isLoadingFormSrc ? "Checking..." : "Continue"}
          </button>
        ) : (
          <button
            onClick={proceedFromFormSource}
            disabled={isLoadingFormSrc}
            className="ml-auto rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            Get AI Strategy
          </button>
        )}
      </div>
    </div>
  )
}
