import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { BlogDashboardClient } from "./blog-dashboard-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata = {
  title: "Blog Posts | Marketing",
  description: "Manage and generate SEO-optimized blog content",
}

export default async function BlogDashboardPage() {
  const supabase = await createClient()

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
  // Get user's brokerage
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!userData?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  // Fetch blog posts
  const { data: posts } = await supabase
    .from("blog_posts")
    .select(
      "id, title, slug, excerpt, publish_status, seo_score, created_at, published_at, agent_user_id"
    )
    .eq("brokerage_id", userData.brokerage_id)
    .order("created_at", { ascending: false })

  // Fetch SEO keywords for the generate form
  const { data: keywords } = await supabase
    .from("seo_keywords")
    .select("id, keyword, keyword_type, is_active")
    .eq("brokerage_id", userData.brokerage_id)
    .eq("is_active", true)
    .order("priority_score", { ascending: false, nullsFirst: false })

  return (
    <BlogDashboardClient
      userId={user.id}
      brokerageId={userData.brokerage_id}
      initialPosts={posts || []}
      keywords={keywords || []}
    />
  )
}
