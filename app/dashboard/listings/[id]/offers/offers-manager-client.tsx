"use client"

import { useState, useTransition } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Upload, Sparkles, Link, RefreshCw, Loader2, Target, AlertCircle, Wrench } from "lucide-react"
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
  getRepairNegotiationItems,
} from "@/app/actions/seller-offers"
import { aiNegotiationAdvisor } from "@/app/actions/ai-predictions"
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
  esign_status?: string | null
  esign_provider?: string | null
  esign_sent_at?: string | null
  esign_completed_at?: string | null
  buyer_signed_at?: string | null
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

  // Counter-offer negotiation advisor — called when agent is deciding whether to counter.
  // A transaction may not exist yet; if none found, still try to advise using offer + list price.
  async function handleCounterAdvisor(offer: typeof activeOffers[0]) {
    setCounterAdvisorLoading(true)
    setCounterAdvisorError(null)
    setCounterAdvisor(null)
    const transaction = await getTransactionByListingId(listing.id)
    if (!transaction) {
      setCounterAdvisorError(
        "No accepted transaction exists yet. Accept or counter an offer first, then the full advisor unlocks. " +
        "In the meantime, use the Negotiation Recommendation card above."
      )
      setCounterAdvisorLoading(false)
      return
    }
    const result = await aiNegotiationAdvisor({
      transactionId: transaction.id,
      scenario:      "counteroffer",
      currentOffer:  offer.offer_price,
      listPrice:     listing.list_price ?? undefined,
    })
    if (result.success) {
      setCounterAdvisor(result)
    } else {
      setCounterAdvisorError(result.error ?? "Counter-offer advisor failed.")
    }
    setCounterAdvisorLoading(false)
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
