import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { redirect } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Home,
  DollarSign,
  Calendar,
  Eye,
  Star,
  ThumbsUp,
  ThumbsDown,
  Minus,
  ChevronDown,
  MessageSquare,
  CheckCircle,
  Clock,
  AlertTriangle,
  Lightbulb,
} from "lucide-react"
import { SellerUpdateComposer } from "@/app/components/listings/SellerUpdateComposer"
import {
  getShowingFeedback,
  getSellerCommunicationHistory,
  getPriceRecommendation,
} from "@/app/actions/seller-updates"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Seller Updates | VIP-OS",
  description: "Weekly seller update workspace with AI draft generation",
}

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function SellerUpdatesPage({ params }: PageProps) {
  const { id: listingId } = await params
  const supabase = await createClient()

  let agentContext
  try {
    agentContext = await getAgentContext()
  } catch {
    redirect("/auth/login")
  }

  const { agentId, brokerageId } = agentContext

  // Fetch listing data
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select(`
      id,
      address,
      city,
      state,
      zip,
      list_price,
      status,
      contact_id,
      agent_id,
      showing_count,
      contacts!listings_contact_id_fkey (
        id,
        first_name,
        last_name
      )
    `)
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (listingError || !listing) {
    redirect("/dashboard/listings")
  }

  // Calculate DOM
  const { data: listingMetrics } = await supabase
    .from("listing_metrics")
    .select("date")
    .eq("listing_id", listingId)
    .order("date", { ascending: true })
    .limit(1)

  const firstMetricDate = listingMetrics?.[0]?.date
  const dom = firstMetricDate
    ? Math.floor((Date.now() - new Date(firstMetricDate).getTime()) / (1000 * 60 * 60 * 24))
    : 0

  // Fetch showings this week
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const { data: weeklyShowings } = await supabase
    .from("showings")
    .select("id")
    .eq("listing_id", listingId)
    .gte("scheduled_at", sevenDaysAgo.toISOString())

  const showingsThisWeek = weeklyShowings?.length || 0

  // Fetch total showings
  const { data: allShowings } = await supabase
    .from("showings")
    .select("id")
    .eq("listing_id", listingId)

  const totalShowings = allShowings?.length || 0

  // Fetch feedback data
  const feedbackData = await getShowingFeedback(listingId)

  // Fetch communication history
  const communicationHistory = await getSellerCommunicationHistory(listingId)

  // Fetch price recommendation
  const priceRecommendation = await getPriceRecommendation(listingId)

  const sellerName = listing.contacts
    ? `${(listing.contacts as any).first_name} ${(listing.contacts as any).last_name}`
    : "Seller"

  const fullAddress = `${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}`

  return (
    <div className="container max-w-5xl py-6 space-y-6">
      {/* Section 1: Listing Context Header */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Home className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-lg">{listing.address}</CardTitle>
                <CardDescription>
                  {listing.city}, {listing.state} {listing.zip}
                </CardDescription>
              </div>
            </div>
            <Badge
              variant={listing.status === "active" ? "default" : "secondary"}
              className={listing.status === "active" ? "bg-green-100 text-green-700" : ""}
            >
              {listing.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-2">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">List Price</p>
                <p className="font-semibold">
                  ${listing.list_price?.toLocaleString() || "N/A"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">DOM</p>
                <p className="font-semibold">{dom} days</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">This Week</p>
                <p className="font-semibold">{showingsThisWeek} showings</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Total</p>
                <p className="font-semibold">{totalShowings} showings</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Star className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Avg Feedback</p>
                <p className="font-semibold">
                  {(feedbackData as any).all && (feedbackData as any).all.length > 0
                    ? `${((feedbackData as any).all.reduce((sum: number, f: any) => sum + (f.sentiment_score || 3), 0) / (feedbackData as any).all.length).toFixed(1)}/5`
                    : "No data"}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 2: Weekly Update Composer */}
      <SellerUpdateComposer
        listingId={listingId}
        agentId={agentId ?? ''}
        listingAddress={fullAddress}
        sellerName={sellerName}
      />

      {/* Section 3: Showing Feedback */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Showing Feedback
          </CardTitle>
          <CardDescription>
            Recent feedback from buyer agents, grouped by sentiment
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Sentiment counts */}
          <div className="flex gap-4">
            <div className="flex items-center gap-2">
              <ThumbsUp className="h-4 w-4 text-green-600" />
              <span className="text-sm">
                Positive: <strong>{(feedbackData as any).counts?.positive || 0}</strong>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Minus className="h-4 w-4 text-amber-600" />
              <span className="text-sm">
                Neutral: <strong>{(feedbackData as any).counts?.neutral || 0}</strong>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <ThumbsDown className="h-4 w-4 text-red-600" />
              <span className="text-sm">
                Negative: <strong>{(feedbackData as any).counts?.negative || 0}</strong>
              </span>
            </div>
          </div>

          {/* Feedback list */}
          {(feedbackData as any).all && (feedbackData as any).all.length > 0 ? (
            <div className="space-y-2">
              {(feedbackData as any).all.slice(0, 5).map((feedback: any) => {
                const sentimentScore = feedback.sentiment_score || 3
                const sentimentColor =
                  sentimentScore >= 4
                    ? "border-green-200 bg-green-50"
                    : sentimentScore < 3
                      ? "border-red-200 bg-red-50"
                      : "border-amber-200 bg-amber-50"

                return (
                  <Collapsible key={feedback.id}>
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        className={`w-full justify-between p-3 h-auto rounded-lg border ${sentimentColor}`}
                      >
                        <div className="flex items-center gap-2 text-left">
                          {sentimentScore >= 4 ? (
                            <ThumbsUp className="h-4 w-4 text-green-600" />
                          ) : sentimentScore < 3 ? (
                            <ThumbsDown className="h-4 w-4 text-red-600" />
                          ) : (
                            <Minus className="h-4 w-4 text-amber-600" />
                          )}
                          <span className="text-sm font-medium">
                            {feedback.overall_impression || "No impression noted"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(feedback.created_at).toLocaleDateString()}
                          </span>
                        </div>
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="px-3 py-2 text-sm">
                      {feedback.specific_concerns && (
                        <p>
                          <strong>Concerns:</strong> {feedback.specific_concerns}
                        </p>
                      )}
                      {feedback.buyer_favorite_features && (
                        <p>
                          <strong>Liked:</strong> {feedback.buyer_favorite_features}
                        </p>
                      )}
                      {feedback.price_opinion && (
                        <p>
                          <strong>Price Opinion:</strong> {feedback.price_opinion}
                        </p>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                )
              })}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No feedback received yet.</p>
          )}
        </CardContent>
      </Card>

      {/* Section 4: Price Recommendation */}
      {priceRecommendation && (
        <Alert className="border-amber-200 bg-amber-50">
          <Lightbulb className="h-4 w-4 text-amber-600" />
          <AlertTitle className="text-amber-800 flex items-center gap-2">
            AI Suggestion: Consider a Price Adjustment
            <Badge variant="outline" className="text-xs">
              {priceRecommendation.label}
            </Badge>
          </AlertTitle>
          <AlertDescription className="text-amber-700 mt-2">
            <p className="mb-2">{priceRecommendation.reasoning}</p>
            <div className="flex gap-4 text-sm mt-3">
              <span>
                Current Price:{" "}
                <strong>${priceRecommendation.currentPrice?.toLocaleString()}</strong>
              </span>
              <span>
                DOM: <strong>{priceRecommendation.dom} days</strong>
              </span>
              <span>
                Avg Feedback: <strong>{priceRecommendation.avgFeedbackRating?.toFixed(1)}/5</strong>
              </span>
              <span>
                Showings/Week: <strong>{priceRecommendation.showingsPerWeek}</strong>
              </span>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Section 5: Communication History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Communication History
          </CardTitle>
          <CardDescription>Recent messages sent to {sellerName}</CardDescription>
        </CardHeader>
        <CardContent>
          {communicationHistory && communicationHistory.length > 0 ? (
            <div className="space-y-3">
              {communicationHistory.map((message) => (
                <div
                  key={message.id}
                  className="flex items-start justify-between p-3 rounded-lg border"
                >
                  <div className="flex-1">
                    <p className="text-sm line-clamp-2">{message.body}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(message.created_at).toLocaleDateString()} at{" "}
                      {new Date(message.created_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <div className="ml-3">
                    {message.read_at ? (
                      <Badge
                        variant="outline"
                        className="text-green-600 border-green-200 bg-green-50"
                      >
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Read {new Date(message.read_at).toLocaleDateString()}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        <Clock className="h-3 w-3 mr-1" />
                        Unread
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No messages sent to this seller yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
