import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadMarketingReview } from "./actions"
import { MarketingReviewClient } from "./review-client"

export const metadata = {
  title: "Marketing Review",
  description: "Triage every AI-drafted email, social post, listing video/photo, and QR code in one place.",
}

/**
 * /dashboard/marketing/review
 *
 * Unified triage queue for everything the AI auto-drafted from media events
 * (video.generated, image.generated, listing.live). Surfaces:
 *
 *   - Personal message drafts (email + SMS) awaiting agent approval
 *   - AI-generated social posts pending publish
 *   - Listing media (video + photo) pending agent approval
 *   - QR codes minted in the last 7 days
 *
 * Agent-scoped: solo agents see only their own items. Broker/admin see the
 * full brokerage. RLS-respecting via the service client + explicit scope
 * filters in the action.
 */
export default async function MarketingReviewPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const svc = createServiceClient()
  const { data: profile } = await svc
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const role = profile.user_type ?? "agent"
  const isAgentScope = role === "agent"

  const snapshot = await loadMarketingReview({
    brokerageId:  profile.brokerage_id,
    agentUserId:  user.id,
    isAgentScope,
  })

  return (
    <MarketingReviewClient
      snapshot={snapshot}
      role={role}
    />
  )
}
