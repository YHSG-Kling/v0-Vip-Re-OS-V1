"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Upload, Sparkles, Link, RefreshCw, Loader2, Target, AlertCircle, Wrench, TrendingDown, CheckCircle2, ShieldAlert, RotateCcw, Eye, EyeOff } from "lucide-react"
import {
  evaluateSellerDecisionReadiness,
  validateSellerDecisionReversal,
  logSellerDecisionTransition,
  logSellerDecisionReversal,
} from "@/app/actions/seller-decision-governance"
import { OfferUploadZone } from "./components/offer-upload-zone"
import { OfferComparisonMatrix } from "./components/offer-comparison-matrix"
import { OfferCard } from "./components/offer-card"
import { ComplianceBridgePanel } from "./components/compliance-bridge-panel"
import { CounterOfferSlideOver } from "./components/counter-offer-slide-over"
import CounterOfferDiffModal from "./components/counter-offer-diff-modal"
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
  loadLatestOfferComparison,
  generateSellerPortalLink,
  acceptOffer,
  rejectOffer,
  getOffersForListing,
  getTransactionByListingId,
  getRepairNegotiationItems,
} from "@/app/actions/seller-offers"
import {
  presentOfferToSeller,
  unpresentOfferFromSeller,
  getOfferPresentationStates,
} from "@/app/actions/offers/present-to-seller"
import { aiNegotiationAdvisor } from "@/app/actions/ai-predictions"
import { negotiationCoPilot } from "@/app/actions/negotiation-copilot"
import { SellerDecisionReadinessCard } from "./components/seller-decision-readiness-card"
import { DecisionHistoryPanel } from "@/app/components/dashboard/listings/lifecycle/decision-history-panel"
import { toast } from "@/hooks/use-toast"
import { getOfferContext } from "@/lib/contacts/ownership-model"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

type Offer = {
  id: string
  offer_number: string | null
  offer_price: number
  earnest_money: number | null
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
  /**
   * May this caller override a failing seller-decision gate?
   *
   * Resolved on the SERVER (page.tsx) because it is not answerable here: it is
   * users.user_type OR a role GRANT pinned to the caller's own brokerage, and the
   * grant half needs I/O a render path cannot do. Deriving it client-side from
   * `userRole` alone would hide the button from the grant-only admin the server
   * would have admitted — a courtesy gate NARROWER than the real gate, which
   * refuses a legitimate person for a reason they cannot see.
   *
   * Overriding this gate is BROKERAGE-WIDE MONEY, not an admin surface: it
   * suppresses a failing check on the CMA and the net sheet, the two documents
   * the seller's money decision rests on. m472 holds team_lead out of that tier,
   * so this is deliberately narrower than `canApprove`.
   */
  canOverrideDecisionGate: boolean
}

