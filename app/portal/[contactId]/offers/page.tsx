import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { determinePortalView } from "@/lib/kernel/portal"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs"
import { NetSheetCalculator } from "@/components/portal/NetSheetCalculator"
import { analyzeMultipleOffers } from "@/app/actions/offer-management"
import { CheckCircle2, Clock, FileText, ArrowLeft, PartyPopper, Filter, DollarSign, Calendar, Home } from "lucide-react"
import { cn } from "@/lib/utils"
import { SignatureStatusBadge } from "@/app/components/shared/SignatureStatusBadge"

// Buyer offer card component
function OfferCard({ offer, contactId }: { offer: any; contactId: string }) {
  const status = STATUS_CONFIG[offer.status] || STATUS_CONFIG.draft
  const address = offer.listing?.address || offer.listing?.property_address || "Property"
  const listPrice = offer.listing?.list_price

  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardContent className="p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <Home className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <h3 className="font-semibold">{address}</h3>
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <DollarSign className="h-3.5 w-3.5" />
                  {formatCurrency(offer.offer_price)}
                </span>
                {listPrice && offer.offer_price && (
                  <span className={cn(
                    offer.offer_price > listPrice ? "text-green-600" : "text-amber-600"
                  )}>
                    {offer.offer_price > listPrice ? "+" : ""}
                    {(((offer.offer_price - listPrice) / listPrice) * 100).toFixed(1)}% vs list
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  {new Date(offer.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </span>
              </div>
              {offer.expiration_date && new Date(offer.expiration_date) > new Date() && (
                <p className="text-xs text-amber-600">
                  Expires: {new Date(offer.expiration_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Badge variant="secondary" className={cn("shrink-0", status.color)}>
              {status.label}
            </Badge>
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
      </CardContent>
    </Card>
  )
}

// Status badge config
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "bg-gray-100 text-gray-700" },
  submitted: { label: "Submitted", color: "bg-blue-100 text-blue-800" },
  pending: { label: "Pending", color: "bg-amber-100 text-amber-800" },
  under_review: { label: "Under Review", color: "bg-purple-100 text-purple-800" },
  countered: { label: "Countered", color: "bg-purple-100 text-purple-800" },
  accepted: { label: "Accepted", color: "bg-green-100 text-green-800" },
  rejected: { label: "Rejected", color: "bg-red-100 text-red-800" },
  expired: { label: "Expired", color: "bg-slate-100 text-slate-600" },
  withdrawn: { label: "Withdrawn", color: "bg-slate-100 text-slate-600" },
}

function formatCurrency(amount: number | null): string {
  if (amount === null || amount === undefined) return "N/A"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount)
}

export default async function OffersPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Check portal view
  const portalView = await determinePortalView(supabase, contactId)

  // Get contact
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, name, contact_type")
    .eq("id", contactId)
    .single()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // BUYER VIEW: Show offers the buyer has submitted (using canonical offer_price)
  if (portalView === "buyer") {
    const { data: buyerOffers } = await supabase
      .from("offers")
      .select("id, listing_id, transaction_id, offer_price, status, created_at, expiration_date, esign_status, esign_provider, esign_sent_at, esign_completed_at, buyer_signed_at, listing:listings(id, address, property_address, list_price)")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })

    const offers = buyerOffers ?? []
    const acceptedOffer = offers.find((o) => o.status === "accepted")
    const activeOffers = offers.filter((o) => ["submitted", "pending", "under_review", "countered"].includes(o.status))
    const pastOffers = offers.filter((o) => ["accepted", "rejected", "expired", "withdrawn"].includes(o.status))

    return (
      <div className="space-y-6">
        {/* Header */}
        <div>
          <Button variant="ghost" size="sm" className="mb-2" asChild>
            <Link href={`/portal/${contactId}`}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Link>
          </Button>
          <h1 className="text-3xl font-bold">Your Offers</h1>
          <p className="text-muted-foreground mt-1">Track the status of offers you have submitted</p>
        </div>

        {/* Accepted Offer Banner */}
        {acceptedOffer && (
          <Card className="bg-green-50 border-green-200">
            <CardContent className="py-6">
              <div className="flex items-start gap-4">
                <PartyPopper className="h-8 w-8 text-green-600 shrink-0" />
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold text-green-800">
                    Congratulations! Your offer was accepted!
                  </h3>
                  <p className="text-green-700">
                    {acceptedOffer.listing?.address || acceptedOffer.listing?.property_address || "Property"} - {formatCurrency(acceptedOffer.offer_price)}
                  </p>
                  <Button className="bg-green-600 hover:bg-green-700" asChild>
                    <Link href={`/portal/${contactId}/journey`}>
                      View Your Transaction Journey
                    </Link>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tabs for filtering */}
        <Tabs defaultValue="all" className="space-y-4">
          <TabsList>
            <TabsTrigger value="all">All ({offers.length})</TabsTrigger>
            <TabsTrigger value="active">Active ({activeOffers.length})</TabsTrigger>
            <TabsTrigger value="past">Past ({pastOffers.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="all" className="space-y-3">
            {offers.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No offers yet</h3>
                  <p className="text-muted-foreground">
                    When you find a home and submit an offer, it will appear here
                  </p>
                </CardContent>
              </Card>
            ) : (
              offers.map((offer: any) => (
                <OfferCard key={offer.id} offer={offer} contactId={contactId} />
              ))
            )}
          </TabsContent>

          <TabsContent value="active" className="space-y-3">
            {activeOffers.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center">
                  <p className="text-muted-foreground">No active offers</p>
                </CardContent>
              </Card>
            ) : (
              activeOffers.map((offer: any) => (
                <OfferCard key={offer.id} offer={offer} contactId={contactId} />
              ))
            )}
          </TabsContent>

          <TabsContent value="past" className="space-y-3">
            {pastOffers.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center">
                  <p className="text-muted-foreground">No past offers</p>
                </CardContent>
              </Card>
            ) : (
              pastOffers.map((offer: any) => (
                <OfferCard key={offer.id} offer={offer} contactId={contactId} />
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>
    )
  }

  // SELLER VIEW: Original logic for receiving offers on listing
  let listing: any = null
  let offers: any[] = []

  const { data: contactWithListings } = await supabase
    .from("contacts")
    .select("*, listings(*)")
    .eq("id", contactId)
    .single()

  if (!contactWithListings?.listings || contactWithListings.listings.length === 0) {
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

  listing = contactWithListings.listings[0]

  const { data: sellerOffers } = await supabase
    .from("offers")
    .select("*, buyer:contacts(*)")
    .eq("listing_id", listing.id)
    .in("status", ["pending", "submitted", "under_review", "countered"])
    .order("offer_price", { ascending: false })

  offers = sellerOffers ?? []

  if (!offers || offers.length === 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-3xl font-bold">Offers</h2>
        <Card>
          <CardContent className="py-12 text-center">
            <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">No offers yet</h3>
            <p className="text-muted-foreground">When you receive offers, they will appear here</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Single offer view (using canonical offer_price)
  if (offers.length === 1) {
    const offer = offers[0]
    const contingencies =
      typeof offer.contingencies === "string" ? JSON.parse(offer.contingencies || "{}") : offer.contingencies || {}
    const priceVsList = ((offer.offer_price - listing.price) / listing.price) * 100

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
                  ${(offer.offer_price || 0).toLocaleString()}
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

          {/* Net Sheet Calculator using canonical offer_price */}
          <NetSheetCalculator
            offerPrice={offer.offer_price || 0}
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
              {/* Offer Price (using canonical offer_price) */}
              <tr className="border-b">
                <td className="py-3">Offer Price</td>
                {offers.map((offer) => (
                  <td key={offer.id} className="text-center py-3">
                    ${(offer.offer_price || 0).toLocaleString()}
                    {offer.offer_price === Math.max(...offers.map((o: any) => o.offer_price || 0)) && " ⭐"}
                  </td>
                ))}
                <td className="text-center py-3 font-semibold">
                  {String.fromCharCode(
                    65 +
                      offers.findIndex(
                        (o: any) => o.offer_price === Math.max(...offers.map((o: any) => o.offer_price || 0)),
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
