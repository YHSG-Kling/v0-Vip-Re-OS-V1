import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { ShieldCheck } from "lucide-react"
import { VendorApprovalClient, type PendingVendor } from "./approval-client"
import { ReviewModerationClient } from "./review-moderation-client"
import { getVendorReviewModerationQueue } from "@/app/actions/vendor-marketplace"
import { resolveVendorTiers, type VendorTier } from "@/lib/kernel/vendor-subscription"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = "force-dynamic"

/**
 * Vendor Approval Queue (super-admin / broker) — the human gate of the VendorVerificationManager.
 * Lists every vendor awaiting approval with its AI verification score + flags; nothing is active until
 * an admin approves it here. No vendor self-activates.
 */
export default async function VendorApprovalsPage() {
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
    .from("users")
    .select("brokerage_id, user_type, role")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")
  const isAdmin =
    ["broker", "admin", "broker_admin", "superadmin"].includes(String(profile.user_type)) ||
    ["broker", "admin", "owner"].includes(String((profile as { role?: string }).role))
  if (!isAdmin) redirect("/dashboard")

  const [{ data: pending }, { data: settingsRow }] = await Promise.all([
    supabase
      .from("vendors")
      .select("id, name, category, email, phone, website, ai_verification_score, verification_flags")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("status", "pending")
      .order("ai_verification_score", { ascending: false, nullsFirst: false })
      .limit(200),
    supabase.from("brokerage_settings").select("settings").eq("brokerage_id", profile.brokerage_id).maybeSingle(),
  ])

  const vendors = (pending ?? []) as PendingVendor[]
  const overrides = ((settingsRow as { settings?: Record<string, unknown> } | null)?.settings as any)?.vendor_tier_pricing ?? {}
  const resolved = resolveVendorTiers(overrides)
  const pricing = (Object.keys(resolved) as VendorTier[]).map((t) => ({ tier: t, price: resolved[t].monthlyPriceUsd }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <ShieldCheck className="h-7 w-7" /> Vendor Approval Queue
        </h1>
        <p className="text-muted-foreground mt-1">
          {vendors.length} vendor{vendors.length === 1 ? "" : "s"} awaiting approval. Nothing is recommended to
          your agents or clients until you approve it — no vendor self-activates.
        </p>
      </div>
      <VendorApprovalClient vendors={vendors} pricing={pricing} />

      {/* The other half of vendor governance: reviews the moderation brain
          routed to a human. Same admin gate as the approval queue above. */}
      <ReviewModerationClient initialQueue={await getVendorReviewModerationQueue()} />
    </div>
  )
}