export function OffersManagerClient({ listing, initialOffers, currentUserId, brokerageId, userRole, canOverrideDecisionGate }: Props) {
  const [offers, setOffers] = useState<Offer[]>(initialOffers)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  // RE-READ FROM TRUTH after a state transition. Accept / reject / counter each
  // used to patch local React state only — splicing the row out, or flipping
  // is_winning_offer client-side — so the screen showed the outcome the caller
  // INTENDED rather than the one the database recorded. If a server-side
  // transition half-succeeded, the UI still claimed it worked, and stayed wrong
  // until a full page reload.
  // app/actions/seller-offers.ts:getOffersForListing is the authoritative reader
  // for exactly this (auth + listing-in-caller's-brokerage + tenant-anchored
  // query, same columns this page renders) and had no caller at all.
  const refreshOffers = useCallback(async () => {
    const res = await getOffersForListing(listing.id)
    if (!res.success) {
      // Do NOT silently keep stale rows on screen — say the list is stale.
      setRefreshError(res.error ?? "Could not refresh the offer list")
      return
    }
    setRefreshError(null)
    setOffers(res.offers as unknown as Offer[])
  }, [listing.id])
  // ── SELLER RELEASE STATE (wave 12, R4a) ────────────────────────────────────
  // `offers.presented_to_seller_at` is the gate on the seller portal: NULL means
  // the seller must not see the offer. The reader that loads the rows above
  // predates the column, so the release state is read separately, through the
  // same authenticated gate that writes it.
  const [presentation, setPresentation] = useState<Record<string, { presentedAt: string | null; note: string | null }>>({})
  const [presentationError, setPresentationError] = useState<string | null>(null)
  const [releasingOfferId, setReleasingOfferId] = useState<string | null>(null)

  const refreshPresentation = useCallback(async () => {
    const res = await getOfferPresentationStates(listing.id)
    if (!res.success) {
      // A refused read must never render as "not released yet" — that would show
      // an agent a Release button for an offer the seller can already see.
      setPresentationError(res.error ?? "Could not read which offers your seller can see")
      return
    }
    setPresentationError(null)
    const next: Record<string, { presentedAt: string | null; note: string | null }> = {}
    for (const s of res.states) next[s.offerId] = { presentedAt: s.presentedAt, note: s.note }
    setPresentation(next)
  }, [listing.id])

  useEffect(() => { void refreshPresentation() }, [refreshPresentation])

  function handleRelease(offerId: string) {
    setReleasingOfferId(offerId)
    startTransition(async () => {
      const result = await presentOfferToSeller({ offerId, listingId: listing.id })
      setReleasingOfferId(null)
      if (!result.success) {
        toast({ title: "Not released", description: result.error, variant: "destructive" })
        return
      }
      await refreshPresentation()
      const warning = (result.warnings ?? [])[0]
      toast({
        title: result.alreadyPresented ? "Already visible to your seller" : "Released to your seller",
        description: warning ?? "It is on their portal now, with the interactive net sheet.",
        variant: warning ? "destructive" : undefined,
      })
    })
  }

  function handleUnrelease(offerId: string) {
    setReleasingOfferId(offerId)
    startTransition(async () => {
      const result = await unpresentOfferFromSeller({ offerId, listingId: listing.id })
      setReleasingOfferId(null)
      if (!result.success) {
        toast({ title: "Not retracted", description: result.error, variant: "destructive" })
        return
      }
      await refreshPresentation()
      const warning = (result.warnings ?? [])[0]
      toast({
        title: "Hidden from your seller again",
        description: warning ?? "The offer and its portal alert are no longer on their screen.",
        variant: warning ? "destructive" : undefined,
      })
    })
  }

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

  // Hydrate the AI comparison from the latest persisted offer_comparison row so a
  // previously generated comparison survives refresh instead of requiring a re-run.
  useEffect(() => {
    let cancelled = false
    loadLatestOfferComparison(listing.id).then((res) => {
      if (cancelled || !res.success || !res.comparison) return
      const comparison = res.comparison as Record<string, any>
      const matrix = Array.isArray(comparison.comparison_matrix) ? comparison.comparison_matrix : []
      // comparison_matrix is persisted sorted best → worst by net_to_seller,
      // so its order doubles as the ranking the matrix badges expect.
      setAiResult((prev) =>
        prev ?? {
          recommendation: comparison.ai_recommendation ?? undefined,
          comparison_summary: comparison.ai_analysis_notes ?? undefined,
          ranked_offer_ids: matrix.map((m: any) => m.offer_id).filter(Boolean),
          recommended_offer_id: comparison.recommended_offer_id ?? undefined,
          net_to_seller_by_offer: comparison.net_to_seller_by_offer ?? undefined,
        }
      )
    })
    return () => {
      cancelled = true
    }
  }, [listing.id])

  const activeOffers = offers.filter((o) => o.status !== "rejected")
  const canApprove = isAdminOrBroker({ user_type: userRole })

  // A counter is PERSISTED as its own offers row pointing back at the original
  // (offers.parent_offer_id). That means the "what did they send back" side of a
  // diff is real stored data — the agent never re-keys the counter terms. Index
  // the newest counter per parent so each original offer can offer a diff.
  const counterByParent = useMemo(() => {
    const map = new Map<string, Offer>()
    for (const o of offers) {
      if (!o.parent_offer_id) continue
      const prev = map.get(o.parent_offer_id)
      // Latest negotiation round wins; submitted_at breaks ties when a
      // brokerage never populated current_round.
      const isNewer =
        !prev ||
        (o.current_round ?? 0) > (prev.current_round ?? 0) ||
        ((o.current_round ?? 0) === (prev.current_round ?? 0) &&
          (o.submitted_at ?? "") > (prev.submitted_at ?? ""))
      if (isNewer) map.set(o.parent_offer_id, o)
    }
    return map
  }, [offers])

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
        setAiResult(result.result as unknown as Record<string, unknown>)
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
        await refreshOffers()
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
  //
  // THE ENGINE IS THE AUTHORITY, NOT THE BUTTON. This used to log
  // `override_flag: true` and proceed — no authority test anywhere on the path.
  // The seller-decision override suppresses a FAILING check on the CMA and the
  // net sheet, which m472 places in the brokerage-wide money tier, so an override
  // now goes back through evaluateSellerDecisionReadiness with requestOverride
  // set; that action resolves the caller's real authority server-side (user_type
  // OR a role grant pinned to their own brokerage) and refuses if it is absent.
  // The button below is gated too, but a client-side gate is a courtesy — this
  // await is the gate.
  async function handleProceedAccept(offerId: string, isOverride: boolean, reason: string) {
    if (isOverride) {
      const authorized = await evaluateSellerDecisionReadiness({
        listingId: listing.id,
        targetState: "SELLER_DECISION_READY" as any,
        requestOverride: true,
        overrideReason: reason,
      })
      if (!authorized?.success) {
        toast({ title: "Override refused", description: authorized?.error ?? "Not authorised to override this gate.", variant: "destructive" })
        return
      }
      if (!authorized.data?.isReady) {
        // Authorised, but the override did not reach these blockers — the
        // presentation checks have no override path at all. Say which remain,
        // rather than proceeding on an override that cleared nothing.
        toast({
          title: "Override did not clear the blockers",
          description: (authorized.data?.blockers ?? []).join("; ") || "The listing is still not decision-ready.",
          variant: "destructive",
        })
        return
      }
    }
    // authority_role is NOT passed: the server stamps the session's seat. A
    // client-supplied actor in an audit trail is not an audit trail, and this
    // call site is why — it passed the literal "agent" for every user.
    const logged = await logSellerDecisionTransition({
      listing_id: listing.id,
      to_state: "SELLER_DECISION_READY" as any,
      override_flag: isOverride,
      override_reason: isOverride ? reason : undefined,
      metadata: { offerId, action: "accept_offer" },
    })
    if (!logged?.success) {
      // An OVERRIDE whose record was not written is an override with no
      // justification on file — halt, because the record IS the authority for it.
      // A normal acceptance is gated server-side by acceptOffer's compliance
      // check, so a governance-log outage must not strand the user there; it is
      // reported loudly and the acceptance goes on.
      if (isOverride) {
        toast({ title: "Override NOT recorded — acceptance halted", description: logged?.error ?? "The override could not be written to the audit trail, so it has no justification on file.", variant: "destructive" })
        return
      }
      toast({ title: "Decision not written to the audit trail", description: logged?.error ?? "The acceptance is proceeding, but this transition was not recorded.", variant: "destructive" })
    }
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
    // The toast below claims a COMPLIANCE RECORD exists. This action reports
    // failure by return, so that claim was made without ever checking that the
    // audit row was written. Never assert a record you did not confirm.
    //
    // A REVERSAL, not a transition. This used to log a degenerate
    // SELLER_DECISION_READY → SELLER_DECISION_READY "transition" with the real
    // meaning buried in metadata.action, so the audit trail recorded a state change
    // that never happened and the reversal itself had no event type of its own.
    // logSellerDecisionReversal writes `seller.decision.reversed` with the state
    // being reversed OUT OF and the reason as first-class fields — which is what
    // queryDecisionHistory (and the Decision History panel) reads back.
    const r = await logSellerDecisionReversal({
      listing_id: listing.id,
      from_state: "SELLER_DECISION_READY" as any,
      reversal_reason: reversalReason || "No reason given",
      // authority_role is stamped from the session server-side — this used to
      // pass the literal "agent" for every user, including the broker.
      metadata: { offerId: reversalOffer.id, override_flag: isOverride },
    })
    if (!r?.success) {
      toast({ title: "Reversal NOT logged", description: (r as any)?.error ?? "The audit trail was not written — do not treat this reversal as recorded.", variant: "destructive" })
      return
    }
    toast({ title: "Decision reversal logged to audit trail" })
    setReversalOffer(null)
    setReversalReason("")
    setReversalResult(null)
  }

  function handleReject(offerId: string) {
    startTransition(async () => {
      const result = await rejectOffer({ offerId, listingId: listing.id, brokerageId, agentUserId: currentUserId })
      if (result.success) {
        await refreshOffers()
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
      // Comprehensive Negotiation Co-Pilot — aggregates AI strategy +
      // comparable sales + draft response message in one call. Replaces
      // the previous bare aiCounterOfferStrategy call which also had an
      // unwrap bug (UI read .recommendedResponse from the wrapper instead
      // of the nested .strategy).
      const result = await negotiationCoPilot({
        offerId:        offer.id,
        side:           "seller",   // incoming offer on our listing
        buyerMaxBudget: offer.offer_price * 1.1,
      })
      if (!result.success) {
        setCounterAdvisorError(result.error ?? "Counter strategy failed.")
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
      setRepairsAdvisorError((result as any).error ?? "Repairs advisor failed.")
    }
    setRepairsAdvisorLoading(false)
  }

  async function handleCounterOfferStrategy(offer: typeof activeOffers[0]) {
    setCounterOfferStrategyLoading(true)
    setCounterOfferStrategyError(null)
    setCounterOfferStrategy(null)
    try {
      // Also routes through negotiationCoPilot so this secondary panel
      // gets the same fix as the primary counterAdvisor — same unwrapping +
      // bonus comparables/draft response.
      const result = await negotiationCoPilot({
        offerId:        offer.id,
        side:           "seller",   // incoming offer on our listing
        buyerMaxBudget: offer.offer_price * 1.1,
      })
      if (!result.success) {
        setCounterOfferStrategyError(result.error ?? "Counter strategy failed.")
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

      {/* A failed re-read must be visible: the rows on screen are then the
          PRE-transition list, and silently keeping them is how a UI ends up
          asserting a state the database never reached. */}
      {refreshError && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This list may be out of date — could not reload offers after the last change: {refreshError}
        </div>
      )}

      {presentationError && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          Could not read which of these offers your seller can see: {presentationError}. Treat the release state below as
          unknown until this loads.
        </div>
      )}

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
                    userId={currentUserId}
                    onAccept={() => handleAcceptGate(offer.id)}
                    onReject={() => handleReject(offer.id)}
                    onCounter={() => setCounterTarget(offer)}
                  />
                  {/* Source badge + buyer's agent — cross-side routing metadata */}
                  <div className="flex items-center gap-2 flex-wrap px-1">
                    {/* Diff & advise — only for an offer that actually HAS a
                        counter on file. The slide-over above CREATES a counter;
                        this ANALYZES the one that came back, so the agent reads
                        the changed terms instead of the whole contract. */}
                    {(() => {
                      const counter = counterByParent.get(offer.id)
                      if (!counter) return null
                      return (
                        <CounterOfferDiffModal
                          offerId={offer.id}
                          counterPayload={counterPayloadOf(counter)}
                          buttonLabel={
                            counter.current_round
                              ? `Diff round ${counter.current_round}`
                              : "Diff & advise"
                          }
                        />
                      )
                    })()}
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

                  {/* SELLER RELEASE — the owner's gate. Until this is clicked the
                      offer is invisible on the seller's portal, whatever its
                      status says. Reversible: an offer released by mistake is
                      retracted here and its portal alert goes with it. */}
                  {(() => {
                    const state = presentation[offer.id]
                    const released = !!state?.presentedAt
                    const busy = releasingOfferId === offer.id
                    return (
                      <div className="mx-1 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
                        {released ? (
                          <span className="flex items-center gap-1.5 text-xs font-medium text-green-800">
                            <Eye className="h-3.5 w-3.5" />
                            Visible to your seller since{" "}
                            {new Date(state!.presentedAt as string).toLocaleDateString()}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                            <EyeOff className="h-3.5 w-3.5" />
                            Not released — your seller cannot see this offer
                          </span>
                        )}
                        {state?.note && (
                          <span className="text-xs text-muted-foreground italic">&ldquo;{state.note}&rdquo;</span>
                        )}
                        <Button
                          size="sm"
                          variant={released ? "ghost" : "default"}
                          className="h-7 text-xs ml-auto"
                          disabled={busy || isPending || !!presentationError}
                          onClick={() => (released ? handleUnrelease(offer.id) : handleRelease(offer.id))}
                        >
                          {busy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : released ? (
                            "Hide from seller"
                          ) : (
                            "Release to seller portal"
                          )}
                        </Button>
                      </div>
                    )
                  })()}

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
                            ? { ...o, status: "accepted", is_winning_offer: true }
                            : { ...o, is_winning_offer: false }
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
                            {canOverrideDecisionGate && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs h-7"
                                onClick={() => setShowOverrideInput((v) => !v)}
                              >
                                Override & Accept Anyway
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7"
                              onClick={() => { setEvalOfferId(null); setDecisionEval(null); setShowOverrideInput(false) }}
                            >
                              Cancel
                            </Button>
                          </div>
                          {!canOverrideDecisionGate && (
                            <p className="text-xs text-amber-800 pt-1 border-t border-amber-200">
                              Only a broker, brokerage owner or admin may override these checks — ask one of them to review.
                            </p>
                          )}
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

              {/* Negotiation Co-Pilot — strategy + comparables + draft response.
                  counterAdvisor shape: { strategy, comparables, draftResponse,
                  offerSnapshot } from negotiationCoPilot(). */}
              {counterAdvisor && (
                <div className="rounded-lg border border-purple-200 bg-purple-50 p-4 space-y-3">
                  <p className="text-sm font-semibold text-purple-900">
                    🧠 Negotiation Co-Pilot
                    {counterAdvisor.offerSnapshot && (
                      <span className="ml-2 text-[11px] font-normal text-purple-700">
                        offer ${Number(counterAdvisor.offerSnapshot.offerPrice).toLocaleString()} ·{" "}
                        list ${Number(counterAdvisor.offerSnapshot.listPrice).toLocaleString()} ·{" "}
                        {Math.round(counterAdvisor.offerSnapshot.gapPct)}% gap
                      </span>
                    )}
                  </p>

                  {/* Strategy */}
                  {counterAdvisor.strategy && (
                    <div className="rounded-md bg-white border border-purple-100 p-3 space-y-1">
                      {counterAdvisor.strategy.recommendedResponse && (
                        <p className="text-sm font-medium">
                          Recommendation:{" "}
                          <span className="capitalize text-purple-900">
                            {counterAdvisor.strategy.recommendedResponse}
                          </span>
                        </p>
                      )}
                      {counterAdvisor.strategy.suggestedCounterPrice != null && (
                        <p className="text-sm">
                          Suggested counter:{" "}
                          <strong>${Number(counterAdvisor.strategy.suggestedCounterPrice).toLocaleString()}</strong>
                          {counterAdvisor.strategy.estimatedFinalPrice != null && (
                            <span className="text-xs text-muted-foreground ml-2">
                              (est. final ${Number(counterAdvisor.strategy.estimatedFinalPrice).toLocaleString()})
                            </span>
                          )}
                        </p>
                      )}
                      {counterAdvisor.strategy.reasoning && (
                        <p className="text-xs text-muted-foreground">{counterAdvisor.strategy.reasoning}</p>
                      )}
                      {counterAdvisor.strategy.riskOfLosingDeal != null && (
                        <p className="text-xs">
                          Risk of losing deal:{" "}
                          <span className={
                            counterAdvisor.strategy.riskOfLosingDeal >= 60 ? "text-red-700 font-medium" :
                            counterAdvisor.strategy.riskOfLosingDeal >= 30 ? "text-amber-700" : "text-emerald-700"
                          }>
                            {counterAdvisor.strategy.riskOfLosingDeal}%
                          </span>
                        </p>
                      )}
                      {Array.isArray(counterAdvisor.strategy.negotiationTactics) && counterAdvisor.strategy.negotiationTactics.length > 0 && (
                        <ul className="text-xs text-muted-foreground list-disc pl-4 mt-1">
                          {counterAdvisor.strategy.negotiationTactics.slice(0, 3).map((t: string, i: number) => (
                            <li key={i}>{t}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* Comparables */}
                  {counterAdvisor.comparables && counterAdvisor.comparables.count > 0 && (
                    <div className="rounded-md bg-white border border-purple-100 p-3">
                      <p className="text-xs font-semibold text-purple-900 mb-1">
                        📊 Comparable sales · {counterAdvisor.comparables.count} nearby
                      </p>
                      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                        {counterAdvisor.comparables.medianSoldPrice != null && (
                          <span>Median sold: <strong className="text-foreground">${counterAdvisor.comparables.medianSoldPrice.toLocaleString()}</strong></span>
                        )}
                        {counterAdvisor.comparables.avgDom != null && (
                          <span>Avg DOM: <strong className="text-foreground">{counterAdvisor.comparables.avgDom}</strong></span>
                        )}
                        {counterAdvisor.comparables.pricePerSqft != null && (
                          <span>$/sqft: <strong className="text-foreground">${counterAdvisor.comparables.pricePerSqft}</strong></span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1.5">{counterAdvisor.comparables.insight}</p>
                    </div>
                  )}

                  {/* Draft response — pre-written in agent voice */}
                  {counterAdvisor.draftResponse?.body && (
                    <div className="rounded-md bg-white border border-purple-100 p-3 space-y-1.5">
                      <p className="text-xs font-semibold text-purple-900">
                        ✍️ Draft response to buyer&apos;s agent
                      </p>
                      {counterAdvisor.draftResponse.subject && (
                        <p className="text-xs"><span className="text-muted-foreground">Subject:</span> {counterAdvisor.draftResponse.subject}</p>
                      )}
                      <textarea
                        readOnly
                        value={counterAdvisor.draftResponse.body}
                        rows={4}
                        className="w-full text-xs border border-input rounded-md px-2 py-1.5 bg-muted/30 resize-none"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => {
                          navigator.clipboard?.writeText(counterAdvisor.draftResponse?.body ?? "")
                        }}
                      >
                        Copy
                      </Button>
                    </div>
                  )}

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCounterAdvisor(null)}
                    className="text-xs text-purple-600 hover:underline px-0 h-auto"
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

// ── Counter payload for the diff ──────────────────────────────────────────────
//
// buildCounterOfferDiff compares EXACTLY these eight keys against the original
// offer row, and treats an UNDEFINED key as "unchanged". So a column the counter
// never set must be omitted, not passed as null — passing null would render as
// "Price 450,000 → —" and read as a concession the buyer never made.
function counterPayloadOf(counter: Offer): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  const put = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) payload[key] = value
  }
  put("offer_price", counter.offer_price)
  put("earnest_money", counter.earnest_money)
  put("closing_date", counter.closing_date)
  put("closing_cost_contribution", counter.closing_cost_contribution)
  put("down_payment_percent", counter.down_payment_percent)
  put("financing_type", counter.financing_type)
  put("contingencies", counter.contingencies)
  put("escalation_cap", counter.escalation_cap)
  return payload
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
