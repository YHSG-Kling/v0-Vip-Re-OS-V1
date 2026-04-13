"use client"

import { useState, useTransition } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Upload, Sparkles, Link, RefreshCw, Loader2, Target, AlertCircle, Wrench, TrendingDown, CheckCircle2, ShieldAlert, RotateCcw } from "lucide-react"
import {
  evaluateSellerDecisionReadiness,
  validateSellerDecisionReversal,
  logSellerDecisionTransition,
} from "@/app/actions/seller-decision-governance"
import { OfferUploadZone } from "./components/offer-upload-zone"
import { OfferComparisonMatrix } from "./components/offer-comparison-matrix"
import { OfferCard } from "./components/offer-card"
import { ComplianceBridgePanel } from "./components/compliance-bridge-panel"
import { CounterOfferSlideOver } from "./components/counter-offer-slide-over"
import { AIRecommendationBanner } from "./components/ai-recommendation-banner"
import {
  SellerMeaningCard,
  NegotiationRecommendationCard,
  TimelineRiskCard,
  SellerNetSheetCard,
} from "./components/intelligence"
// SellerNetSheetCard is also used in the overview tab per-offer — same import above
import {
  triggerOfferComparison,
  generateSellerPortalLink,
  acceptOffer,
  rejectOffer,
  getTransactionByListingId,
  getRepairNegotiationItems,
} from "@/app/actions/seller-offers"
import { aiNegotiationAdvisor } from "@/app/actions/ai-predictions"
import { aiCounterOfferStrategy } from "@/app/actions/ai-offer-creation"
import { SellerDecisionReadinessCard } from "./components/seller-decision-readiness-card"
import { DecisionHistoryPanel } from "@/app/components/dashboard/listings/lifecycle/decision-history-panel"
import { toast } from "@/hooks/use-toast"
import { getOfferContext } from "@/lib/contacts/ownership-model"

type Offer = {
  id: string
  offer_number: string | null
  offer_price: number
  earnest_money: number | null
  earnest_money_amount: number | null
  closing_date: string | null
  financing_type: string | null
  down_payment_amount: number | null
  down_payment_percent: number | null
  appraisal_contingency_days: number | null
  financing_contingency_days: number | null
  inspection_period_days: number | null
  escalation_clause: boolean | null
  escalation_cap: number | null
  appraisal_gap: number | null
  closing_cost_contribution: number | null
  due_diligence_fee: number | null
  possession_terms: string | null
  contingencies: string[] | null
  buyer_notes: string | null
  seller_net_estimate: number | null
  ai_recommendation: string | null
  ai_analysis: Record<string, unknown> | null
  ai_extraction_status: string | null
  offer_document_url: string | null
  offer_document_name: string | null
  status: string | null
  offer_type: string | null
  parent_offer_id: string | null
  current_round: number | null
  is_winning_offer: boolean | null
  winning_offer: boolean | null
  submitted_at: string | null
  response_deadline: string | null
  seller_viewed_at: string | null
  contact_id: string
  agent_id: string | null
  brokerage_id: string | null
  esign_status?: string | null
  esign_provider?: string | null
  esign_sent_at?: string | null
  esign_completed_at?: string | null
  buyer_signed_at?: string | null
  counter_amount?: number | null
  counter_terms?: Record<string, unknown> | null
  form_source?: string | null
  buyer_agent?: { full_name: string | null } | null
}

interface Props {
  listing: {
    id: string
    address: string
    city: string | null
    state: string | null
    list_price: number | null
    status: string | null
    brokerage_id: string | null
    agent_id: string | null
  }
  initialOffers: Offer[]
  currentUserId: string
  brokerageId: string
  userRole: string
}

