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
  // Get user's brokerage. supabase-js RESOLVES a rejected read with { error },
  // so an unchecked read here would turn a query failure into "this user has no
  // brokerage" and bounce a perfectly good account to onboarding.
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (userError) {
    throw new Error(`Could not read your account: ${userError.message}`)
  }

  if (!userData?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  // Fetch blog posts.
  //
  // `category` IS IN THIS LIST FOR A REASON. The client renders category filter
  // tabs and filters with `post.category === categoryFilter`. This select used to
  // omit the column entirely, so every row arrived with `category` undefined,
  // every comparison against a real category was false, and picking any tab other
  // than "All" emptied the list — a filter that could never match anything.
  // blog_posts.category is a real, nullable text column on the live table; the
  // filter was never broken, the projection feeding it was.
  const { data: posts, error: postsError } = await supabase
    .from("blog_posts")
    .select(
      "id, title, slug, excerpt, category, publish_status, seo_score, created_at, published_at, agent_user_id"
    )
    .eq("brokerage_id", userData.brokerage_id)
    .order("created_at", { ascending: false })

  if (postsError) {
    throw new Error(`Could not load blog posts: ${postsError.message}`)
  }

  // Fetch SEO keywords for the generate form
  const { data: keywords, error: keywordsError } = await supabase
    .from("seo_keywords")
    .select("id, keyword, keyword_type, is_active")
    .eq("brokerage_id", userData.brokerage_id)
    .eq("is_active", true)
    .order("priority_score", { ascending: false, nullsFirst: false })

  if (keywordsError) {
    throw new Error(`Could not load SEO keywords: ${keywordsError.message}`)
  }

  return (
    <BlogDashboardClient
      userId={user.id}
      brokerageId={userData.brokerage_id}
      initialPosts={posts || []}
      keywords={keywords || []}
    />
  )
}
