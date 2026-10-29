// app/dashboard/social/page.tsx
// Layer 9.2 Social Media Automation — Dashboard Page

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { SocialDashboardClient } from "./social-dashboard-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { approverFor } from "@/lib/kernel/approval-authority"
import { describeApprover } from "./approver-line"

export const metadata = {
  title: "Social Media | Dashboard",
  description: "Manage and schedule your social media posts",
}

export default async function SocialDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>
}) {
  const supabase = await createClient()
  const { action } = await searchParams
  const openCreate = action === "create"

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Get user profile with brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, user_type, first_name, last_name")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  // Get connected social accounts — the NON-secret projection (wave 140, lane 140P): these rows are
  // a prop of the client component below, so the sealed tokens must not ride along
  // (lib/security/credential-projection.ts, one spelling per store).
  const { publicCredentialSelect, CREDENTIAL_STORES } = await import("@/lib/security/credential-projection")
  const { data: accounts } = await supabase
    .from("social_media_accounts")
    .select(publicCredentialSelect("id, brokerage_id, user_id, agent_id, platform, account_id, account_name, scope, token_expires_at, is_active, created_at, updated_at", CREDENTIAL_STORES.social_media_accounts))
    .eq("brokerage_id", profile.brokerage_id)
    .eq("is_active", true)
    .order("platform")

  // Get social posts queue
  const { data: posts } = await supabase
    .from("social_posts")
    .select(
      `
      *,
      social_media_accounts (id, platform, account_name),
      social_engagement_tracking (*)
    `
    )
    .eq("brokerage_id", profile.brokerage_id)
    .order("scheduled_for", { ascending: true })
    .limit(100)

  // Check broker approval setting from global_settings.additional_settings
  const { data: globalSettings } = await supabase
    .from("global_settings")
    .select("additional_settings")
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()

  const requiresBrokerApproval =
    (globalSettings?.additional_settings as any)?.social_requires_broker_approval === true

  // CONTRACT C5 (wave 146 — owner ruling 9: "the tenants approve their own ads/posts … assets"): the screen
  // NAMES who approves this person's post from the real authority hierarchy (lib/kernel/approval-authority.ts
  // approverFor, lane 146E) instead of assuming the broker. Tenant and seat come from the session above; the
  // agents row is crossed by user_id inside this tenant (agents.id ≠ users.id, CLAUDE.md §3). A refused read
  // is worded as a refusal — never as "no approval needed" (fail closed, §4).
  const { data: viewerAgent, error: viewerAgentErr } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()
  if (viewerAgentErr) console.error("[social] viewer agents read refused:", viewerAgentErr.message)
  const approver = await approverFor({
    brokerageId: profile.brokerage_id,
    assetKind: "social_post",
    scope: { agentId: (viewerAgent as { id?: string } | null)?.id ?? null, agentUserId: user.id },
  })
  const approverLine = describeApprover(approver, user.id)

  // Get publish logs for failed posts
  const failedPostIds = posts?.filter((p) => p.status === "failed").map((p) => p.id) || []
  let publishLogs: any[] = []

  if (failedPostIds.length > 0) {
    const { data: logs } = await supabase
      .from("social_publish_log")
      .select("*")
      .in("social_post_id", failedPostIds)
      .order("created_at", { ascending: false })

    publishLogs = logs || []
  }

  return (
    <SocialDashboardClient
      userId={user.id}
      brokerageId={profile.brokerage_id}
      userRole={profile.user_type || "agent"}
      userName={`${profile.first_name || ""} ${profile.last_name || ""}`.trim()}
      accounts={accounts || []}
      initialPosts={posts || []}
      publishLogs={publishLogs}
      openCreate={openCreate}
      requiresBrokerApproval={requiresBrokerApproval}
      approverLine={approverLine}
    />
  )
}
