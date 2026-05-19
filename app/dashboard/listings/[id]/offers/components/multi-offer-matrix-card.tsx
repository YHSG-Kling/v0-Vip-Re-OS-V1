/**
 * MultiOfferMatrixCard — server component that renders the AI multi-offer
 * comparison matrix above the existing OffersManagerClient.
 *
 * Renders as null when fewer than 2 active offers exist on the listing.
 * Calls lib/workflow/intelligence/multi-offer-matrix.buildMultiOfferMatrix.
 *
 * PURELY ADDITIVE — does not modify OffersManagerClient or its data flow.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Sparkles, TrendingUp, Shield, DollarSign } from "lucide-react"
import { buildMultiOfferMatrix } from "@/lib/workflow/intelligence/multi-offer-matrix"

interface Props {
  listingId: string
  /** Number of active (pending|submitted|countered) offers on the listing.
   *  When < 2, the card renders null (matrix only useful with multiples). */
  activeOfferCount: number
}

const STRENGTH_BADGE_CLASS = {
  weak:        "bg-slate-100 text-slate-700",
  moderate:    "bg-blue-100 text-blue-700",
  strong:      "bg-emerald-100 text-emerald-700",
  very_strong: "bg-emerald-200 text-emerald-800",
}

export default async function MultiOfferMatrixCard({ listingId, activeOfferCount }: Props) {
  if (activeOfferCount < 2) return null

  let matrix
  try {
    matrix = await buildMultiOfferMatrix({ listingId })
  } catch {
    return null    // matrix build best-effort; never break the offers page
  }

  if (!matrix || matrix.offers.length < 2) return null

  return (
    <Card className="border-violet-200 bg-violet-50/30 dark:bg-violet-950/10 mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-violet-600" />
          Multi-Offer Comparison
          <Badge variant="outline" className="ml-1">{matrix.offers.length} offers</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Top offer callouts */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <TopOfferCallout
            icon={<DollarSign className="h-4 w-4" />}
            label="Highest price"
            offerId={matrix.topOffer.byPrice}
            offers={matrix.offers}
            valueRender={o => `$${o.offerPrice.toLocaleString()}`}
          />
          <TopOfferCallout
            icon={<TrendingUp className="h-4 w-4" />}
            label="Best net to seller"
            offerId={matrix.topOffer.byNet}
            offers={matrix.offers}
            valueRender={o => `$${Math.round(o.netToSeller).toLocaleString()}`}
            highlight
          />
          <TopOfferCallout
            icon={<Shield className="h-4 w-4" />}
            label="Most likely to close"
            offerId={matrix.topOffer.byCertainty}
            offers={matrix.offers}
            valueRender={o => o.buyerStrengthLabel.replace("_", " ")}
          />
        </div>

        {/* Matrix table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b">
              <tr>
                <th className="text-left py-2 font-medium">Buyer</th>
                <th className="text-right py-2 font-medium">Price</th>
                <th className="text-right py-2 font-medium">Net to seller</th>
                <th className="text-right py-2 font-medium">Strength</th>
                <th className="text-right py-2 font-medium">Financing</th>
                <th className="text-right py-2 font-medium">Close</th>
                <th className="text-right py-2 font-medium">Contingencies</th>
                <th className="text-right py-2 font-medium">Escalation</th>
              </tr>
            </thead>
            <tbody>
              {matrix.offers.map(o => (
                <tr key={o.offerId} className="border-b last:border-0">
                  <td className="py-2.5 font-medium">{o.buyerName ?? "Buyer"}</td>
                  <td className="text-right">${o.offerPrice.toLocaleString()}</td>
                  <td className="text-right font-semibold text-emerald-700 dark:text-emerald-400">
                    ${Math.round(o.netToSeller).toLocaleString()}
                  </td>
                  <td className="text-right">
                    <Badge className={STRENGTH_BADGE_CLASS[o.buyerStrengthLabel] ?? "bg-slate-100"}>
                      {o.buyerStrengthLabel.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="text-right capitalize text-muted-foreground">{o.financingType ?? "—"}</td>
                  <td className="text-right text-muted-foreground">
                    {o.closeDateDays != null ? `${o.closeDateDays}d` : "—"}
                  </td>
                  <td className="text-right text-muted-foreground">{o.contingencies.length}</td>
                  <td className="text-right text-muted-foreground">
                    {o.escalationCap ? `up to $${o.escalationCap.toLocaleString()}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* AI seller-decision summary */}
        {matrix.aiSummary && (
          <div className="rounded-lg border border-violet-200 bg-white dark:bg-slate-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-400 mb-2">
              AI take for your seller
            </p>
            <div className="text-sm text-slate-700 dark:text-slate-300 space-y-2 whitespace-pre-wrap">
              {matrix.aiSummary}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function TopOfferCallout({
  icon, label, offerId, offers, valueRender, highlight,
}: {
  icon:        React.ReactNode
  label:       string
  offerId:     string
  offers:      Awaited<ReturnType<typeof buildMultiOfferMatrix>>["offers"]
  valueRender: (o: Awaited<ReturnType<typeof buildMultiOfferMatrix>>["offers"][number]) => string
  highlight?:  boolean
}) {
  const offer = offers.find(o => o.offerId === offerId)
  if (!offer) return null

  return (
    <div className={`rounded-lg border p-3 ${
      highlight
        ? "border-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/20"
        : "border-slate-200 bg-white dark:bg-slate-900"
    }`}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="text-sm font-semibold mt-1 truncate">{offer.buyerName ?? "Buyer"}</p>
      <p className={`text-base font-bold mt-0.5 capitalize ${highlight ? "text-emerald-700 dark:text-emerald-400" : ""}`}>
        {valueRender(offer)}
      </p>
    </div>
  )
}
