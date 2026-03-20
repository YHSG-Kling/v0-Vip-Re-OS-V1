"use client"

import { useState, useTransition } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Upload, Sparkles, Link, RefreshCw, Loader2, TrendingUp, Target, AlertCircle } from "lucide-react"
import { OfferUploadZone } from "./components/offer-upload-zone"
import { OfferComparisonMatrix } from "./components/offer-comparison-matrix"
import { OfferCard } from "./components/offer-card"
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
} from "@/app/actions/seller-offers"
import { predictWinningOffer, aiNegotiationAdvisor } from "@/app/actions/ai-predictions"
import { SellerDecisionReadinessCard } from "./components/seller-decision-readiness-card"
import { toast } from "@/hooks/use-toast"

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

  // Win probability + negotiation advisor state
  const [winProbability, setWinProbability] = useState<any>(null)
  const [winProbLoading, setWinProbLoading] = useState(false)
  const [negotiationAdvisor, setNegotiationAdvisor] = useState<any>(null)
  const [advisorLoading, setAdvisorLoading] = useState(false)
  const [advisorError, setAdvisorError] = useState<string | null>(null)

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

  async function handleWinProbability(offer: typeof activeOffers[0]) {
    setWinProbLoading(true)
    setWinProbability(null)
    const result = await predictWinningOffer({
      listingId:      listing.id,
      propertyMlsId:  listing.id, // used for IDX fallback — handled gracefully if no IDX
      brokerageId,
      offers: activeOffers.map(o => ({
        offerId:        o.id,
        offerPrice:     o.offer_price,
        financingType:  o.financing_type ?? "unknown",
        earnestMoney:   o.earnest_money_amount ?? o.earnest_money ?? 0,
        closingDate:    o.closing_date ?? undefined,
        contingencies:  o.contingencies ?? [],
        escalationClause: !!o.escalation_clause,
        escalationCap:  o.escalation_cap ?? undefined,
        appraisalGap:   o.appraisal_gap ?? undefined,
        closingCosts:   o.closing_cost_contribution ?? undefined,
        isCompetitive:  (o.offer_price ?? 0) >= (listing.list_price ?? 0),
      })),
      targetOfferId: offer.id,
    })
    if (result.success) {
      setWinProbability(result)
    } else {
      toast({ title: "Could not predict win probability", description: result.error, variant: "destructive" })
    }
    setWinProbLoading(false)
  }

  async function handleNegotiationAdvisor(offer: typeof activeOffers[0]) {
    setAdvisorLoading(true)
    setAdvisorError(null)
    setNegotiationAdvisor(null)
    // Negotiation advisor requires a linked transaction — look it up first
    const transaction = await getTransactionByListingId(listing.id)
    if (!transaction) {
      setAdvisorError("No transaction linked to this listing. Create a transaction first to use the Negotiation Advisor.")
      setAdvisorLoading(false)
      return
    }
    const result = await aiNegotiationAdvisor({
      transactionId: transaction.id,
      offerId:       offer.id,
      listingId:     listing.id,
      brokerageId,
    })
    if (result.success) {
      setNegotiationAdvisor(result)
    } else {
      setAdvisorError(result.error ?? "Negotiation advisor failed.")
    }
    setAdvisorLoading(false)
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
                    onAccept={() => handleAccept(offer.id)}
                    onReject={() => handleReject(offer.id)}
                    onCounter={() => setCounterTarget(offer)}
                  />
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
                </div>
              ))}
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

                  {/* Win Probability — AI-powered */}
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm flex items-center gap-1.5">
                          <TrendingUp className="h-4 w-4 text-emerald-500" />
                          Win Probability
                        </CardTitle>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleWinProbability(selectedOffer)}
                          disabled={winProbLoading}
                          className="h-7 text-xs"
                        >
                          {winProbLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Run AI Analysis"}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {!winProbability && !winProbLoading && (
                        <p className="text-xs text-muted-foreground">
                          Compare all {activeOffers.length} offer{activeOffers.length !== 1 ? "s" : ""} to predict which is most likely to close successfully.
                        </p>
                      )}
                      {winProbLoading && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Analyzing all offers...
                        </div>
                      )}
                      {winProbability && (
                        <div className="space-y-3">
                          <div className="flex items-end gap-3">
                            <span className="text-4xl font-bold text-emerald-600">
                              {Math.round((winProbability.targetOfferWinProbability ?? 0) * 100)}%
                            </span>
                            <span className="text-sm text-muted-foreground pb-1">win probability</span>
                          </div>
                          {winProbability.recommendation && (
                            <p className="text-sm text-muted-foreground">{winProbability.recommendation}</p>
                          )}
                          {winProbability.riskFactors?.length > 0 && (
                            <div className="rounded-md bg-muted/30 border border-border px-3 py-2 space-y-1">
                              <p className="text-xs font-medium">Risk factors</p>
                              {winProbability.riskFactors.map((r: string, i: number) => (
                                <p key={i} className="text-xs text-muted-foreground">{r}</p>
                              ))}
                            </div>
                          )}
                          {winProbability.strengthFactors?.length > 0 && (
                            <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 space-y-1">
                              <p className="text-xs font-medium text-emerald-800">Strengths</p>
                              {winProbability.strengthFactors.map((s: string, i: number) => (
                                <p key={i} className="text-xs text-emerald-700">{s}</p>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Negotiation Advisor — requires linked transaction */}
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm flex items-center gap-1.5">
                          <Target className="h-4 w-4 text-primary" />
                          AI Negotiation Advisor
                        </CardTitle>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleNegotiationAdvisor(selectedOffer)}
                          disabled={advisorLoading}
                          className="h-7 text-xs"
                        >
                          {advisorLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Get Advice"}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {advisorError && (
                        <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                          {advisorError}
                        </div>
                      )}
                      {!negotiationAdvisor && !advisorLoading && !advisorError && (
                        <p className="text-xs text-muted-foreground">
                          Get AI-powered counter-offer strategy and negotiation tactics for this offer. Requires a linked transaction.
                        </p>
                      )}
                      {advisorLoading && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Analyzing negotiation position...
                        </div>
                      )}
                      {negotiationAdvisor && (
                        <div className="space-y-3">
                          {negotiationAdvisor.strategy && (
                            <div>
                              <p className="text-xs font-medium mb-1">Recommended strategy</p>
                              <p className="text-sm text-muted-foreground">{negotiationAdvisor.strategy}</p>
                            </div>
                          )}
                          {negotiationAdvisor.counterOfferPrice && (
                            <div className="rounded-md bg-primary/5 border border-primary/20 px-3 py-2">
                              <p className="text-xs text-muted-foreground">Suggested counter price</p>
                              <p className="text-lg font-semibold">${negotiationAdvisor.counterOfferPrice.toLocaleString()}</p>
                            </div>
                          )}
                          {negotiationAdvisor.tactics?.length > 0 && (
                            <div className="space-y-1.5">
                              <p className="text-xs font-medium">Negotiation tactics</p>
                              {negotiationAdvisor.tactics.map((t: string, i: number) => (
                                <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                                  <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
                                  {t}
                                </div>
                              ))}
                            </div>
                          )}
                          {negotiationAdvisor.redFlags?.length > 0 && (
                            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 space-y-1">
                              <p className="text-xs font-medium text-red-800">Red flags</p>
                              {negotiationAdvisor.redFlags.map((f: string, i: number) => (
                                <p key={i} className="text-xs text-red-700">{f}</p>
                              ))}
                            </div>
                          )}
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
