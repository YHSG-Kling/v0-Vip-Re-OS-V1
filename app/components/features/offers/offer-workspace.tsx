"use client"

/**
 * app/components/features/offers/offer-workspace.tsx
 *
 * Full offer detail workspace — shown on the offer detail page.
 * Accepts pre-loaded server data; all mutations go through kernel actions.
 * Renders: summary header, net sheet, AI analysis, document panel, counter history.
 */

import { useState, useTransition } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { CounterOfferHistory } from "./counteroffer-history"
import { NetSheetView }        from "./net-sheet-view"
import { OfferDocumentPanel }  from "./offer-document-panel"
import type { OfferRow }       from "@/lib/kernel/offers"

// ─── Local helpers ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  draft:     "bg-muted text-muted-foreground border-border",
  pending:   "bg-amber-50 text-amber-700 border-amber-200",
  submitted: "bg-blue-50 text-blue-700 border-blue-200",
  sent:      "bg-blue-50 text-blue-700 border-blue-200",
  countered: "bg-purple-50 text-purple-700 border-purple-200",
  accepted:  "bg-green-50 text-green-700 border-green-200",
  rejected:  "bg-red-50 text-red-700 border-red-200",
  withdrawn: "bg-muted text-muted-foreground border-border",
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize",
      STATUS_COLORS[status] ?? "bg-muted text-muted-foreground border-border"
    )}>
      {status}
    </span>
  )
}

function fmt(n: number | null | undefined) {
  if (n == null) return "—"
  return `$${Number(n).toLocaleString()}`
}

