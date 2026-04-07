import { createClient } from "@/lib/supabase/server"
import { notFound } from "next/navigation"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import {
  resolveShowingMode,
  getShowingRequests,
  getListingShowings,
  getShowingAnalytics,
  getShowingFeedbackCards,
} from "@/app/actions/seller-showings"
import { getAIShowingInsights } from "@/app/actions/ai-showing-management"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import ShowingsClient from "./showings-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Eye } from "lucide-react"
import Link from "next/link"

interface Props {
  params: Promise<{ id: string }>
}

export default async function ShowingsPage({ params }: Props) {
  const { id: listingId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) notFound()

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) notFound()

  const { data: listing } = await supabase
    .from("listings")
    .select("id, address, city, state, agent_id, lifecycle_stage, showing_instructions")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!listing) notFound()

  // Resolve agent ID - use listing's agent_id or resolve from current user
  const agentUserId = listing.agent_id ?? await resolveAgentId(supabase, user.id)
  if (!agentUserId) notFound()

  // Resolve agentId for insights
  const { agentId } = await getAgentContext()
  const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0]
  const today = new Date().toISOString().split('T')[0]

  const [mode, requests, showings, analytics, feedbackCards, insightsResult] = await Promise.all([
    resolveShowingMode({ listingId, agentUserId, brokerageId }),
    getShowingRequests(listingId),
    getListingShowings(listingId),
    getShowingAnalytics(listingId),
    getShowingFeedbackCards(listingId),
    getAIShowingInsights(agentId, { start: thirtyDaysAgo, end: today }),
  ])

  const insights = insightsResult.success ? (insightsResult as any).insights || null : null

  return (
    <>
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Eye className="h-4 w-4 text-indigo-600" />
            Showing Intelligence
          </CardTitle>
        </CardHeader>
        <CardContent>
          {insights ? (
            <div className="space-y-2 text-xs">
              {insights.positivePatterns?.length > 0 && (
                <div>
                  <p className="font-medium text-green-700">Buyers consistently love:</p>
                  {insights.positivePatterns.slice(0,3).map((p:string,i:number) => (
                    <p key={i} className="text-muted-foreground">+ {p}</p>
                  ))}
                </div>
              )}
              {insights.objectionPatterns?.length > 0 && (
                <div>
                  <p className="font-medium text-amber-700">Common concerns:</p>
                  {insights.objectionPatterns.slice(0,3).map((p:string,i:number) => (
                    <p key={i} className="text-muted-foreground">! {p}</p>
                  ))}
                </div>
              )}
              {insights.pricingSignal && (
                <div>
                  <p className="font-medium text-blue-700">Pricing signal:</p>
                  <p className="text-muted-foreground">{insights.pricingSignal}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Intelligence builds as showing feedback comes in.
              <Link href={`/showings`} className="text-blue-600 ml-1 hover:underline">View showings</Link>
            </p>
          )}
        </CardContent>
      </Card>

      <ShowingsClient
      listing={listing}
      brokerageId={brokerageId}
      agentUserId={agentUserId}
      mode={mode}
      initialRequests={requests.requests ?? []}
      initialShowings={showings.showings ?? []}
      analytics={analytics}
      feedbackCards={feedbackCards}
    />
    </>
  )
}
