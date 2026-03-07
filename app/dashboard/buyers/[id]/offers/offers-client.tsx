"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { OfferInitiationFlow } from "./components/offer-initiation-flow"
import { recordOfferOutcome, sendOfferForESign } from "@/app/actions/buyer-offers"

const STATUS_BADGES: Record<string, string> = {
  draft:     "bg-muted border-border text-muted-foreground",
  sent:      "bg-blue-50 border-blue-200 text-blue-700",
  submitted: "bg-amber-50 border-amber-200 text-amber-700",
  accepted:  "bg-green-50 border-green-200 text-green-700",
  rejected:  "bg-red-50 border-red-200 text-red-700",
  countered: "bg-purple-50 border-purple-200 text-purple-700",
}

const ESIGN_BADGES: Record<string, string> = {
  pending:            "bg-muted border-border text-muted-foreground",
  sent:               "bg-blue-50 border-blue-200 text-blue-700",
  partially_signed:   "bg-amber-50 border-amber-200 text-amber-700",
  fully_signed:       "bg-green-50 border-green-200 text-green-700",
}

interface Offer {
  id: string
  property_address: string
  offer_price: number
  status: string
  esign_status: string
  esign_sent_at: string | null
  form_source: string
  esign_provider: string | null
  strategy_recommendation_id: string | null
  created_at: string
  submitted_at: string | null
  closing_date: string | null
  financing_type: string | null
  earnest_money: number | null
  contingencies: string[] | null
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

  function onCreateSuccess() {
    // Reload offers by triggering a soft re-fetch (we reload the page to get fresh server data)
    setShowFlow(false)
    window.location.reload()
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

  function resendESign(offer: Offer) {
    startTrans(async () => {
      await sendOfferForESign(offer.id, contactId, brokerageId, agentUserId)
      setOffers(prev => prev.map(o => o.id === offer.id
        ? { ...o, esign_status: "sent", esign_sent_at: new Date().toISOString() }
        : o
      ))
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
                      <span className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
                        ESIGN_BADGES[offer.esign_status] ?? "bg-muted border-border text-muted-foreground"
                      )}>
                        eSign: {offer.esign_status?.replace("_", " ")}
                      </span>
                      {offer.esign_provider && (
                        <span className="inline-flex items-center rounded-full border border-border bg-muted/30 px-2 py-0.5 text-xs text-muted-foreground capitalize">
                          {offer.esign_provider}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 flex-shrink-0">
                    {offer.esign_status !== "fully_signed" && offer.status !== "rejected" && (
                      <button
                        onClick={() => resendESign(offer)}
                        disabled={isPending}
                        className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted/50 disabled:opacity-50 transition-colors"
                      >
                        {offer.esign_sent_at ? "Resend eSign" : "Send eSign"}
                      </button>
                    )}
                    {!["accepted","rejected","withdrawn"].includes(offer.status) && (
                      <button
                        onClick={() => openOutcomeModal(offer)}
                        className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted/50 transition-colors"
                      >
                        Record Outcome
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
