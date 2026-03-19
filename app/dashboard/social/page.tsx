// app/dashboard/social/page.tsx
// Layer 9.2 Social Media Automation — Dashboard Page

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { SocialDashboardClient } from "./social-dashboard-client"

export const metadata = {
  title: "Social Media | Dashboard",
  description: "Manage and schedule your social media posts",
}

export default async function SocialDashboardPage({
  searchParams,
}: {
  searchParams: { action?: string }
}) {
  const supabase = await createClient()
  const openCreate = searchParams.action === "create"

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Get user profile with brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, role, first_name, last_name")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) {
    redirect("/onboarding")
  }

  // Get connected social accounts
  const { data: accounts } = await supabase
    .from("social_media_accounts")
    .select("*")
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
      userRole={profile.role || "agent"}
      userName={`${profile.first_name || ""} ${profile.last_name || ""}`.trim()}
      accounts={accounts || []}
      initialPosts={posts || []}
      publishLogs={publishLogs}
      openCreate={openCreate}
    />
  )
}
