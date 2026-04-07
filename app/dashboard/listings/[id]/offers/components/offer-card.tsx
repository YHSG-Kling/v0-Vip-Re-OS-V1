"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { FileText, CheckCircle, XCircle, MessageSquare, Loader2, Trophy } from "lucide-react"
import { cn } from "@/lib/utils"
import { SignatureStatusBadge } from "@/app/components/shared/SignatureStatusBadge"

interface Offer {
  id: string
  offer_number: string | null
  offer_price: number
  earnest_money: number | null
  closing_date: string | null
  financing_type: string | null
  down_payment_percent: number | null
  appraisal_contingency_days: number | null
  financing_contingency_days: number | null
  inspection_period_days: number | null
  escalation_clause: boolean | null
  escalation_cap: number | null
  closing_cost_contribution: number | null
  seller_net_estimate: number | null
  ai_recommendation: string | null
  ai_extraction_status: string | null
  offer_document_url: string | null
  offer_document_name: string | null
  status: string | null
  offer_type: string | null
  current_round: number | null
  is_winning_offer: boolean | null
  submitted_at: string | null
  contingencies: string[] | null
  possession_terms: string | null
  esign_status?: string | null
  esign_provider?: string | null
  esign_sent_at?: string | null
  esign_completed_at?: string | null
  buyer_signed_at?: string | null
}

interface Props {
  offer: Offer
  listPrice: number
  canApprove: boolean
  isPending: boolean
  onAccept: () => void
  onReject: () => void
  onCounter: () => void
}

const statusColors: Record<string, string> = {
  submitted: "bg-blue-500/10 text-blue-600 border-blue-200",
  accepted:  "bg-green-500/10 text-green-600 border-green-200",
  countered: "bg-amber-500/10 text-amber-600 border-amber-200",
  rejected:  "bg-red-500/10 text-red-600 border-red-200",
}

function fmt(n: number | null) {
  return n != null ? `$${n.toLocaleString()}` : "—"
}

export function OfferCard({ offer, listPrice, canApprove, isPending, onAccept, onReject, onCounter }: Props) {
  const priceDiff = listPrice > 0 ? ((offer.offer_price - listPrice) / listPrice) * 100 : 0
  const isWinner = offer.is_winning_offer || offer.winning_offer
  const extracting = offer.ai_extraction_status === "processing" || offer.ai_extraction_status === "pending"

  return (
    <Card className={cn("relative", isWinner && "ring-2 ring-green-500")}>
      {isWinner && (
        <div className="absolute -top-3 left-4 flex items-center gap-1 bg-green-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full">
          <Trophy className="h-3 w-3" />
          Winning Offer
        </div>
      )}
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
              {offer.offer_type === "counter" ? `Counter Offer · Round ${offer.current_round}` : `Offer ${offer.offer_number ?? ""}`}
            </p>
            <p className="text-2xl font-semibold text-foreground mt-0.5">
              {fmt(offer.offer_price)}
            </p>
            <p className={cn("text-xs font-medium mt-0.5", priceDiff >= 0 ? "text-green-600" : "text-red-500")}>
              {priceDiff >= 0 ? "+" : ""}{priceDiff.toFixed(1)}% vs list price
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Badge className={cn("border text-xs", statusColors[offer.status ?? "submitted"] ?? "")}>
              {offer.status ?? "submitted"}
            </Badge>
            {extracting && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Extracting terms...
              </span>
            )}
            {(offer.esign_status || offer.esign_sent_at) && (
              <SignatureStatusBadge
                esignStatus={offer.esign_status}
                esignProvider={offer.esign_provider}
                esignSentAt={offer.esign_sent_at}
                esignCompletedAt={offer.esign_completed_at}
                buyerSignedAt={offer.buyer_signed_at}
                compact
              />
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Earnest Money</p>
            <p className="font-medium">{fmt(offer.earnest_money ?? offer.earnest_money)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Closing Date</p>
            <p className="font-medium">
              {offer.closing_date ? new Date(offer.closing_date).toLocaleDateString() : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Financing</p>
            <p className="font-medium capitalize">{offer.financing_type ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Down Payment</p>
            <p className="font-medium">
              {offer.down_payment_percent != null ? `${offer.down_payment_percent}%` : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Inspection Period</p>
            <p className="font-medium">
              {offer.inspection_period_days != null ? `${offer.inspection_period_days} days` : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Financing Contingency</p>
            <p className="font-medium">
              {offer.financing_contingency_days != null ? `${offer.financing_contingency_days} days` : "None"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Appraisal Contingency</p>
            <p className="font-medium">
              {offer.appraisal_contingency_days != null ? `${offer.appraisal_contingency_days} days` : "None"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Escalation Clause</p>
            <p className="font-medium">
              {offer.escalation_clause
                ? `Yes (cap ${fmt(offer.escalation_cap)})`
                : "No"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Seller Concessions</p>
            <p className="font-medium">{fmt(offer.closing_cost_contribution)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Net to Seller</p>
            <p className="font-semibold text-foreground">{fmt(offer.seller_net_estimate)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Possession</p>
            <p className="font-medium">{offer.possession_terms ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Contingencies</p>
            <p className="font-medium">{(offer.contingencies ?? []).join(", ") || "None"}</p>
          </div>
        </div>

        {offer.ai_recommendation && (
          <>
            <Separator className="my-3" />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
              AI Notes
            </p>
            <p className="text-sm text-foreground/80">{offer.ai_recommendation}</p>
          </>
        )}

        {offer.offer_document_url && (
          <>
            <Separator className="my-3" />
            <a
              href={offer.offer_document_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <FileText className="h-3.5 w-3.5" />
              {offer.offer_document_name ?? "View Offer PDF"}
            </a>
          </>
        )}

        {/* Actions */}
        {offer.status !== "accepted" && offer.status !== "rejected" && (
          <>
            <Separator className="my-3" />
            <div className="flex items-center gap-2">
              {canApprove && (
                <Button
                  size="sm"
                  onClick={onAccept}
                  disabled={isPending}
                  className="bg-green-600 hover:bg-green-700 text-white"
                >
                  <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
                  Accept
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={onCounter} disabled={isPending}>
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                Counter
              </Button>
              {canApprove && (
                <Button size="sm" variant="outline" onClick={onReject} disabled={isPending}
                  className="text-destructive hover:text-destructive border-destructive/40 hover:border-destructive">
                  <XCircle className="mr-1.5 h-3.5 w-3.5" />
                  Reject
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