function fmtDate(d: string | null | undefined) {
  if (!d) return "—"
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface OfferWorkspaceProps {
  offer:    OfferRow
  listing:  { id: string; address: string; list_price: number; seller_contact_id: string | null } | null
  contact:  { id: string; first_name: string; last_name: string; email: string | null; phone: string | null } | null
  history:  OfferRow[]
  agentId:  string
  brokerageId: string
  buyerPath: string   // e.g. /dashboard/buyers/{id}
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OfferWorkspace({
  offer,
  listing,
  contact,
  history,
  agentId,
  brokerageId,
  buyerPath,
}: OfferWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<"details" | "net-sheet" | "history" | "documents">("details")
  const [isPending, startTrans]   = useTransition()
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)

  const isFinal = ["accepted", "rejected", "withdrawn"].includes(offer.status)

  async function handleAccept() {
    setActionMsg(null)
    setActionErr(null)
    startTrans(async () => {
      const { acceptOffer } = await import("@/lib/kernel/offers")
      const res = await acceptOffer({ offerId: offer.id, agentId, brokerageId })
      if (res.success) {
        setActionMsg("Offer accepted. All other pending offers have been rejected.")
        window.location.reload()
      } else {
        setActionErr(res.error ?? "Failed to accept offer")
      }
    })
  }

  async function handleReject(reason?: string) {
    setActionMsg(null)
    setActionErr(null)
    startTrans(async () => {
      const { rejectOffer } = await import("@/lib/kernel/offers")
      const res = await rejectOffer({ offerId: offer.id, agentId, brokerageId, reason })
      if (res.success) {
        setActionMsg("Offer rejected.")
        window.location.reload()
      } else {
        setActionErr(res.error ?? "Failed to reject offer")
      }
    })
  }

  async function handleWithdraw() {
    setActionMsg(null)
    setActionErr(null)
    startTrans(async () => {
      const { withdrawOffer } = await import("@/lib/kernel/offers")
      const res = await withdrawOffer({ offerId: offer.id, agentId, brokerageId })
      if (res.success) {
        setActionMsg("Offer withdrawn.")
        window.location.reload()
      } else {
        setActionErr(res.error ?? "Failed to withdraw offer")
      }
    })
  }

  const tabs = [
    { id: "details",   label: "Details" },
    { id: "net-sheet", label: "Net Sheet" },
    { id: "history",   label: `History (${history.length})` },
    { id: "documents", label: "Documents" },
  ] as const

  return (
    <div className="flex flex-col h-full bg-background">

      {/* ── Header ── */}
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <Link href={buyerPath} className="hover:text-foreground transition-colors">
            {contact ? `${contact.first_name} ${contact.last_name}` : "Buyer"}
          </Link>
          <span>/</span>
          <Link href={`${buyerPath}/offers`} className="hover:text-foreground transition-colors">Offers</Link>
          <span>/</span>
          <span className="text-foreground">{offer.offer_number ?? offer.id.slice(0, 8)}</span>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-base font-semibold text-balance">
                {offer.property_address ?? listing?.address ?? "Unknown Property"}
              </h1>
              <StatusBadge status={offer.status} />
            </div>
            <p className="text-xl font-bold text-foreground">{fmt(offer.offer_price)}</p>
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              {offer.financing_type && <span className="uppercase">{offer.financing_type}</span>}
              {offer.closing_date && <span>Closes {fmtDate(offer.closing_date)}</span>}
              {offer.submitted_at && <span>Submitted {fmtDate(offer.submitted_at)}</span>}
              {listing && (
                <Link
                  href={`/dashboard/listings/${listing.id}`}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  View Listing
                </Link>
              )}
            </div>
          </div>

          {/* Action buttons — only for non-final offers */}
          {!isFinal && (
            <div className="flex flex-col gap-1.5 flex-shrink-0">
              <button
                onClick={handleAccept}
                disabled={isPending}
                className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                Accept
              </button>
              <button
                onClick={() => handleReject()}
                disabled={isPending}
                className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
              >
                Reject
              </button>
              <button
                onClick={handleWithdraw}
                disabled={isPending}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 disabled:opacity-50 transition-colors"
              >
                Withdraw
              </button>
            </div>
          )}
        </div>

        {actionMsg && (
          <div className="mt-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
            {actionMsg}
          </div>
        )}
        {actionErr && (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {actionErr}
          </div>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="border-b border-border px-6">
        <div className="flex gap-0 -mb-px">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
                activeTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab content ── */}
      <div className="flex-1 overflow-y-auto">

        {activeTab === "details" && (
          <div className="px-6 py-5 grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Offer Terms */}
            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Offer Terms</h2>
              <dl className="space-y-2">
                {[
                  ["Offer Price",        fmt(offer.offer_price)],
                  ["Earnest Money",      fmt(offer.earnest_money)],
                  ["Down Payment",       offer.down_payment_percent != null ? `${offer.down_payment_percent}%` : "—"],
                  ["Financing",          offer.financing_type ?? "—"],
                  ["Closing Date",       fmtDate(offer.closing_date)],
                  ["Possession",         offer.possession_terms ?? "—"],
                  ["Closing Concessions", fmt(offer.closing_cost_contribution)],
                  ["Due Diligence Fee",  fmt(offer.due_diligence_fee)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-4 py-1.5 border-b border-border/50">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="text-sm font-medium text-right">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {/* Contingencies & E-sign */}
            <div className="space-y-5">
              <section className="space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contingencies</h2>
                {offer.contingencies && offer.contingencies.length > 0 ? (
                  <ul className="space-y-1">
                    {offer.contingencies.map((c, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm">
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground flex-shrink-0" />
                        {c}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No contingencies</p>
                )}
              </section>

              <section className="space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contingency Periods</h2>
                <dl className="space-y-2">
                  {[
                    ["Inspection",  offer.inspection_period_days ? `${offer.inspection_period_days} days` : "—"],
                    ["Financing",   offer.financing_contingency_days ? `${offer.financing_contingency_days} days` : "—"],
                    ["Appraisal",   offer.appraisal_contingency_days ? `${offer.appraisal_contingency_days} days` : "—"],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-baseline justify-between gap-4 py-1.5 border-b border-border/50">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="text-sm font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              {offer.escalation_clause && (
                <section className="space-y-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Escalation</h2>
                  <dl className="space-y-2">
                    {[
                      ["Escalation Cap",   fmt(offer.escalation_cap)],
                      ["Appraisal Gap",    fmt(offer.appraisal_gap)],
                    ].map(([label, value]) => (
                      <div key={label} className="flex items-baseline justify-between gap-4 py-1.5 border-b border-border/50">
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="text-sm font-medium">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              {/* E-sign status */}
              {offer.esign_status && (
                <section className="space-y-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">E-sign</h2>
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Status</span>
                      <span className="font-medium capitalize">{offer.esign_status}</span>
                    </div>
                    {offer.esign_provider && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Provider</span>
                        <span className="font-medium capitalize">{offer.esign_provider}</span>
                      </div>
                    )}
                    {offer.esign_sent_at && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Sent</span>
                        <span className="font-medium">{fmtDate(offer.esign_sent_at)}</span>
                      </div>
                    )}
                    {offer.esign_completed_at && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Completed</span>
                        <span className="font-medium">{fmtDate(offer.esign_completed_at)}</span>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>

            {/* AI Recommendation */}
            {offer.ai_recommendation && (
              <section className="md:col-span-2 space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">AI Analysis</h2>
                <div className="rounded-lg border border-border bg-muted/20 p-4">
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{offer.ai_recommendation}</p>
                </div>
              </section>
            )}

            {/* Notes */}
            {(offer.notes || offer.buyer_notes) && (
              <section className="md:col-span-2 space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</h2>
                <div className="rounded-lg border border-border bg-muted/20 p-4">
                  <p className="text-sm leading-relaxed">{offer.notes ?? offer.buyer_notes}</p>
                </div>
              </section>
            )}
          </div>
        )}

        {activeTab === "net-sheet" && (
          <div className="px-6 py-5">
            <NetSheetView
              offerPrice={offer.offer_price}
              listPrice={listing?.list_price ?? null}
              closingCostContribution={offer.closing_cost_contribution ?? null}
              earnestMoney={offer.earnest_money ?? null}
              sellerNetEstimate={offer.seller_net_estimate ?? null}
            />
          </div>
        )}

        {activeTab === "history" && (
          <div className="px-6 py-5">
            <CounterOfferHistory history={history} currentOfferId={offer.id} />
          </div>
        )}

        {activeTab === "documents" && (
          <div className="px-6 py-5">
            <OfferDocumentPanel
              offerId={offer.id}
              documentUrl={offer.offer_document_url}
              documentName={offer.offer_document_name}
              aiExtractionStatus={offer.ai_extraction_status}
            />
          </div>
        )}
      </div>
    </div>
  )
}
