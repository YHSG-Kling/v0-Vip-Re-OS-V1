"use client"

/**
 * @deprecated USE FormWizard mode="offer" GOING FORWARD.
 *
 * Per the canonical wizard pattern: offers should be created via the same
 * FormWizard surface that listings use (`@/app/components/form-wizard/FormWizard`
 * with `mode="offer"`). OfferInitiationFlow + OfferFormWizard are a
 * second-generation strategic-prep wizard that pre-dates the canonical
 * decision; their value-adds (StrategyAdvisor, escalation calc, buyer letter,
 * contingency reco) need to be folded into FormWizard mode="offer" as
 * optional advanced steps.
 *
 * MIGRATION PLAN (separate commit):
 *   1. Add an "Advanced strategy" step group to FormWizard mode="offer"
 *      that exposes:
 *        - StrategyAdvisor (uses `aiOfferStrategyAdvisor`)
 *        - Escalation calculator (`aiCalculateEscalation`)
 *        - Buyer letter generator (`aiGenerateBuyerLetter`)
 *        - Contingency recommender (`aiRecommendContingencies`)
 *      All optional / collapsible — agent can skip if doing a quick capture
 *   2. Update `app/crm/contacts/[contactId]/offers/new/new-offer-page-client.tsx`
 *      and `app/crm/contacts/[contactId]/offers/offers-client.tsx` to launch
 *      FormWizard mode="offer" with strategic mode enabled
 *   3. Delete OfferInitiationFlow + OfferFormWizard (~1944 lines retired)
 *
 * UNCHANGED by this consolidation:
 *   - Inbound offer upload (PDF + AI extraction) stays a separate flow —
 *     different concept (ingest, not create). See app/dashboard/listings/
 *     [id]/offers/upload (or equivalent route).
 *   - Counter-offer flow stays in offer detail page using parent_offer_id
 *     chain. Not a wizard.
 *
 * Until the migration ships, this file remains the active offer creation
 * surface from the buyer-detail flow. Do NOT add new features here that
 * aren't also in FormWizard mode="offer".
 */

import { useState, useCallback, useTransition, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import {
  searchListingsByAddress,
  resolveFormSource,
  type StrategyRecommendation,
} from "@/app/actions/buyer-offers"
import { StrategyAdvisor }   from "./strategy-advisor"
import { OfferFormWizard }   from "./offer-form-wizard"
import {
  aiCalculateEscalation,
  aiGenerateBuyerLetter,
  aiRecommendContingencies,
  aiOfferStrategyAdvisor,
  getOfferForms,
} from "@/app/actions/ai-offer-creation"
import { getConnectedEsignProvider } from "@/app/actions/buyer-offers"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Check, AlertTriangle, ExternalLink, Sparkles, Building2, FileText } from "lucide-react"
import { awardPointsForAction } from "@/app/lib/gamification/award-on-action"
import { createClient } from "@/lib/supabase/client"
import { getOfferContext, type OfferContext } from "@/lib/contacts/ownership-model"
import { FormSelectorStep, type FormFieldValues } from "@/app/components/forms/form-selector-step"

import { SendForSignaturesPanel } from "@/app/components/shared/SendForSignaturesPanel"

type FlowStep = "address" | "form_source" | "forms" | "strategy" | "escalation" | "buyer_letter" | "contingencies" | "wizard" | "send_for_signatures"

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
  contactId:          string
  brokerageId:        string
  agentUserId:        string
  contactName:        string
  contactEmail:       string
  onSuccess:          () => void
  onCancel:           () => void
  // Prefill from CRM — when provided, address step is auto-resolved
  initialAddress?:    string
  initialBuyerPhone?: string
  initialBuyerEmail?: string
}

