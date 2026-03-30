"use client"

import { useState, useTransition, useEffect } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { OfferInitiationFlow } from "./components/offer-initiation-flow"
import { recordOfferOutcome, getConnectedEsignProvider } from "@/app/actions/buyer-offers"
import { getMlsNumberByAddress } from "@/app/actions/seller-offers"
import { predictWinningOffer, aiNegotiationAdvisor } from "@/app/actions/ai-predictions"
import { SendForSignaturesPanel } from "@/app/components/shared/SendForSignaturesPanel"
import { Loader2, Target, TrendingUp, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"

const STATUS_BADGES: Record<string, string> = {
  draft:     "bg-muted border-border text-muted-foreground",
  sent:      "bg-blue-50 border-blue-200 text-blue-700",
  submitted: "bg-amber-50 border-amber-200 text-amber-700",
  accepted:  "bg-green-50 border-green-200 text-green-700",
  rejected:  "bg-red-50 border-red-200 text-red-700",
  countered: "bg-purple-50 border-purple-200 text-purple-700",
}


interface Offer {
  id: string
  property_address: string
  offer_price: number
  status: string
  esign_status: string
  esign_sent_at: string | null
  esign_completed_at?: string | null
  buyer_signed_at?: string | null
  form_source: string
  esign_provider: string | null
  strategy_recommendation_id: string | null
  created_at: string
  submitted_at: string | null
  closing_date: string | null
  financing_type: string | null
  earnest_money: number | null
  contingencies: string[] | null
  listing_id?: string | null
}

interface OutcomeForm {
  result:     "accepted" | "rejected" | "countered" | "withdrawn"
  finalPrice: string
  notes:      string
}

interface OffersClientProps {
  contactId:    string
  brokerageId:  string
  agentUserId:  string
  contactName:  string
  contactEmail: string
  initialOffers: Offer[]
  buyerStage:   string
}

export function OffersClient({
  contactId, brokerageId, agentUserId, contactName, contactEmail,
  initialOffers, buyerStage,
}: OffersClientProps) {
  const [offers, setOffers]               = useState<Offer[]>(initialOffers)
  const [showFlow, setShowFlow]           = useState(false)
  const [outcomeOffer, setOutcomeOffer]   = useState<Offer | null>(null)
  const [outcomeForm, setOutcomeForm]     = useState<OutcomeForm>({ result: "rejected", finalPrice: "", notes: "" })
  const [outcomeError, setOutcomeError]   = useState<string | null>(null)
  const [isPending, startTrans]           = useTransition()

  // Connected e-sign provider (resolved once from platform_credentials)
  const [connectedProvider, setConnectedProvider] = useState<{ platform: string; accountName: string | null } | null | undefined>(undefined)

  useEffect(() => {
    if (!brokerageId) { setConnectedProvider(null); return }
    getConnectedEsignProvider(brokerageId).then(setConnectedProvider)
  }, [brokerageId])

  // Per-offer AI panels — keyed by offer.id
  const [winStrategy, setWinStrategy]         = useState<Record<string, any>>({})
  const [winStrategyLoading, setWinStratLoading] = useState<Record<string, boolean>>({})
  const [counterAdvisor, setCounterAdvisor]   = useState<Record<string, any>>({})
  const [counterLoading, setCounterLoading]   = useState<Record<string, boolean>>({})

  function onCreateSuccess() {
    // Reload offers by triggering a soft re-fetch (we reload the page to get fresh server data)
    setShowFlow(false)
    window.location.reload()
  }

  // Predict the winning offer strategy for this property.
  // Buyers don't have listings — we look up the MLS number from property_alert_results
  // by matching contact + property address, then call predictWinningOffer with IDX data.
  async function handleWinStrategy(offer: Offer) {
    setWinStratLoading(prev => ({ ...prev, [offer.id]: true }))
    const mlsNumber = await getMlsNumberByAddress(contactId, offer.property_address ?? "")
    if (!mlsNumber) {
      setWinStrategy(prev => ({
        ...prev,
        [offer.id]: { error: "No MLS number found for this property. Save a property alert first or check the property address." },
      }))
      setWinStratLoading(prev => ({ ...prev, [offer.id]: false }))
      return
    }
    const result = await predictWinningOffer({
      propertyMlsId: mlsNumber,
      listPrice:     offer.offer_price,   // buyer's offer price as reference; IDX provides actual list price
      leadId:        contactId,
    })
    setWinStrategy(prev => ({ ...prev, [offer.id]: result }))
    setWinStratLoading(prev => ({ ...prev, [offer.id]: false }))
  }

  // Counter-offer negotiation advisor — shown when the seller has countered.
  // Uses the buyer's offer transaction via the strategy_recommendation_id link.
  async function handleCounterNegotiationAdvisor(offer: Offer) {
    setCounterLoading(prev => ({ ...prev, [offer.id]: true }))
    // For buyer-side, we look up the transaction linked to this offer via contact_id + offer price
    // The offer row has strategy_recommendation_id; for now use the offer's own data directly.
    // aiNegotiationAdvisor needs a transactionId — look up by contact_id + property
    const supabase = (await import("@/lib/supabase/client")).createClient()
    const { data: txn } = await (await supabase)
      .from("transactions")
      .select("id, contract_price")
      .eq("contact_id", contactId)
      .ilike("property_address", `%${(offer.property_address ?? "").split(",")[0]}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!txn) {
      setCounterAdvisor(prev => ({
        ...prev,
        [offer.id]: { error: "No linked transaction found. The seller may not have formally countered yet." },
      }))
      setCounterLoading(prev => ({ ...prev, [offer.id]: false }))
      return
    }
    const result = await aiNegotiationAdvisor({
      transactionId: txn.id,
      scenario:      "counteroffer",
      currentOffer:  offer.offer_price,
      listPrice:     Number(txn.contract_price ?? offer.offer_price),
    })
    setCounterAdvisor(prev => ({ ...prev, [offer.id]: result }))
    setCounterLoading(prev => ({ ...prev, [offer.id]: false }))
  }

  function openOutcomeModal(offer: Offer) {
    setOutcomeOffer(offer)
    setOutcomeForm({ result: "rejected", finalPrice: "", notes: "" })
    setOutcomeError(null)
  }

  function submitOutcome() {
    if (!outcomeOffer) return
    setOutcomeError(null)
    startTrans(async () => {
      const result = await recordOfferOutcome(
        outcomeOffer.id,
        outcomeOffer.strategy_recommendation_id,
        contactId,
        brokerageId,
        agentUserId,
        outcomeForm.result,
        outcomeForm.finalPrice ? Number(outcomeForm.finalPrice) : null,
        outcomeForm.notes
      )
      if (result.success) {
        setOutcomeOffer(null)
        setOffers(prev => prev.map(o => o.id === outcomeOffer.id
          ? { ...o, status: outcomeForm.result }
          : o
        ))
      } else {
        setOutcomeError(result.error ?? "Failed to record outcome")
      }
    })
  }

  if (showFlow) {
    return (
      <div className="h-full flex flex-col">
        <OfferInitiationFlow
          contactId={contactId}
          brokerageId={brokerageId}
          agentUserId={agentUserId}
          contactName={contactName}
          contactEmail={contactEmail}
          onSuccess={onCreateSuccess}
          onCancel={() => setShowFlow(false)}
        />
      </div>
    )
  }

  return (
    <>
      {/* Outcome modal */}
      {outcomeOffer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOutcomeOffer(null)} />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-card shadow-xl p-6 space-y-4">
            <h2 className="text-base font-semibold">Record Outcome</h2>
            <p className="text-xs text-muted-foreground">{outcomeOffer.property_address}</p>

            {outcomeError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {outcomeError}
              </div>
            )}

            <div className="space-y-3">
              <label className="block text-sm font-medium">Result</label>
              <div className="grid grid-cols-2 gap-2">
                {(["accepted","rejected","countered","withdrawn"] as const).map(r => (
                  <button
                    key={r}
                    onClick={() => setOutcomeForm(f => ({ ...f, result: r }))}
                    className={cn(
                      "rounded-md border px-3 py-2 text-sm font-medium capitalize transition-colors",
                      outcomeForm.result === r
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:bg-muted/50"
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {(outcomeForm.result === "accepted" || outcomeForm.result === "countered") && (
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">Final Price ($)</label>
                <input
                  type="number"
                  value={outcomeForm.finalPrice}
                  onChange={e => setOutcomeForm(f => ({ ...f, finalPrice: e.target.value }))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="0"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-sm font-medium">Notes</label>
              <textarea
                value={outcomeForm.notes}
                onChange={e => setOutcomeForm(f => ({ ...f, notes: e.target.value }))}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                placeholder="Optional notes..."
              />
            </div>

            <div className="flex gap-3 pt-1">
              <button
                onClick={submitOutcome}
                disabled={isPending}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {isPending ? "Saving..." : "Save Outcome"}
              </button>
              <button
                onClick={() => setOutcomeOffer(null)}
                className="flex-1 rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main offers list */}
      <div className="flex flex-col h-full overflow-y-auto">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Offers</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{offers.length} total</p>
          </div>
          <Link
            href={`/dashboard/buyers/${contactId}/offers/new`}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Create New Offer
          </Link>
        </div>

        {offers.length === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 gap-3 py-20">
            <div className="w-12 h-12 rounded-xl border border-border flex items-center justify-center">
              <svg className="w-6 h-6 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-sm font-medium">No offers yet</p>
            <p className="text-xs text-muted-foreground">Create an offer to get started</p>
            <button
              onClick={() => setShowFlow(true)}
              className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Create First Offer
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {offers.map(offer => (
              <div key={offer.id} className="px-6 py-4 hover:bg-muted/20 transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <p className="text-sm font-medium truncate">{offer.property_address || "Unknown address"}</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm text-muted-foreground">
                        ${Number(offer.offer_price).toLocaleString()}
                      </p>
                      <span className="text-muted-foreground/40">·</span>
                      <p className="text-xs text-muted-foreground">
                        {offer.submitted_at
                          ? new Date(offer.submitted_at).toLocaleDateString()
                          : new Date(offer.created_at).toLocaleDateString()}
                      </p>
                      {offer.financing_type && (
                        <>
                          <span className="text-muted-foreground/40">·</span>
                          <p className="text-xs text-muted-foreground uppercase">{offer.financing_type}</p>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                      <span className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
                        STATUS_BADGES[offer.status] ?? "bg-muted border-border text-muted-foreground"
                      )}>
                        {offer.status}
                      </span>
                      {offer.listing_id && (
                        <Badge className="bg-blue-100 text-blue-800 border-blue-200 text-xs font-normal">
                          Brokerage Listing
                        </Badge>
                      )}
                      {offer.listing_id && (
                        <Link
                          href={`/dashboard/listings/${offer.listing_id}`}
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                          View Listing
                        </Link>
                      )}
                    </div>

                    {/* Signature panel — hidden for fully rejected/withdrawn offers */}
                    {offer.status !== "rejected" && offer.status !== "withdrawn" && (
                      <SendForSignaturesPanel
                        offerId={offer.id}
                        userId={agentUserId}
                        connectedProvider={connectedProvider ?? null}
                        buyerName={contactName}
                        buyerEmail={contactEmail}
                        esignStatus={offer.esign_status}
                        esignProvider={offer.esign_provider}
                        esignSentAt={offer.esign_sent_at}
                        esignCompletedAt={offer.esign_completed_at}
                        buyerSignedAt={offer.buyer_signed_at}
                        onSent={() => setOffers(prev => prev.map(o => o.id === offer.id
                          ? { ...o, esign_status: "sent", esign_sent_at: new Date().toISOString() }
                          : o
                        ))}
                        className="mt-1"
                      />
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5 flex-shrink-0">
                    {/* Link to canonical offer detail page (/dashboard/buyers/[id]/offers/[offerId]) */}
                    <Link
                      href={`/dashboard/buyers/${contactId}/offers/${offer.id}`}
                      className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted/50 transition-colors text-center"
                    >
                      View Details
                    </Link>
                    {!["accepted","rejected","withdrawn"].includes(offer.status) && (
                      <button
                        onClick={() => openOutcomeModal(offer)}
                        className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted/50 transition-colors"
                      >
                        Record Outcome
                      </button>
                    )}
                    {offer.status !== "rejected" && offer.status !== "withdrawn" && (
                      <button
                        onClick={() => handleWinStrategy(offer)}
                        disabled={winStrategyLoading[offer.id]}
                        className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted/50 disabled:opacity-50 transition-colors flex items-center gap-1"
                      >
                        {winStrategyLoading[offer.id]
                          ? <><Loader2 className="h-3 w-3 animate-spin" />Analyzing...</>
                          : <><TrendingUp className="h-3 w-3" />Win Strategy</>}
                      </button>
                    )}
                    {offer.status === "countered" && (
                      <button
                        onClick={() => handleCounterNegotiationAdvisor(offer)}
                        disabled={counterLoading[offer.id]}
                        className="rounded-md border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50 transition-colors flex items-center gap-1"
                      >
                        {counterLoading[offer.id]
                          ? <><Loader2 className="h-3 w-3 animate-spin" />Advising...</>
                          : <><Target className="h-3 w-3" />Counter Advisor</>}
                      </button>
                    )}
                  </div>
                </div>

                {/* Win Strategy result */}
                {winStrategy[offer.id] && (
                  <div className="mt-3 rounded-lg border border-border bg-muted/20 px-3 py-3 space-y-2 text-xs">
                    <p className="font-medium flex items-center gap-1.5">
                      <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                      Win Strategy for {offer.property_address?.split(",")[0]}
                    </p>
                    {winStrategy[offer.id].error ? (
                      <p className="text-amber-700">{winStrategy[offer.id].error}</p>
                    ) : (
                      <>
                        {winStrategy[offer.id].winningOfferStrategy && (
                          <div className="space-y-1">
                            <div className="flex gap-4">
                              <span>Initial offer: <span className="font-medium">${(winStrategy[offer.id].winningOfferStrategy.initialOffer ?? 0).toLocaleString()}</span></span>
                              <span>Likely win: <span className="font-medium">${(winStrategy[offer.id].winningOfferStrategy.likelyWinningOffer ?? 0).toLocaleString()}</span></span>
                            </div>
                            <p className="text-muted-foreground">{winStrategy[offer.id].winningOfferStrategy.reasoning}</p>
                          </div>
                        )}
                        {winStrategy[offer.id].offerStructure?.escalationClause?.include && (
                          <p className="text-muted-foreground">
                            Recommend escalation clause up to ${(winStrategy[offer.id].offerStructure.escalationClause.maxEscalation ?? 0).toLocaleString()}, $
                            {winStrategy[offer.id].offerStructure.escalationClause.increment?.toLocaleString()} increments.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* Counter Advisor result */}
                {counterAdvisor[offer.id] && (
                  <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-3 space-y-2 text-xs">
                    <p className="font-medium flex items-center gap-1.5 text-primary">
                      <Target className="h-3.5 w-3.5" />
                      Counter-Offer Advice
                    </p>
                    {counterAdvisor[offer.id].error ? (
                      <p className="text-amber-700">{counterAdvisor[offer.id].error}</p>
                    ) : (
                      <>
                        {counterAdvisor[offer.id].recommendedOffer?.amount && (
                          <p>Recommended: <span className="font-semibold">${Number(counterAdvisor[offer.id].recommendedOffer.amount).toLocaleString()}</span></p>
                        )}
                        {counterAdvisor[offer.id].recommendedApproach && (
                          <p className="text-muted-foreground">{counterAdvisor[offer.id].recommendedApproach}</p>
                        )}
                        {(counterAdvisor[offer.id].negotiationTactics ?? []).slice(0, 2).map((t: any, i: number) => (
                          <p key={i} className="text-muted-foreground italic">{t.tactic}: {t.script}</p>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
