import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { NetSheetCalculator } from "@/components/portal/NetSheetCalculator"
import { analyzeMultipleOffers } from "@/app/actions/offer-management"
import { CheckCircle2, Clock } from "lucide-react"

export default async function OffersPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  let contact: any = null
  let listing: any = null
  let offers: any[] = []

  try {
    const { data } = await supabase.from("contacts").select("*, listings(*)").eq("id", contactId).single()
    contact = data
  } catch (e) {
    // Continue with null contact
  }

  if (!contact?.listings || contact.listings.length === 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-3xl font-bold">Offers</h2>
        <Card>
          <CardContent className="py-12 text-center">
            <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">No listing found</h3>
            <p className="text-muted-foreground">You need an active listing to receive offers</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  listing = contact.listings[0]

  try {
    const { data } = await supabase
      .from("offers")
      .select("*, buyer:contacts(*)")
      .eq("listing_id", listing.id)
      .in("status", ["pending", "submitted", "under_review", "countered"])
      .order("offer_amount", { ascending: false })

    if (data) {
      offers = data
    }
  } catch (e) {
    // Continue with empty offers array
  }

  if (!offers || offers.length === 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-3xl font-bold">Offers</h2>
        <Card>
          <CardContent className="py-12 text-center">
            <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">No offers yet</h3>
            <p className="text-muted-foreground">When you receive offers, they'll appear here</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Single offer view
  if (offers.length === 1) {
    const offer = offers[0]
    const contingencies =
      typeof offer.contingencies === "string" ? JSON.parse(offer.contingencies || "{}") : offer.contingencies || {}
    const priceVsList = ((offer.offer_amount - listing.price) / listing.price) * 100

    return (
      <div className="space-y-6">
        <h2 className="text-3xl font-bold">Your Offer</h2>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Offer Details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Offer from {offer.buyer?.name || offer.buyer?.first_name || "Buyer A"}</span>
                {offer.expires_at && (
                  <Badge variant="outline">
                    Expires in{" "}
                    {Math.max(0, Math.floor((new Date(offer.expires_at).getTime() - Date.now()) / (1000 * 60 * 60)))}h
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="text-4xl font-bold text-green-600 mb-1">
                  ${(offer.offer_amount || 0).toLocaleString()}
                </div>
                <div className="text-sm text-muted-foreground">
                  {priceVsList > 0
                    ? `${priceVsList.toFixed(1)}% above asking`
                    : `${Math.abs(priceVsList).toFixed(1)}% below asking`}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Financing</p>
                  <Badge>{offer.financing_type || "Conventional"}</Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Earnest Money</p>
                  <p className="font-semibold">${(offer.earnest_money || 0).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Down Payment</p>
                  <p className="font-semibold">{offer.down_payment_percent || 20}%</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Closing Date</p>
                  <p className="font-semibold">
                    {offer.close_date ? new Date(offer.close_date).toLocaleDateString() : "TBD"}
                  </p>
                </div>
              </div>

              <div>
                <p className="text-sm text-muted-foreground mb-2">Contingencies:</p>
                <div className="space-y-2">
                  {contingencies.inspection && (
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-orange-600" />
                      <span className="text-sm">Inspection ({contingencies.inspectionDays || 10} days)</span>
                    </div>
                  )}
                  {contingencies.appraisal && (
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-orange-600" />
                      <span className="text-sm">Appraisal</span>
                    </div>
                  )}
                  {contingencies.financing && (
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-orange-600" />
                      <span className="text-sm">Financing ({contingencies.financingDays || 21} days)</span>
                    </div>
                  )}
                  {!contingencies.inspection && !contingencies.appraisal && !contingencies.financing && (
                    <p className="text-sm text-muted-foreground">No contingencies</p>
                  )}
                </div>
              </div>

              <div className="flex gap-2 pt-4">
                <Button className="flex-1">Accept Offer</Button>
                <Button variant="outline" className="flex-1 bg-transparent">
                  Counter
                </Button>
                <Button variant="ghost">Reject</Button>
              </div>
            </CardContent>
          </Card>

          {/* Net Sheet Calculator - Use offer_amount instead of offer_price */}
          <NetSheetCalculator
            offerPrice={offer.offer_amount || 0}
            listPrice={listing.price || 0}
            currentMortgageBalance={listing.mortgage_balance || 0}
            propertyAddress={listing.address || ""}
          />
        </div>
      </div>
    )
  }

  // Multiple offers view
  let analysis: any = { success: false }
  try {
    analysis = await analyzeMultipleOffers({ listingId: listing.id })
  } catch (e) {
    // Continue without AI analysis
  }

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold">Compare Offers ({offers.length})</h2>

      {/* AI Recommendation */}
      {analysis.success && analysis.analysis && (
        <Card className="border-blue-200 bg-blue-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="text-2xl">🤖</span>
              AI Analysis
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm">{analysis.analysis.comparison_summary}</p>
            {analysis.analysis.strengths && (
              <div>
                <p className="font-semibold text-sm mb-2">
                  Key Strengths of Offer {analysis.analysis.recommended_offer}:
                </p>
                <ul className="space-y-1">
                  {analysis.analysis.strengths.map((strength: string, i: number) => (
                    <li key={i} className="text-sm flex items-start gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5" />
                      {strength}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {analysis.analysis.concerns && analysis.analysis.concerns.length > 0 && (
              <div>
                <p className="font-semibold text-sm mb-2">Potential Concerns:</p>
                <ul className="space-y-1">
                  {analysis.analysis.concerns.map((concern: string, i: number) => (
                    <li key={i} className="text-sm flex items-start gap-2">
                      <span className="text-orange-600">⚠️</span>
                      {concern}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Comparison Table - Use offer_amount instead of offer_price */}
      <Card>
        <CardContent className="p-6 overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b">
                <th className="text-left py-3 font-semibold">Feature</th>
                {offers.map((offer, i) => (
                  <th key={offer.id} className="text-center py-3 font-semibold">
                    Offer {String.fromCharCode(65 + i)}
                  </th>
                ))}
                <th className="text-center py-3 font-semibold">Best</th>
              </tr>
            </thead>
            <tbody>
              {/* Offer Price */}
              <tr className="border-b">
                <td className="py-3">Offer Price</td>
                {offers.map((offer) => (
                  <td key={offer.id} className="text-center py-3">
                    ${(offer.offer_amount || 0).toLocaleString()}
                    {offer.offer_amount === Math.max(...offers.map((o: any) => o.offer_amount || 0)) && " ⭐"}
                  </td>
                ))}
                <td className="text-center py-3 font-semibold">
                  {String.fromCharCode(
                    65 +
                      offers.findIndex(
                        (o: any) => o.offer_amount === Math.max(...offers.map((o: any) => o.offer_amount || 0)),
                      ),
                  )}
                </td>
              </tr>
              {/* Financing */}
              <tr className="border-b">
                <td className="py-3">Financing</td>
                {offers.map((offer) => (
                  <td key={offer.id} className="text-center py-3">
                    {offer.financing_type || "Conventional"}
                    {offer.financing_type === "cash" && " ⭐"}
                  </td>
                ))}
                <td className="text-center py-3 font-semibold">
                  {offers.find((o: any) => o.financing_type === "cash")
                    ? String.fromCharCode(65 + offers.findIndex((o: any) => o.financing_type === "cash"))
                    : "-"}
                </td>
              </tr>
              {/* Earnest Money */}
              <tr className="border-b">
                <td className="py-3">Earnest Money</td>
                {offers.map((offer) => (
                  <td key={offer.id} className="text-center py-3">
                    ${(offer.earnest_money || 0).toLocaleString()}
                  </td>
                ))}
                <td className="text-center py-3 font-semibold">
                  {String.fromCharCode(
                    65 +
                      offers.findIndex(
                        (o: any) => o.earnest_money === Math.max(...offers.map((o: any) => o.earnest_money || 0)),
                      ),
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="flex gap-4">
        <Button>Request Highest & Best from All</Button>
        <Button variant="outline">Compare Selected</Button>
      </div>
    </div>
  )
}
