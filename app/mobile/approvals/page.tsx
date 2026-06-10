import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { loadMobileApprovalQueue } from "@/lib/intelligence/mobile-approval-queue"
import { MobileApprovalsClient } from "./mobile-approvals-client"

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

  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return <div className="p-6 text-red-600">Brokerage not configured</div>
  if (!["broker", "broker_admin", "admin", "superadmin", "team_lead"].includes(profile.user_type ?? "")) {
    return <div className="p-6 text-red-600">Forbidden</div>
  }

  const queue = await loadMobileApprovalQueue(profile.brokerage_id)

  return <MobileApprovalsClient initialItems={queue.items} counts={queue.counts} />
}
