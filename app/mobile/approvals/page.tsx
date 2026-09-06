import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { loadMobileApprovalQueue } from "@/lib/intelligence/mobile-approval-queue"
import { MobileApprovalsClient } from "./mobile-approvals-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

/**
 * MOBILE PUSH-TO-APPROVE — the broker's thumb-friendly approval surface. Lists the
 * pending client-message deliverables across every loop, SLA-sorted, with one-tap
 * approve/reject wired to the SAME governed server actions as the Command Center.
 */
export default async function MobileApprovalsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return <div className="p-6 text-red-600">Brokerage not configured</div>
  if (!isAdminOrBroker({ user_type: profile.user_type ?? "" })) {
    return <div className="p-6 text-red-600">Forbidden</div>
  }

  const queue = await loadMobileApprovalQueue(profile.brokerage_id)

  return <MobileApprovalsClient initialItems={queue.items} counts={queue.counts} />
}