export function OffersManagerClient({ listing, initialOffers, currentUserId, brokerageId, userRole }: Props) {
  const [offers, setOffers] = useState<Offer[]>(initialOffers)
  const [activeTab, setActiveTab] = useState("overview")
  const [counterTarget, setCounterTarget] = useState<Offer | null>(null)
  const [aiResult, setAiResult] = useState<Record<string, unknown> | null>(null)
  const [isPending, startTransition] = useTransition()
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null)

  // Negotiation advisor — counter-offer scenario (no transaction needed in UI, but action requires it)
  const [counterAdvisor, setCounterAdvisor] = useState<any>(null)
  const [counterAdvisorLoading, setCounterAdvisorLoading] = useState(false)
  const [counterAdvisorError, setCounterAdvisorError] = useState<string | null>(null)

  // Negotiation advisor — inspection/repairs scenario (requires transaction)
  const [repairsAdvisor, setRepairsAdvisor] = useState<any>(null)
  const [repairsAdvisorLoading, setRepairsAdvisorLoading] = useState(false)
  const [repairsAdvisorError, setRepairsAdvisorError] = useState<string | null>(null)
  const [repairItems, setRepairItems] = useState<any[]>([])

  // AI Counter-Offer Strategy (aiCounterOfferStrategy) — direct, no transaction required
  const [counterOfferStrategy, setCounterOfferStrategy] = useState<any>(null)
  const [counterOfferStrategyLoading, setCounterOfferStrategyLoading] = useState(false)
  const [counterOfferStrategyError, setCounterOfferStrategyError] = useState<string | null>(null)

  // Seller readiness gate — runs before acceptOffer
  const [evalOfferId, setEvalOfferId] = useState<string | null>(null)
  const [decisionEval, setDecisionEval] = useState<any>(null)
  const [evalLoading, setEvalLoading] = useState(false)
  const [overrideReason, setOverrideReason] = useState("")
  const [showOverrideInput, setShowOverrideInput] = useState(false)

  // Decision reversal validation
  const [reversalOffer, setReversalOffer] = useState<Offer | null>(null)
  const [reversalReason, setReversalReason] = useState("")
  const [reversalResult, setReversalResult] = useState<any>(null)
  const [reversalLoading, setReversalLoading] = useState(false)

  const selectedOffer = selectedOfferId ? offers.find(o => o.id === selectedOfferId) ?? null : null

  const activeOffers = offers.filter((o) => o.status !== "rejected")
  const canApprove = ["admin", "broker", "owner"].includes(userRole)

  function handleUploadComplete(newOffer: Offer) {
    setOffers((prev) => [newOffer, ...prev])
  }

  function handleRunAI() {
    startTransition(async () => {
      const result = await triggerOfferComparison({
        listingId: listing.id,
        brokerageId,
        agentUserId: currentUserId,
      })
      if (result.success && result.result) {
        setAiResult(result.result as Record<string, unknown>)
        toast({ title: "AI comparison generated" })
      } else {
        toast({ title: "AI comparison failed", description: result.error, variant: "destructive" })
      }
    })
  }

  function handleCopyPortalLink() {
    startTransition(async () => {
      const result = await generateSellerPortalLink({ listingId: listing.id, brokerageId })
      if (result.success && result.url) {
        await navigator.clipboard.writeText(result.url)
        toast({ title: "Seller portal link copied", description: `Expires ${new Date(result.expires_at!).toLocaleDateString()}` })
      } else {
        toast({ title: "Failed to generate link", variant: "destructive" })
      }
    })
  }

  function handleAccept(offerId: string) {
    startTransition(async () => {
      const result = await acceptOffer({ offerId, listingId: listing.id, brokerageId, agentUserId: currentUserId })
      if (result.success) {
        setOffers((prev) =>
          prev.map((o) =>
            o.id === offerId
              ? { ...o, is_winning_offer: true, winning_offer: true, status: "accepted" }
              : { ...o, is_winning_offer: false, winning_offer: false }
          )
        )
        toast({ title: "Offer accepted", description: "Listing moved to Under Contract" })
      } else {
        toast({ title: "Accept failed", description: result.error, variant: "destructive" })
      }
    })
  }

  // Seller readiness gate — intercepts Accept button, runs AI eval first
  async function handleAcceptGate(offerId: string) {
    // If this offer is already evaluated and passed, proceed directly
    if (evalOfferId === offerId && decisionEval?.success && decisionEval?.data?.isReady) {
      handleProceedAccept(offerId, false, "")
      return
    }
    setEvalOfferId(offerId)
    setDecisionEval(null)
    setShowOverrideInput(false)
    setOverrideReason("")
    setEvalLoading(true)
    const result = await evaluateSellerDecisionReadiness({
      listingId: listing.id,
      targetState: "SELLER_DECISION_READY" as any,
    })
    setDecisionEval(result)
    setEvalLoading(false)
  }

  // Called after readiness check passes (or override confirmed)
  function handleProceedAccept(offerId: string, isOverride: boolean, reason: string) {
    startTransition(async () => {
      await logSellerDecisionTransition({
        listing_id: listing.id,
        to_state: "SELLER_DECISION_READY" as any,
        authority_role: "agent",
        override_flag: isOverride,
        override_reason: isOverride ? reason : undefined,
        metadata: { offerId, action: "accept_offer" },
      })
    })
    handleAccept(offerId)
    setEvalOfferId(null)
    setDecisionEval(null)
    setShowOverrideInput(false)
    setOverrideReason("")
  }

  // Validates whether a seller decision reversal is appropriate
  async function handleValidateReversal() {
    if (!reversalOffer) return
    setReversalLoading(true)
    setReversalResult(null)
    const result = await validateSellerDecisionReversal({
      listingId: listing.id,
      currentDecisionState: "SELLER_DECISION_READY" as any,
      currentListingStage: listing.status ?? "active",
    })
    setReversalResult(result)
    setReversalLoading(false)
  }

  // Commits the reversal and logs the audit trail
  async function handleProceedReversal(isOverride: boolean) {
    if (!reversalOffer) return
    await logSellerDecisionTransition({
      listing_id: listing.id,
      from_state: "SELLER_DECISION_READY" as any,
      to_state: "SELLER_DECISION_READY" as any,
      authority_role: "agent",
      override_flag: isOverride,
      override_reason: reversalReason || undefined,
      metadata: { offerId: reversalOffer.id, action: "decision_reversal", reason: reversalReason },
    })
    toast({ title: "Decision reversal logged to audit trail" })
    setReversalOffer(null)
    setReversalReason("")
    setReversalResult(null)
  }

  function handleReject(offerId: string) {
    startTransition(async () => {
      const result = await rejectOffer({ offerId, listingId: listing.id, brokerageId, agentUserId: currentUserId })
      if (result.success) {
        setOffers((prev) => prev.filter((o) => o.id !== offerId))
        toast({ title: "Offer rejected" })
      } else {
        toast({ title: "Reject failed", description: result.error, variant: "destructive" })
      }
    })
  }

  // Counter-offer negotiation advisor — wired to aiCounterOfferStrategy, no transaction required.
  async function handleCounterAdvisor(offer: typeof activeOffers[0]) {
    setCounterAdvisorLoading(true)
    setCounterAdvisorError(null)
    setCounterAdvisor(null)
    try {
      const result = await aiCounterOfferStrategy({
        originalOffer:    offer.offer_price,
        listPrice:        listing.list_price ?? offer.offer_price,
        counterAmount:    offer.offer_price * 1.02,
        counterTerms:     {},
        buyerMaxBudget:   offer.offer_price * 1.1,
        negotiationRound: offer.current_round ?? 1,
      })
      if ((result as any).success === false) {
        setCounterAdvisorError((result as any).error ?? "Counter strategy failed.")
      } else {
        setCounterAdvisor(result)
      }
    } catch {
      setCounterAdvisorError("Unexpected error — please try again.")
    } finally {
      setCounterAdvisorLoading(false)
    }
  }

  // Repairs negotiation advisor — called during inspection/repair contingency period.
  // Only meaningful after a transaction exists and inspection issues are logged.
  async function handleRepairsAdvisor(offer: typeof activeOffers[0]) {
    setRepairsAdvisorLoading(true)
    setRepairsAdvisorError(null)
    setRepairsAdvisor(null)
    const transaction = await getTransactionByListingId(listing.id)
    if (!transaction) {
      setRepairsAdvisorError("No linked transaction found. A transaction must exist before running repairs negotiation advice.")
      setRepairsAdvisorLoading(false)
      return
    }
    // Load actual repair items from transaction_repair_negotiations
    const repairsResult = await getRepairNegotiationItems(transaction.id)
    const items = repairsResult.items ?? []
    setRepairItems(items)
    const inspectionIssues = items.map(i => ({
      description:    i.item_description,
      estimatedCost:  i.estimated_cost,
      priority:       i.priority,
      status:         i.status,
    }))
    const result = await aiNegotiationAdvisor({
      transactionId:   transaction.id,
      scenario:        "inspection_repairs",
      currentOffer:    offer.offer_price,
      listPrice:       listing.list_price ?? undefined,
      inspectionIssues: inspectionIssues.length > 0 ? inspectionIssues : undefined,
    })
    if (result.success) {
      setRepairsAdvisor(result)
    } else {
      setRepairsAdvisorError(result.error ?? "Repairs advisor failed.")
    }
    setRepairsAdvisorLoading(false)
  }

  async function handleCounterOfferStrategy(offer: typeof activeOffers[0]) {
    setCounterOfferStrategyLoading(true)
    setCounterOfferStrategyError(null)
    setCounterOfferStrategy(null)
    try {
      const result = await aiCounterOfferStrategy({
        originalOffer: offer.offer_price,
        listPrice: listing.list_price ?? offer.offer_price,
        counterAmount: offer.offer_price * 1.02,
        counterTerms: {},
        buyerMaxBudget: offer.offer_price * 1.1,
        negotiationRound: offer.current_round ?? 1,
      })
      if ((result as any).success === false) {
        setCounterOfferStrategyError((result as any).error ?? "Counter strategy failed.")
      } else {
        setCounterOfferStrategy(result)
      }
    } catch {
      setCounterOfferStrategyError("Unexpected error — please try again.")
    } finally {
      setCounterOfferStrategyLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{listing.address}</h1>
          <p className="text-sm text-muted-foreground">
            {listing.city}, {listing.state} &middot; Listed at{" "}
            {listing.list_price != null
              ? `$${listing.list_price.toLocaleString()}`
              : "price TBD"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={activeOffers.length > 0 ? "default" : "secondary"}>
            {activeOffers.length} active offer{activeOffers.length !== 1 ? "s" : ""}
          </Badge>
          <Button variant="outline" size="sm" onClick={handleCopyPortalLink} disabled={isPending}>
            <Link className="mr-1.5 h-3.5 w-3.5" />
            Seller Portal Link
          </Button>
          {activeOffers.length >= 2 && (
            <Button variant="outline" size="sm" onClick={handleRunAI} disabled={isPending}>
              {isPending ? (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              Run AI Comparison
            </Button>
          )}
        </div>
      </div>

          {/* Seller Decision Readiness — always shown so agent can verify before reviewing offers */}
          <SellerDecisionReadinessCard listingId={listing.id} />

          {/* Decision History — last 20 decisions for this listing */}
          <DecisionHistoryPanel listingId={listing.id} />

      {/* AI recommendation banner */}
      {aiResult && (
        <AIRecommendationBanner
          result={aiResult}
          offers={activeOffers}
        />
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="intelligence" disabled={activeOffers.length === 0}>
            Decision Intelligence
          </TabsTrigger>
          <TabsTrigger value="matrix" disabled={activeOffers.length < 2}>
            Comparison Matrix
          </TabsTrigger>
          <TabsTrigger value="upload">
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Upload Offer
          </TabsTrigger>
        </TabsList>

        {/* OVERVIEW — individual offer cards */}
        <TabsContent value="overview" className="mt-4">
          {activeOffers.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
                <p className="text-muted-foreground text-sm">No active offers yet.</p>
                <Button variant="outline" size="sm" onClick={() => setActiveTab("upload")}>
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  Upload First Offer
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-4">
              {activeOffers.map((offer) => (
                <div key={offer.id} className="flex flex-col gap-2">
                  <OfferCard
                    offer={offer}
                    listPrice={listing.list_price ?? 0}
                    canApprove={canApprove}
                    isPending={isPending}
                    onAccept={() => handleAcceptGate(offer.id)}
                    onReject={() => handleReject(offer.id)}
                    onCounter={() => setCounterTarget(offer)}
                  />
                  {/* Source badge + buyer's agent — cross-side routing metadata */}
                  <div className="flex items-center gap-2 flex-wrap px-1">
                    {offer.form_source === "in_app" && (
                      <Badge className="bg-blue-100 text-blue-800 border-blue-200 text-xs font-normal">
                        Via Buyer Portal
                      </Badge>
                    )}
                    {offer.form_source === "platform" && (
                      <Badge className="bg-muted text-muted-foreground border-border text-xs font-normal">
                        Via Platform
                      </Badge>
                    )}
                    {offer.form_source === "uploaded_doc" && (
                      <Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs font-normal">
                        Uploaded
                      </Badge>
                    )}
                    {offer.agent_id && (() => {
                      const ctx = getOfferContext(listing.id, listing.agent_id ?? null, offer.agent_id)
                      return (
                        <span className="text-xs text-muted-foreground">
                          {ctx.isCrossSide && ctx.isSameAgent
                            ? "Dual Agency"
                            : `Buyer's Agent: ${offer.buyer_agent?.full_name ?? "Unknown"}`}
                        </span>
                      )
                    })()}
                  </div>
                  <SellerNetSheetCard
                    offer={offer}
                    listing={{
                      id: listing.id,
                      state: listing.state,
                      agent_id: listing.agent_id,
                    }}
                    agentId={listing.agent_id ?? currentUserId}
                    county={listing.city ?? undefined}
                  />
                  {(offer.status === "countered" || offer.counter_amount != null) && (
                    <div className="flex items-center gap-2 px-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs text-purple-700 border-purple-200 hover:bg-purple-50 h-7"
                        onClick={() => handleCounterAdvisor(offer)}
                        disabled={counterAdvisorLoading}
                      >
                        {counterAdvisorLoading ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                        ) : (
                          <Sparkles className="h-3 w-3 mr-1 text-purple-500" />
                        )}
                        Counter Strategy
                      </Button>
                    </div>
                  )}

                  {/* Compliance Bridge — shows compliance state, hold reason, and transaction link */}
                  <ComplianceBridgePanel
                    offerId={offer.id}
                    listingId={listing.id}
                    brokerageId={brokerageId}
                    agentUserId={currentUserId}
                    initialState={{
                      offerStatus:      offer.status ?? null,
                      compliancePassed: false,   // evaluated lazily on first action — avoids N+1 at load
                      transactionId:    null,
                    }}
                    onAccepted={(txId) => {
                      setOffers(prev =>
                        prev.map(o =>
                          o.id === offer.id
                            ? { ...o, status: "accepted", is_winning_offer: true, winning_offer: true }
                            : { ...o, is_winning_offer: false, winning_offer: false }
                        )
                      )
                      toast({ title: "Offer accepted — transaction created", description: `Transaction ID: ${txId.slice(0, 8)}…` })
                    }}
                  />

                  {/* Change Decision — reversal validation for accepted/countered offers */}
                  {(offer.status === "accepted" || offer.status === "countered") && (
                    <div className="flex items-center gap-2 px-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-xs text-muted-foreground h-7 gap-1"
                        onClick={() => {
                          setReversalOffer(reversalOffer?.id === offer.id ? null : offer)
                          setReversalResult(null)
                          setReversalReason("")
                        }}
                      >
                        <RotateCcw className="h-3 w-3" />
                        Change Decision
                      </Button>
                    </div>
                  )}

                  {/* Reversal validation panel */}
                  {reversalOffer?.id === offer.id && (
                    <div className="mx-1 rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                      <p className="text-xs font-semibold text-amber-900 flex items-center gap-1.5">
                        <ShieldAlert className="h-3.5 w-3.5" />
                        Decision Reversal Validation
                      </p>
                      <p className="text-xs text-amber-800">
                        AI will evaluate whether reversing this decision is appropriate given the current listing stage and legal constraints.
                      </p>
                      <Textarea
                        className="text-xs min-h-[60px] resize-none"
                        placeholder="Why are you changing this decision? (recorded in audit trail)"
                        value={reversalReason}
                        onChange={(e) => setReversalReason(e.target.value)}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs h-7 gap-1 border-amber-300 text-amber-900 hover:bg-amber-100"
                        onClick={handleValidateReversal}
                        disabled={reversalLoading}
                      >
                        {reversalLoading ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Sparkles className="h-3 w-3" />
                        )}
                        AI Validate Reversal
                      </Button>
                      {reversalResult?.success && (
                        <div className={`rounded-md border p-2.5 space-y-2 ${
                          reversalResult.data?.allowed
                            ? "bg-green-50 border-green-200"
                            : "bg-red-50 border-red-200"
                        }`}>
                          <p className={`text-xs font-medium flex items-center gap-1.5 ${
                            reversalResult.data?.allowed ? "text-green-800" : "text-red-800"
                          }`}>
                            {reversalResult.data?.allowed ? (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            ) : (
                              <AlertCircle className="h-3.5 w-3.5" />
                            )}
                            {reversalResult.data?.allowed
                              ? "Reversal is appropriate"
                              : "Reversal not recommended"}
                          </p>
                          {reversalResult.data?.reason && (
                            <p className="text-xs text-muted-foreground">{reversalResult.data.reason}</p>
                          )}
                          <div className="flex gap-2 pt-1">
                            {reversalResult.data?.allowed && (
                              <Button
                                size="sm"
                                className="text-xs h-7"
                                onClick={() => handleProceedReversal(false)}
                              >
                                Proceed with Reversal
                              </Button>
                            )}
                            {!reversalResult.data?.allowed && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs h-7 border-red-300 text-red-800"
                                onClick={() => handleProceedReversal(true)}
                              >
                                Override & Proceed Anyway
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7"
                              onClick={() => { setReversalOffer(null); setReversalResult(null); setReversalReason("") }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                      {reversalResult && !reversalResult.success && (
                        <p className="text-xs text-red-600">{reversalResult.error ?? "Validation failed"}</p>
                      )}
                    </div>
                  )}

                  {/* Seller Readiness Gate — shown inline when this offer's Accept was clicked */}
                  {evalOfferId === offer.id && (
                    <div className="mx-1">
                      {evalLoading && (
                        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                          Running seller readiness evaluation...
                        </div>
                      )}
                      {decisionEval?.success && decisionEval.data?.isReady && (
                        <div className="rounded-lg border border-green-200 bg-green-50 p-3 space-y-2">
                          <p className="text-xs font-semibold text-green-900 flex items-center gap-1.5">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Seller is ready to accept
                          </p>
                          {decisionEval.data.warnings?.length > 0 && (
                            <ul className="space-y-0.5">
                              {decisionEval.data.warnings.map((w: string, i: number) => (
                                <li key={i} className="text-xs text-green-700">{w}</li>
                              ))}
                            </ul>
                          )}
                          <div className="flex gap-2 pt-1">
                            <Button
                              size="sm"
                              className="text-xs h-7 bg-green-700 hover:bg-green-800 text-white"
                              onClick={() => handleProceedAccept(offer.id, false, "")}
                              disabled={isPending}
                            >
                              Proceed with Acceptance
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7"
                              onClick={() => { setEvalOfferId(null); setDecisionEval(null) }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                      {decisionEval?.success && !decisionEval.data?.isReady && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                          <p className="text-xs font-semibold text-amber-900 flex items-center gap-1.5">
                            <AlertCircle className="h-3.5 w-3.5" />
                            Review before proceeding
                          </p>
                          {decisionEval.data.blockers?.length > 0 && (
                            <ul className="space-y-0.5">
                              {decisionEval.data.blockers.map((b: string, i: number) => (
                                <li key={i} className="text-xs text-amber-800 flex items-start gap-1">
                                  <span className="shrink-0 mt-0.5">&#9888;</span>
                                  {b}
                                </li>
                              ))}
                            </ul>
                          )}
                          {decisionEval.data.warnings?.length > 0 && (
                            <ul className="space-y-0.5">
                              {decisionEval.data.warnings.map((w: string, i: number) => (
                                <li key={i} className="text-xs text-amber-700 flex items-start gap-1">
                                  <span className="shrink-0 mt-0.5">&#128161;</span>
                                  {w}
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="flex gap-2 pt-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs h-7"
                              onClick={() => setShowOverrideInput((v) => !v)}
                            >
                              Override & Accept Anyway
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7"
                              onClick={() => { setEvalOfferId(null); setDecisionEval(null); setShowOverrideInput(false) }}
                            >
                              Cancel
                            </Button>
                          </div>
                          {showOverrideInput && (
                            <div className="space-y-2 pt-1 border-t border-amber-200">
                              <Textarea
                                className="text-xs min-h-[60px] resize-none"
                                placeholder="Override reason (required for audit trail)"
                                value={overrideReason}
                                onChange={(e) => setOverrideReason(e.target.value)}
                              />
                              <Button
                                size="sm"
                                className="text-xs h-7 w-full"
                                disabled={!overrideReason.trim() || isPending}
                                onClick={() => handleProceedAccept(offer.id, true, overrideReason)}
                              >
                                Confirm Override & Accept
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                      {decisionEval && !decisionEval.success && (
                        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md p-2">
                          {decisionEval.error ?? "Readiness evaluation failed"}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* counterAdvisor result — shown below offers list once triggered */}
              {counterAdvisor && (
                <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
                  <p className="text-sm font-semibold text-purple-900 mb-2">AI Counter Strategy</p>
                  {counterAdvisor.recommendedResponse && (
                    <p className="text-sm font-medium">
                      Recommendation:{" "}
                      <span className="capitalize">{counterAdvisor.recommendedResponse}</span>
                    </p>
                  )}
                  {counterAdvisor.suggestedCounterPrice && (
                    <p className="text-sm font-medium">
                      Suggested counter: ${Number(counterAdvisor.suggestedCounterPrice).toLocaleString()}
                    </p>
                  )}
                  {counterAdvisor.reasoning && (
                    <p className="text-xs text-muted-foreground mt-1">{counterAdvisor.reasoning}</p>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCounterAdvisor(null)}
                    className="text-xs text-purple-600 hover:underline mt-2 px-0 h-auto"
                  >
                    Clear
                  </Button>
                </div>
              )}
              {counterAdvisorError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md p-2 mt-2">
                  {counterAdvisorError}
                </p>
              )}
            </div>
          )}
        </TabsContent>

        {/* DECISION INTELLIGENCE */}
        <TabsContent value="intelligence" className="mt-4">
          {activeOffers.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
                <p className="text-muted-foreground text-sm">Upload an offer to see decision intelligence.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {/* Offer Selector */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Select Offer to Analyze</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {activeOffers.map((offer) => (
                      <Button
                        key={offer.id}
                        size="sm"
                        variant={selectedOfferId === offer.id ? "default" : "outline"}
                        onClick={() => setSelectedOfferId(offer.id)}
                      >
                        {offer.offer_number ?? `Offer`} - ${offer.offer_price.toLocaleString()}
                      </Button>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {selectedOffer && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Seller Meaning */}
                  <SellerMeaningCard
                    offer={selectedOffer}
                    listPrice={listing.list_price ?? 0}
                  />

                  {/* Negotiation Recommendation */}
                  <NegotiationRecommendationCard
                    offer={selectedOffer}
                    listPrice={listing.list_price ?? 0}
                    totalOffers={activeOffers.length}
                  />

                  {/* Timeline Risk */}
                  <TimelineRiskCard
                    offer={selectedOffer}
                    listPrice={listing.list_price ?? 0}
                  />

                  {/* Seller Net Sheet */}
                  <SellerNetSheetCard
                    offer={selectedOffer}
                    listing={listing}
                    agentId={listing.agent_id ?? currentUserId}
                  />

                  {/* Counter-Offer Negotiation Advisor */}
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm flex items-center gap-1.5">
                          <Target className="h-4 w-4 text-primary" />
                          Counter-Offer Advisor
                        </CardTitle>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleCounterAdvisor(selectedOffer)}
                          disabled={counterAdvisorLoading}
                          className="h-7 text-xs"
                        >
                          {counterAdvisorLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Advise"}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {counterAdvisorError && (
                        <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                          {counterAdvisorError}
                        </div>
                      )}
                      {!counterAdvisor && !counterAdvisorLoading && !counterAdvisorError && (
                        <p className="text-xs text-muted-foreground">
                          AI counter-offer strategy for this offer — recommended price, tactics, and walk-away thresholds. Requires an accepted offer/transaction to unlock.
                        </p>
                      )}
                      {counterAdvisorLoading && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Building counter strategy...
                        </div>
                      )}
                      {counterAdvisor && <NegotiationAdvisorResult data={counterAdvisor} />}
                    </CardContent>
                  </Card>

                  {/* AI Counter-Offer Strategy — direct, no transaction required */}
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm flex items-center gap-1.5">
                          <TrendingDown className="h-4 w-4 text-indigo-500" />
                          Counter-Offer Strategy
                        </CardTitle>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleCounterOfferStrategy(selectedOffer)}
                          disabled={counterOfferStrategyLoading}
                          className="h-7 text-xs"
                        >
                          {counterOfferStrategyLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Analyze"}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {counterOfferStrategyError && (
                        <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                          {counterOfferStrategyError}
                        </div>
                      )}
                      {!counterOfferStrategy && !counterOfferStrategyLoading && !counterOfferStrategyError && (
                        <p className="text-xs text-muted-foreground">
                          AI-powered counter response: accept, counter, or walk away — with pricing guidance and negotiation tactics. Works without an existing transaction.
                        </p>
                      )}
                      {counterOfferStrategyLoading && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Building counter strategy...
                        </div>
                      )}
                      {counterOfferStrategy && (
                        <div className="space-y-3">
                          {counterOfferStrategy.recommendedResponse && (
                            <div className="flex items-center gap-2">
                              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${
                                counterOfferStrategy.recommendedResponse === "accept"
                                  ? "bg-green-50 text-green-800 border-green-200"
                                  : counterOfferStrategy.recommendedResponse === "walk_away"
                                  ? "bg-red-50 text-red-800 border-red-200"
                                  : "bg-blue-50 text-blue-800 border-blue-200"
                              }`}>
                                {counterOfferStrategy.recommendedResponse === "accept" ? "Accept" : counterOfferStrategy.recommendedResponse === "walk_away" ? "Walk Away" : "Counter"}
                              </span>
                              {counterOfferStrategy.riskOfLosingDeal != null && (
                                <span className="text-xs text-muted-foreground">
                                  Deal risk: {counterOfferStrategy.riskOfLosingDeal}%
                                </span>
                              )}
                            </div>
                          )}
                          {counterOfferStrategy.suggestedCounterPrice && (
                            <p className="text-sm font-semibold">
                              Suggested counter: ${Number(counterOfferStrategy.suggestedCounterPrice).toLocaleString()}
                            </p>
                          )}
                          {counterOfferStrategy.estimatedFinalPrice && (
                            <p className="text-xs text-muted-foreground">
                              Estimated final price: ${Number(counterOfferStrategy.estimatedFinalPrice).toLocaleString()}
                            </p>
                          )}
                          {counterOfferStrategy.reasoning && (
                            <p className="text-xs text-muted-foreground">{counterOfferStrategy.reasoning}</p>
                          )}
                          {counterOfferStrategy.negotiationTactics?.length > 0 && (
                            <div className="space-y-1">
                              <p className="text-xs font-medium">Tactics</p>
                              {counterOfferStrategy.negotiationTactics.map((t: string, i: number) => (
                                <div key={i} className="rounded border border-border bg-muted/10 px-2.5 py-1.5 text-xs text-muted-foreground">{t}</div>
                              ))}
                            </div>
                          )}
                          {counterOfferStrategy.nextMoveTimeline && (
                            <p className="text-xs text-muted-foreground">Timeline: {counterOfferStrategy.nextMoveTimeline}</p>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Repairs Negotiation Advisor — inspection/repair contingency period only */}
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm flex items-center gap-1.5">
                          <Wrench className="h-4 w-4 text-amber-500" />
                          Repairs Negotiation Advisor
                        </CardTitle>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRepairsAdvisor(selectedOffer)}
                          disabled={repairsAdvisorLoading}
                          className="h-7 text-xs"
                        >
                          {repairsAdvisorLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Advise"}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {repairsAdvisorError && (
                        <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                          {repairsAdvisorError}
                        </div>
                      )}
                      {!repairsAdvisor && !repairsAdvisorLoading && !repairsAdvisorError && (
                        <p className="text-xs text-muted-foreground">
                          AI guidance for negotiating inspection repair requests. Pulls live repair items from the transaction and advises which to accept, credit, or push back on.
                        </p>
                      )}
                      {repairsAdvisorLoading && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Analyzing repair items...
                        </div>
                      )}
                      {repairsAdvisor && (
                        <div className="space-y-3">
                          {repairItems.length > 0 && (
                            <div className="rounded-md border border-border bg-muted/20 px-3 py-2 space-y-1">
                              <p className="text-xs font-medium">Repair items ({repairItems.length})</p>
                              {repairItems.map((item, i) => (
                                <div key={item.id ?? i} className="flex items-center justify-between text-xs text-muted-foreground">
                                  <span className="truncate mr-2">{item.item_description}</span>
                                  {item.estimated_cost != null && (
                                    <span className="shrink-0">${Number(item.estimated_cost).toLocaleString()}</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          <NegotiationAdvisorResult data={repairsAdvisor} />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              )}

              {!selectedOffer && activeOffers.length > 0 && (
                <Card>
                  <CardContent className="py-12 text-center">
                    <p className="text-muted-foreground text-sm">
                      Select an offer above to see detailed decision intelligence.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </TabsContent>

        {/* COMPARISON MATRIX */}
        <TabsContent value="matrix" className="mt-4">
          <OfferComparisonMatrix
            offers={activeOffers}
            listPrice={listing.list_price ?? 0}
            aiResult={aiResult}
          />
        </TabsContent>

        {/* UPLOAD ZONE */}
        <TabsContent value="upload" className="mt-4">
          <OfferUploadZone
            listingId={listing.id}
            brokerageId={brokerageId}
            onUploadComplete={(offer) => {
              handleUploadComplete(offer as unknown as Offer)
              setActiveTab("overview")
            }}
          />
        </TabsContent>
      </Tabs>

      {/* Counter offer slide-over */}

      {counterTarget && (
        <CounterOfferSlideOver
          offer={counterTarget}
          listingId={listing.id}
          brokerageId={brokerageId}
          agentUserId={currentUserId}
          onClose={() => setCounterTarget(null)}
          onSuccess={(counter) => {
            setOffers((prev) => [counter as unknown as Offer, ...prev])
            setCounterTarget(null)
          }}
        />
      )}
    </div>
  )
}

// ── Shared result renderer for both negotiation advisor scenarios ─────────────
function NegotiationAdvisorResult({ data }: { data: any }) {
  const parsed = typeof data === "string" ? (() => { try { return JSON.parse(data) } catch { return null } })() : data
  const rec = parsed?.recommendedOffer ?? parsed?.recommendedCounterOffer ?? null
  const tactics: Array<{ tactic?: string; script?: string }> = parsed?.negotiationTactics ?? []
  const counterStrategy = parsed?.counterofferStrategy?.if_they_counter_at
  return (
    <div className="space-y-3">
      {rec && (
        <div className="rounded-md bg-primary/5 border border-primary/20 px-3 py-2 space-y-1">
          {rec.amount && (
            <>
              <p className="text-xs text-muted-foreground">Recommended amount</p>
              <p className="text-lg font-semibold">${Number(rec.amount).toLocaleString()}</p>
            </>
          )}
          {rec.reasoning && <p className="text-xs text-muted-foreground">{rec.reasoning}</p>}
          {rec.walkAwayPrice && (
            <p className="text-xs text-muted-foreground">
              Walk away at: <span className="font-medium">${Number(rec.walkAwayPrice).toLocaleString()}</span>
            </p>
          )}
        </div>
      )}
      {parsed?.recommendedApproach && (
        <p className="text-sm text-muted-foreground">{parsed.recommendedApproach}</p>
      )}
      {tactics.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Tactics</p>
          {tactics.map((t, i) => (
            <div key={i} className="rounded border border-border bg-muted/10 px-2.5 py-2 text-xs space-y-0.5">
              {t.tactic && <p className="font-medium">{t.tactic}</p>}
              {t.script && <p className="text-muted-foreground italic">{t.script}</p>}
            </div>
          ))}
        </div>
      )}
      {counterStrategy && (
        <div className="space-y-1">
          <p className="text-xs font-medium">If they counter at...</p>
          {Object.entries(counterStrategy).map(([price, advice]) => (
            <div key={price} className="flex items-start gap-2 text-xs">
              <span className="font-medium shrink-0">${Number(price).toLocaleString()}</span>
              <span className="text-muted-foreground">{String(advice)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