export function OfferInitiationFlow({
  contactId, brokerageId, agentUserId,
  contactName, contactEmail, onSuccess, onCancel,
  initialAddress, initialBuyerPhone, initialBuyerEmail,
}: OfferInitiationFlowProps) {
  // If address was pre-filled from CRM, skip directly to form_source step
  const [flowStep, setFlowStep]   = useState<FlowStep>(initialAddress ? "form_source" : "address")
  const [addressInput, setAddressInput] = useState(initialAddress ?? "")
  // Track newly created offer id for the send_for_signatures step
  const [createdOfferId, setCreatedOfferId] = useState<string | null>(null)

  // Resolved brokerage e-sign provider — loaded once on mount
  const [connectedProvider, setConnectedProvider] = useState<{ platform: string; accountName: string | null } | null | undefined>(undefined)

  useEffect(() => {
    if (!brokerageId) { setConnectedProvider(null); return }
    getConnectedEsignProvider(brokerageId).then(setConnectedProvider).catch(() => setConnectedProvider(null))
  }, [brokerageId])
  const [suggestions, setSuggestions]   = useState<{ id: string; address: string; city: string; state: string; zip: string; list_price: number }[]>([])
  const [nominatimSuggestions, setNominatimSuggestions] = useState<{ display_name: string; address: { house_number?: string; road?: string; city?: string; town?: string; village?: string; state?: string; postcode?: string } }[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [formSrc, setFormSrc]     = useState<ResolvedFormSource | null>(null)
  const [recommendation, setRecommendation] = useState<StrategyRecommendation | null>(null)
  const [isLoadingAddress, startAddressLoad] = useTransition()
  const [isLoadingFormSrc, startFormSrcLoad] = useTransition()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cross-side routing context — derived from listing DB check; null = no property selected yet
  const [offerCtx, setOfferCtx] = useState<OfferContext | null>(null)

  // If initialAddress was passed, bootstrap the property state immediately
  const [property, setProperty] = useState<ResolvedProperty | null>(
    initialAddress ? {
      address:         initialAddress,
      city:            "",
      state:           "",
      zip:             "",
      listingId:       null,
      listPrice:       null,
      aiFilledAddress: true,
    } : null
  )

  // AI Strategy Briefing state
  const [mktConditions, setMktConditions] = useState("balanced")
  const [buyerMotiv, setBuyerMotiv] = useState("would_like")
  const [strategyAdvice, setStrategyAdvice] = useState<any>(null)
  const [strategyLoading, setStrategyLoading] = useState(false)

  // Escalation state
  const [escalationResult, setEscalationResult] = useState<any>(null)
  const [escalationLoading, setEscalationLoading] = useState(false)
  const [escalationForm, setEscalationForm] = useState({
    initialOffer: '',
    maxBudget: '',
    competition: 'medium' as 'none' | 'low' | 'medium' | 'high',
    trend: 'stable' as 'appreciating' | 'stable' | 'declining',
  })

  // Buyer letter state
  const [buyerLetter, setBuyerLetter] = useState('')
  const [letterLoading, setLetterLoading] = useState(false)
  const [letterForm, setLetterForm] = useState({ buyerStory: '', whyThisHome: '' })

  // Contingency state
  const [contingencyResult, setContingencyResult] = useState<any>(null)
  const [contingencyLoading, setContingencyLoading] = useState(false)
  const [selectedContingencies, setSelectedContingencies] = useState<string[]>([])
  const [contingencyForm, setContingencyForm] = useState({
    financingType:     'conventional',
    propertyAge:       0,
    propertyCondition: 'good' as 'excellent' | 'good' | 'fair' | 'needs_work',
    competitionLevel:  'medium' as 'none' | 'low' | 'medium' | 'high',
    riskTolerance:     'moderate' as 'conservative' | 'moderate' | 'aggressive',
  })

  // Forms / provider state (loaded after form_source is resolved)
  const [availableForms, setAvailableForms] = useState<{ required: string[]; addenda: string[]; aiRecommended: string[] } | null>(null)
  const [formsLoading, setFormsLoading] = useState(false)

  // Offer form selection + field values (in_app path — FormSelectorStep)
  const [offerSelectedFormIds, setOfferSelectedFormIds] = useState<string[]>([])
  const [offerFormFieldValues, setOfferFormFieldValues] = useState<FormFieldValues>({})

  function handleOfferFormsComplete(ids: string[], values: FormFieldValues) {
    setOfferSelectedFormIds(ids)
    setOfferFormFieldValues(values)
    setFlowStep("strategy")
  }

  // ── Step 1: Address search ──────────────────────────────────────────────────

  const onAddressChange = useCallback((value: string) => {
    setAddressInput(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.length < 3) {
      setSuggestions([])
      setNominatimSuggestions([])
      setShowDropdown(false)
      return
    }

    setNominatimSuggestions([])
    debounceRef.current = setTimeout(() => {
      startAddressLoad(async () => {
        const results = await searchListingsByAddress(value, brokerageId)
        setSuggestions(results)
        setShowDropdown(results.length > 0 || value.length >= 3)

        // Only call Nominatim when internal results are insufficient
        if (results.length < 2) {
          try {
            const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=us&limit=5&q=${encodeURIComponent(value)}`
            const response = await fetch(nominatimUrl, {
              headers: { 'User-Agent': 'KernelOS-RealEstate/1.0' }
            })
            if (response.ok) {
              const nominatimResults = await response.json()
              setNominatimSuggestions(nominatimResults ?? [])
              setShowDropdown(true)
            }
          } catch {
            // Nominatim failure is silent — internal results still shown
          }
        }
      })
    }, 500)
  }, [brokerageId])

  function selectListing(s: typeof suggestions[0]) {
    setAddressInput(s.address)
    setShowDropdown(false)
    setSuggestions([])
    setNominatimSuggestions([])
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

  function selectNominatimResult(result: typeof nominatimSuggestions[0]) {
    const addr = result.address
    const street = [addr.house_number, addr.road].filter(Boolean).join(" ")
    const city = addr.city ?? addr.town ?? addr.village ?? ""
    const state = addr.state ?? ""
    const zip = addr.postcode ?? ""
    const fullAddress = street || result.display_name
    setAddressInput(fullAddress)
    setShowDropdown(false)
    setSuggestions([])
    setNominatimSuggestions([])
    setProperty({
      address:         fullAddress,
      city,
      state,
      zip,
      listingId:       null,
      listPrice:       null,
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
    // Resolve provider — then optionally pre-fetch forms if platform connected
    startFormSrcLoad(async () => {
      // When property is a brokerage listing, fetch agent_id for dual-agency detection
      if (resolved.listingId) {
        const supabase = createClient()
        const { data: listingRow } = await supabase
          .from("listings")
          .select("id, agent_id, seller_contact_id, address, list_price")
          .eq("id", resolved.listingId)
          .single()
        if (listingRow) {
          setOfferCtx(getOfferContext(resolved.listingId, listingRow.agent_id, agentUserId))
        } else {
          setOfferCtx(getOfferContext(resolved.listingId, null, agentUserId))
        }
      } else {
        setOfferCtx(getOfferContext(null, null, agentUserId))
      }

      const src = await resolveFormSource(contactId, brokerageId)
      setFormSrc(src)
      // If connected to a transaction platform, pre-load available forms
      if (src.source === "platform" && resolved.state) {
        setFormsLoading(true)
        const formsResult = await getOfferForms({
          state:           resolved.state || "DEFAULT",
          financingType:   "conventional",
          isShortSale:     false,
          hasHoa:          false,
          isNewConstruction: false,
        })
        if (formsResult.success && formsResult.forms) {
          setAvailableForms(formsResult.forms as any)
        }
        setFormsLoading(false)
      }
      setFlowStep("form_source")
    })
  }

  // ── Step 2: Form source ─────────────────────────────────────────────────────

  function proceedFromFormSource() {
    setFlowStep("forms")
  }

  // ── Step 3: Strategy ────────────────────────────────────────────────────────

  function onUseStrategy(rec: StrategyRecommendation) {
    setRecommendation(rec)
    setFlowStep("escalation")
  }

  function onCustomizeStrategy(rec: StrategyRecommendation) {
    setRecommendation(rec)
    setFlowStep("escalation")
  }

  function onSkipStrategy() {
    setRecommendation(null)
    setFlowStep("escalation")
  }

  // ── RENDER ──────────────────────────────────────────────────────────────────

  // ── Step 3: Forms selection ─────────────────────────────────────────────────

  if (flowStep === "forms") {
    // For in_app path: use FormSelectorStep for full select + fill experience
    if (formSrc?.source === "in_app") {
      return (
        <div className="flex flex-col h-full overflow-y-auto">
          <div className="px-5 py-4 border-b border-border">
            <p className="text-sm font-semibold">Step 3 — Offer Documents</p>
          </div>
          <div className="flex-1 px-5 py-4">
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2 mb-4">
              <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-800">No transaction provider connected</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Connect a forms provider in Settings for state-approved forms. Using brokerage in-app forms below.
                </p>
              </div>
            </div>
            <FormSelectorStep
              contextType="offer"
              state={property?.state ?? undefined}
              autoLoad
              nextLabel="Next: AI Strategy"
              onBack={() => setFlowStep("form_source")}
              onComplete={handleOfferFormsComplete}
            />
          </div>
        </div>
      )
    }

    // Platform / uploaded_doc paths — show info banner, manual advance
    return (
      <div className="flex flex-col h-full overflow-y-auto">
        <div className="px-5 py-4 border-b border-border flex items-center gap-3">
          <button onClick={() => setFlowStep("form_source")} className="text-sm text-muted-foreground hover:underline">
            Back
          </button>
          <p className="text-sm font-semibold">Step 3 — Offer Documents</p>
        </div>

        <div className="flex-1 px-5 py-4 space-y-4">
          {formSrc?.source === "platform" && (
            <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 flex items-center gap-2">
              <Check className="h-4 w-4 text-green-600 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-green-800">Forms: {formSrc.providerName}</p>
                <p className="text-xs text-green-700">
                  Required forms will be pulled automatically from your connected provider when the offer wizard opens.
                </p>
              </div>
            </div>
          )}
          {formSrc?.source === "uploaded_doc" && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 flex items-center gap-2">
              <FileText className="h-4 w-4 text-blue-600 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-blue-800">Uploaded Document</p>
                <p className="text-xs text-blue-700">{formSrc.label}</p>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-border px-5 py-4 flex items-center gap-3">
          <button
            onClick={() => setFlowStep("form_source")}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
          >
            Back
          </button>
          <button
            onClick={() => setFlowStep("strategy")}
            className="ml-auto rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Next: AI Strategy
          </button>
        </div>
      </div>
    )
  }

  if (flowStep === "strategy") {
    return (
      <div className="flex flex-col h-full overflow-y-auto">
        <div className="px-5 py-4 border-b border-border flex items-center gap-3">
          <button onClick={() => setFlowStep("forms")} className="text-sm text-muted-foreground hover:underline">
            Back
          </button>
          <p className="text-sm font-semibold">AI Strategy Recommendation</p>
        </div>
        <div className="flex-1 px-5 py-4 space-y-4">
          {/* AI Offer Strategy Briefing */}
          <Card className="border-blue-200 bg-blue-50">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-4 w-4 text-blue-600" />
                <span className="text-sm font-semibold text-blue-900">AI Offer Strategy</span>
              </div>
              {!strategyAdvice ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Market conditions</Label>
                      <Select value={mktConditions} onValueChange={setMktConditions}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="hot">Hot market</SelectItem>
                          <SelectItem value="balanced">Balanced</SelectItem>
                          <SelectItem value="cooling">Cooling</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Buyer motivation</Label>
                      <Select value={buyerMotiv} onValueChange={setBuyerMotiv}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="must_have">Must have this home</SelectItem>
                          <SelectItem value="would_like">Would like it</SelectItem>
                          <SelectItem value="nice_to_have">Nice to have</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={async () => {
                      setStrategyLoading(true)
                      const res = await aiOfferStrategyAdvisor({
                        agentId: agentUserId,
                        buyerId: contactId,
                        listingId: property?.listingId ?? "",
                        listPrice: property?.listPrice ?? 0,
                        daysOnMarket: 14,
                        marketConditions: mktConditions as "hot" | "balanced" | "cooling",
                        buyerMotivation: buyerMotiv as "must_have" | "would_like" | "nice_to_have",
                        buyerMaxBudget: (property?.listPrice ?? 0) * 1.05,
                      })
                      setStrategyAdvice(res)
                      setStrategyLoading(false)
                    }}
                    disabled={strategyLoading || !property?.listingId}
                    className="w-full"
                  >
                    {strategyLoading
                      ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Analyzing...</>
                      : "Get AI Strategy"}
                  </Button>
                  {!property?.listingId && (
                    <p className="text-xs text-blue-700">Select an internal listing to enable AI strategy</p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge className="bg-blue-100 text-blue-800 border-blue-200 capitalize text-xs">
                      {(strategyAdvice as any).strategy ?? "strategy ready"}
                    </Badge>
                    {(strategyAdvice as any).winProbability != null && (
                      <span className="text-xs text-blue-700">
                        Win probability: {(strategyAdvice as any).winProbability}%
                      </span>
                    )}
                  </div>
                  {(strategyAdvice as any).recommendedOfferPrice && (
                    <p className="text-sm font-semibold text-blue-900">
                      Recommended: ${Number((strategyAdvice as any).recommendedOfferPrice).toLocaleString()}
                      {(strategyAdvice as any).priceRangeLow && (strategyAdvice as any).priceRangeHigh && (
                        <span className="text-xs font-normal ml-1 text-blue-700">
                          (${Number((strategyAdvice as any).priceRangeLow).toLocaleString()} – ${Number((strategyAdvice as any).priceRangeHigh).toLocaleString()})
                        </span>
                      )}
                    </p>
                  )}
                  {(strategyAdvice as any).reasoning && (
                    <p className="text-xs text-blue-700">{(strategyAdvice as any).reasoning}</p>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setStrategyAdvice(null)} className="text-xs text-blue-700 px-0">
                    Redo Analysis
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

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

  if (flowStep === "escalation") {
    return (
      <div className="flex flex-col h-full overflow-y-auto">
        <div className="px-5 py-4 border-b border-border flex items-center gap-3">
          <button onClick={() => setFlowStep("strategy")} className="text-sm text-muted-foreground hover:underline">
            Back
          </button>
          <p className="text-sm font-semibold">Escalation Clause</p>
        </div>
        <div className="flex-1 px-5 py-4 space-y-4">
          <div>
            <h3 className="font-semibold">Model an Escalation Clause</h3>
            <p className="text-sm text-muted-foreground">
              Automatically beats competing offers up to your max — only when needed.
              This protects your buyer while staying competitive.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Initial Offer Price</Label>
              <Input
                type="number"
                placeholder="Offer amount"
                value={escalationForm.initialOffer}
                onChange={e => setEscalationForm(f => ({ ...f, initialOffer: e.target.value }))}
              />
            </div>
            <div>
              <Label>Maximum Budget</Label>
              <Input
                type="number"
                placeholder="Max you can go"
                value={escalationForm.maxBudget}
                onChange={e => setEscalationForm(f => ({ ...f, maxBudget: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Competition Level</Label>
              <Select value={escalationForm.competition} onValueChange={v => setEscalationForm(f => ({ ...f, competition: v as any }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Market Trend</Label>
              <Select value={escalationForm.trend} onValueChange={v => setEscalationForm(f => ({ ...f, trend: v as any }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="appreciating">Appreciating</SelectItem>
                  <SelectItem value="stable">Stable</SelectItem>
                  <SelectItem value="declining">Declining</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {!escalationResult ? (
            <Button
              onClick={async () => {
                setEscalationLoading(true)
                const result = await aiCalculateEscalation({
                  listPrice: property?.listPrice || Number(escalationForm.initialOffer),
                  initialOffer: Number(escalationForm.initialOffer),
                  maxBudget: Number(escalationForm.maxBudget),
                  estimatedCompetition: escalationForm.competition,
                  marketTrend: escalationForm.trend,
                })
                setEscalationResult(result)
                setEscalationLoading(false)
              }}
              disabled={escalationLoading || !escalationForm.initialOffer || !escalationForm.maxBudget}
            >
              {escalationLoading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Calculating...</> : 'Calculate Escalation'}
            </Button>
          ) : (
            <div className="p-4 bg-muted/40 rounded-lg space-y-2">
              <div className="flex items-center gap-2">
                {escalationResult.recommended
                  ? <Badge className="bg-green-100 text-green-800">Recommended</Badge>
                  : <Badge variant="secondary">Not recommended in this market</Badge>}
              </div>
              {escalationResult.recommended && (
                <>
                  <p className="text-sm">Starting: ${escalationResult.startingOffer?.toLocaleString()}</p>
                  <p className="text-sm">Increment: ${escalationResult.incrementAmount?.toLocaleString()}</p>
                  <p className="text-sm">Cap: ${escalationResult.capAmount?.toLocaleString()}</p>
                </>
              )}
              <p className="text-xs text-muted-foreground">{escalationResult.explanation}</p>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={() => setFlowStep('buyer_letter')}>
              {escalationResult ? 'Continue to Buyer Letter' : 'Skip Escalation'}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (flowStep === "buyer_letter") {
    return (
      <div className="flex flex-col h-full overflow-y-auto">
        <div className="px-5 py-4 border-b border-border flex items-center gap-3">
          <button onClick={() => setFlowStep("escalation")} className="text-sm text-muted-foreground hover:underline">
            Back
          </button>
          <p className="text-sm font-semibold">Buyer Letter</p>
        </div>
        <div className="flex-1 px-5 py-4 space-y-4">
          <div>
            <h3 className="font-semibold">Write a Buyer Letter</h3>
            <p className="text-sm text-muted-foreground">
              A personal letter increases acceptance rates — especially in competitive markets.
              Help your buyers connect with the seller on a human level.
            </p>
          </div>

          <div>
            <Label>Tell us about your buyer</Label>
            <Textarea
              rows={3}
              placeholder="What do they do? Family situation? What does homeownership mean to them?"
              value={letterForm.buyerStory}
              onChange={e => setLetterForm(f => ({ ...f, buyerStory: e.target.value }))}
            />
          </div>

          <div>
            <Label>Why is this home right for them?</Label>
            <Textarea
              rows={3}
              placeholder="What stood out? What made them excited?"
              value={letterForm.whyThisHome}
              onChange={e => setLetterForm(f => ({ ...f, whyThisHome: e.target.value }))}
            />
          </div>

          {!buyerLetter ? (
            <Button
              onClick={async () => {
                if (!letterForm.buyerStory || !letterForm.whyThisHome) return
                setLetterLoading(true)
                const result = await aiGenerateBuyerLetter({
                  agentId: agentUserId,
                  buyerFirstName: contactName.split(' ')[0],
                  buyerStory: letterForm.buyerStory,
                  propertyAddress: property?.address || '',
                  whyThisHome: letterForm.whyThisHome,
                })
                setBuyerLetter((result as any).letter || '')
                setLetterLoading(false)
              }}
              disabled={letterLoading || !letterForm.buyerStory || !letterForm.whyThisHome}
            >
              {letterLoading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating...</> : 'Generate Buyer Letter'}
            </Button>
          ) : (
            <div className="space-y-2">
              <Textarea rows={10} value={buyerLetter} onChange={e => setBuyerLetter(e.target.value)} />
              <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(buyerLetter)}>
                Copy Letter
              </Button>
            </div>
          )}

          <Button onClick={() => setFlowStep('contingencies')}>
            {buyerLetter ? 'Include with Offer' : 'Skip Buyer Letter'}
          </Button>
        </div>
      </div>
    )
  }

  if (flowStep === "contingencies") {
    return (
      <div className="flex flex-col h-full overflow-y-auto">
        <div className="px-5 py-4 border-b border-border flex items-center gap-3">
          <button onClick={() => setFlowStep("buyer_letter")} className="text-sm text-muted-foreground hover:underline">
            Back
          </button>
          <p className="text-sm font-semibold">Contingency Intelligence</p>
        </div>
        <div className="flex-1 px-5 py-4 space-y-4">
          <div>
            <h3 className="font-semibold">AI Contingency Recommendations</h3>
            <p className="text-sm text-muted-foreground">
              Tell us about the buyer and property so the AI can recommend which contingencies to include or waive.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Financing Type</Label>
              <Select value={contingencyForm.financingType} onValueChange={v => setContingencyForm(f => ({ ...f, financingType: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="conventional">Conventional</SelectItem>
                  <SelectItem value="fha">FHA</SelectItem>
                  <SelectItem value="va">VA</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="usda">USDA</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Property Age (years)</Label>
              <Input
                type="number"
                min={0}
                placeholder="e.g. 15"
                value={contingencyForm.propertyAge || ''}
                onChange={e => setContingencyForm(f => ({ ...f, propertyAge: Number(e.target.value) }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Property Condition</Label>
              <Select value={contingencyForm.propertyCondition} onValueChange={v => setContingencyForm(f => ({ ...f, propertyCondition: v as any }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="excellent">Excellent</SelectItem>
                  <SelectItem value="good">Good</SelectItem>
                  <SelectItem value="fair">Fair</SelectItem>
                  <SelectItem value="needs_work">Needs Work</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Competition Level</Label>
              <Select value={contingencyForm.competitionLevel} onValueChange={v => setContingencyForm(f => ({ ...f, competitionLevel: v as any }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Buyer Risk Tolerance</Label>
            <Select value={contingencyForm.riskTolerance} onValueChange={v => setContingencyForm(f => ({ ...f, riskTolerance: v as any }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">Conservative — protect the buyer</SelectItem>
                <SelectItem value="moderate">Moderate — balanced</SelectItem>
                <SelectItem value="aggressive">Aggressive — win the deal</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {!contingencyResult ? (
            <Button
              onClick={async () => {
                setContingencyLoading(true)
                const result = await aiRecommendContingencies({
                  buyerFinancingType:  contingencyForm.financingType,
                  propertyAge:         contingencyForm.propertyAge,
                  propertyCondition:   contingencyForm.propertyCondition,
                  competitionLevel:    contingencyForm.competitionLevel,
                  buyerRiskTolerance:  contingencyForm.riskTolerance,
                })
                if (result.success && result.contingencies) {
                  setContingencyResult(result.contingencies)
                  // Auto-select all critical recommended contingencies
                  const criticals = (result.contingencies as any).recommended
                    .filter((c: any) => c.critical)
                    .map((c: any) => c.type)
                  setSelectedContingencies(criticals)
                }
                setContingencyLoading(false)
              }}
              disabled={contingencyLoading}
            >
              {contingencyLoading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Analyzing...</> : 'Get AI Recommendations'}
            </Button>
          ) : (
            <div className="space-y-4">
              {/* Risk summary */}
              <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-muted/30 text-sm">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">Overall Risk</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      contingencyResult.riskAnalysis.overallRisk === 'low'    && 'border-green-200 bg-green-50 text-green-700',
                      contingencyResult.riskAnalysis.overallRisk === 'medium' && 'border-yellow-200 bg-yellow-50 text-yellow-700',
                      contingencyResult.riskAnalysis.overallRisk === 'high'   && 'border-red-200 bg-red-50 text-red-700',
                    )}
                  >
                    {contingencyResult.riskAnalysis.overallRisk}
                  </Badge>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">Buyer Protection</span>
                  <span className="font-medium">{contingencyResult.riskAnalysis.buyerProtection}%</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">Competitiveness</span>
                  <span className="font-medium">{contingencyResult.riskAnalysis.competitiveness}%</span>
                </div>
              </div>

              {/* Recommended contingencies */}
              <div>
                <p className="text-sm font-medium mb-2">Recommended</p>
                <div className="space-y-2">
                  {contingencyResult.recommended.map((c: any) => (
                    <label
                      key={c.type}
                      className="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer hover:bg-muted/30 transition-colors"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 rounded border-border"
                        checked={selectedContingencies.includes(c.type)}
                        onChange={e => {
                          setSelectedContingencies(prev =>
                            e.target.checked ? [...prev, c.type] : prev.filter(x => x !== c.type)
                          )
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{c.type}</span>
                          {c.critical && <Badge variant="destructive" className="text-xs px-1.5 py-0">Critical</Badge>}
                          <span className="text-xs text-muted-foreground">{c.duration}d</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{c.reasoning}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Not recommended */}
              {contingencyResult.notRecommended.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2 text-muted-foreground">Not Recommended to Include</p>
                  <div className="space-y-1.5">
                    {contingencyResult.notRecommended.map((c: any) => (
                      <div key={c.type} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-muted/20 text-sm">
                        <span className="font-medium">{c.type}:</span>
                        <span className="text-muted-foreground">{c.reasoning}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Suggestions */}
              {contingencyResult.suggestions?.length > 0 && (
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 space-y-1">
                  {contingencyResult.suggestions.map((s: string, i: number) => (
                    <p key={i} className="text-xs text-muted-foreground">{s}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button onClick={() => setFlowStep('wizard')}>
              {contingencyResult ? 'Continue to Offer Wizard' : 'Skip — Go to Offer Wizard'}
            </Button>
          </div>
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
        contingencies={selectedContingencies}
        buyerMaxBudget={Number(escalationForm.maxBudget) || undefined}
        buyerRiskTolerance={contingencyForm.riskTolerance}
        inAppSelectedFormIds={offerSelectedFormIds.length > 0 ? offerSelectedFormIds : undefined}
        inAppFormFieldValues={Object.keys(offerFormFieldValues).length > 0 ? offerFormFieldValues : undefined}
        onBack={() => setFlowStep("contingencies")}
        onSuccess={(newOfferId?: string) => {
          awardPointsForAction(agentUserId, "offer_submitted").catch(() => {})
          if (newOfferId) {
            setCreatedOfferId(newOfferId)
            setFlowStep("send_for_signatures")
          } else {
            onSuccess()
          }
        }}
      />
    )
  }

  // Step: Send for Signatures
  if (flowStep === "send_for_signatures") {
    return (
      <div className="flex flex-col h-full">
        <div className="px-5 py-4 border-b border-border">
          <p className="text-sm font-semibold">Send for Signatures</p>
          <p className="text-xs text-muted-foreground mt-0.5">Route to your connected e-sign provider or skip for now.</p>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          {createdOfferId ? (
            <SendForSignaturesPanel
              offerId={createdOfferId}
              userId={agentUserId}
              connectedProvider={connectedProvider ?? null}
              buyerName={contactName}
              buyerEmail={contactEmail}
              onSent={onSuccess}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Offer created. Signature routing not available at this time.</p>
          )}
          <button
            onClick={onSuccess}
            className="text-xs text-muted-foreground hover:underline w-full text-center pt-2"
          >
            Skip for now — I will send for signatures later
          </button>
        </div>
      </div>
    )
  }

  // Steps 1 & 2
  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <p className="text-sm font-semibold">
          {flowStep === "address" ? "Step 1 — Property Address" : "Step 2 — Provider & Form Source"}
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
            {showDropdown && (suggestions.length > 0 || nominatimSuggestions.length > 0) && (
              <div className="absolute top-full left-0 right-0 z-20 mt-1 rounded-md border border-border bg-popover shadow-md overflow-hidden">
                {suggestions.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-muted/40 border-b border-border/50">
                      Your Listings
                    </div>
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
                  </>
                )}
                {nominatimSuggestions.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-muted/40 border-b border-border/50">
                      Address Search
                    </div>
                    {nominatimSuggestions.map((n, i) => (
                      <button
                        key={i}
                        onClick={() => selectNominatimResult(n)}
                        className="w-full text-left px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors border-b border-border/50 last:border-0"
                      >
                        <span className="text-foreground">{n.display_name}</span>
                      </button>
                    ))}
                  </>
                )}
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
        {flowStep === "form_source" && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Form Source</p>

            {/* Cross-side banner — only when property is a brokerage listing */}
            {offerCtx?.isCrossSide && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                <div className="flex items-start gap-3">
                  <Building2 className="h-5 w-5 text-blue-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-blue-900">
                      {offerCtx.isSameAgent
                        ? "Dual Agency — Your Own Listing"
                        : "Brokerage Listing Detected"}
                    </p>
                    <p className="text-sm text-blue-700 mt-1">
                      {offerCtx.isSameAgent
                        ? "This property is listed by you. Both the buyer and seller are your clients. Disclose dual agency to all parties before proceeding."
                        : "This offer will be submitted to the listing agent within your brokerage. The seller will receive a notification in their portal."}
                    </p>
                    {offerCtx.isSameAgent && (
                      <p className="text-xs text-blue-600 mt-1 font-medium">
                        Dual agency disclosure required by your brokerage and state law.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
            {isLoadingFormSrc ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                Checking provider configuration...
              </div>
            ) : formSrc ? (
              <>
                {/* Platform connected — show provider badge + form list */}
                {formSrc.source === "platform" && (
                  <div className="space-y-3">
                    <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 flex items-center gap-2">
                      <Check className="h-4 w-4 text-green-600 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-green-800">Forms: {formSrc.providerName}</p>
                        <p className="text-xs text-green-700">Forms will be pulled from your connected provider.</p>
                      </div>
                    </div>
                    {formsLoading ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Loading available forms...
                      </div>
                    ) : availableForms ? (
                      <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5 space-y-2 text-xs">
                        <p className="font-medium">Required forms ({availableForms.required.length})</p>
                        <ul className="space-y-1">
                          {availableForms.required.map(f => (
                            <li key={f} className="flex items-center gap-1.5 text-muted-foreground">
                              <Check className="h-3 w-3 text-green-600 flex-shrink-0" />
                              {f}
                            </li>
                          ))}
                        </ul>
                        {availableForms.addenda.length > 0 && (
                          <>
                            <p className="font-medium pt-1">Applicable addenda ({availableForms.addenda.length})</p>
                            <ul className="space-y-1">
                              {availableForms.addenda.map(f => (
                                <li key={f} className="text-muted-foreground">{f}</li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                )}

                {/* Uploaded doc — keep as-is */}
                {formSrc.source === "uploaded_doc" && (
                  <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 flex items-center gap-2">
                    <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                      Uploaded Doc
                    </span>
                    <span className="text-sm text-blue-800">{formSrc.label}</span>
                  </div>
                )}

                {/* No provider connected — in-app brokerage forms available in next step */}
                {formSrc.source === "in_app" && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-amber-800">No transaction provider connected</p>
                        <p className="text-xs text-amber-700 mt-0.5">
                          Using brokerage in-app forms. Connect a provider in Settings for state-approved forms.
                          You will select and fill forms in the next step.
                        </p>
                      </div>
                    </div>
                    <a
                      href="/dashboard/settings/integrations"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Connect a provider in Settings
                    </a>
                  </div>
                )}
              </>
            ) : null}
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
            disabled={isLoadingFormSrc || !formSrc}
            className="ml-auto rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            Next: Select Forms
          </button>
        )}
      </div>
    </div>
  )
}
