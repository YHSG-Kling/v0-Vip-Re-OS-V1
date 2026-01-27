import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Clock, CheckCircle2, XCircle, RefreshCw, FileText } from "lucide-react"

export default async function MyOfferPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  let offers: any[] = []

  try {
    const { data, error } = await supabase
      .from("offers")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })

    if (!error && data) {
      offers = data
    }
  } catch (e) {
    // Continue with empty array if offers table doesn't exist
  }

  if (!offers || offers.length === 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-3xl font-bold">My Offers</h2>
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">No offers submitted yet</h3>
            <p className="text-muted-foreground mb-4">
              When you make an offer on a property, it will appear here for tracking.
            </p>
            <p className="text-sm text-muted-foreground">
              Browse properties and work with your agent to submit your first offer!
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const activeOffer = offers[0]
  const hasCounter = activeOffer.counter_amount && activeOffer.counter_amount !== activeOffer.offer_amount

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
      case "submitted":
      case "under_review":
        return (
          <Badge variant="outline" className="gap-1">
            <Clock className="h-3 w-3" /> Pending Response
          </Badge>
        )
      case "accepted":
        return (
          <Badge variant="default" className="bg-green-600 gap-1">
            <CheckCircle2 className="h-3 w-3" /> Accepted
          </Badge>
        )
      case "countered":
        return (
          <Badge variant="outline" className="text-blue-600 border-blue-600 gap-1">
            <RefreshCw className="h-3 w-3" /> Countered
          </Badge>
        )
      case "rejected":
        return (
          <Badge variant="outline" className="text-red-600 border-red-600 gap-1">
            <XCircle className="h-3 w-3" /> Rejected
          </Badge>
        )
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold">My Offer</h2>

      {/* Active Offer Card */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>{activeOffer.property_address || "Property"}</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Submitted {new Date(activeOffer.submitted_at || activeOffer.created_at).toLocaleDateString()}
              </p>
            </div>
            {getStatusBadge(activeOffer.status)}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Offer Details - Use offer_amount instead of offer_price */}
          <div>
            <h3 className="font-semibold mb-3">Your Offer Details</h3>
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Your Offer Price</p>
                <p className="text-2xl font-bold text-green-600">${(activeOffer.offer_amount || 0).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Financing</p>
                <p className="font-semibold">{activeOffer.financing_type || "Conventional"}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Down Payment</p>
                <p className="font-semibold">{activeOffer.down_payment_percent || 20}%</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Earnest Money</p>
                <p className="font-semibold">${(activeOffer.earnest_money || 0).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Closing Date</p>
                <p className="font-semibold">
                  {activeOffer.close_date ? new Date(activeOffer.close_date).toLocaleDateString() : "TBD"}
                </p>
              </div>
            </div>
          </div>

          {/* Counter Received - Use counter_amount instead of counter_price */}
          {hasCounter && (
            <Card className="border-blue-200 bg-blue-50">
              <CardHeader>
                <CardTitle className="text-lg">Seller Counter Received</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm">Seller countered your offer with these terms:</p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2">Term</th>
                      <th className="text-right py-2">Your Offer</th>
                      <th className="text-right py-2">Seller Counter</th>
                      <th className="text-right py-2">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="py-2">Price</td>
                      <td className="text-right">${(activeOffer.offer_amount || 0).toLocaleString()}</td>
                      <td className="text-right font-semibold">
                        ${(activeOffer.counter_amount || 0).toLocaleString()}
                      </td>
                      <td className="text-right text-orange-600">
                        +${((activeOffer.counter_amount || 0) - (activeOffer.offer_amount || 0)).toLocaleString()}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <div className="bg-white p-4 rounded-lg">
                  <p className="text-sm font-semibold mb-2">Your agent recommends:</p>
                  <p className="text-sm text-muted-foreground">
                    The seller's counter is reasonable. Discuss with your agent to determine next steps.
                  </p>
                </div>

                <div className="flex gap-2">
                  <Button className="flex-1">Accept Counter</Button>
                  <Button variant="outline" className="flex-1 bg-transparent">
                    Counter Back
                  </Button>
                  <Button variant="ghost">Decline</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Offer History Timeline */}
          <div>
            <h3 className="font-semibold mb-3">Offer Timeline</h3>
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-blue-100 rounded-full">
                  <CheckCircle2 className="h-4 w-4 text-blue-600" />
                </div>
                <div className="flex-1">
                  <p className="font-medium text-sm">You submitted offer</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(activeOffer.submitted_at || activeOffer.created_at).toLocaleString()}
                  </p>
                </div>
              </div>

              {hasCounter && (
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-orange-100 rounded-full">
                    <RefreshCw className="h-4 w-4 text-orange-600" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-sm">Seller countered</p>
                    <p className="text-xs text-muted-foreground">{new Date(activeOffer.updated_at).toLocaleString()}</p>
                  </div>
                </div>
              )}

              {activeOffer.status === "accepted" && (
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-green-100 rounded-full">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-sm">Offer accepted</p>
                    <p className="text-xs text-muted-foreground">{new Date(activeOffer.updated_at).toLocaleString()}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
