import { createClient } from "@/lib/supabase/server"
import { redirect, notFound } from "next/navigation"
import { BlogEditorClient } from "./blog-editor-client"

export const metadata = {
  title: "Edit Blog Post | Marketing",
  description: "Edit and optimize your blog post",
}

interface BlogEditorPageProps {
  params: Promise<{ postId: string }>
}

export default async function BlogEditorPage({ params }: BlogEditorPageProps) {
  const { postId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect("/login")
  }

  // Get user's brokerage
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .single()

  if (!userData?.brokerage_id) {
    redirect("/onboarding")
  }

  // Fetch blog post
  const { data: post, error } = await supabase
    .from("blog_posts")
    .select(
      "id, brokerage_id, title, slug, excerpt, content, featured_image_url, publish_status, seo_score, wordpress_post_id, created_at, published_at"
    )
    .eq("id", postId)
    .eq("brokerage_id", userData.brokerage_id)
    .single()

  if (error || !post) {
    notFound()
  }

  // Fetch linked keywords
  const { data: keywordLinks } = await supabase
    .from("blog_post_keywords")
    .select("is_primary, seo_keyword_id")
    .eq("blog_post_id", postId)

  const keywords: Array<{ id: string; keyword: string; is_primary: boolean }> = []
  if (keywordLinks?.length) {
    const keywordIds = keywordLinks.map((kl) => kl.seo_keyword_id)
    const { data: keywordData } = await supabase
      .from("seo_keywords")
      .select("id, keyword")
      .in("id", keywordIds)

    if (keywordData) {
      for (const kd of keywordData) {
        const link = keywordLinks.find((kl) => kl.seo_keyword_id === kd.id)
        keywords.push({
          id: kd.id,
          keyword: kd.keyword,
          is_primary: link?.is_primary || false,
        })
      }
    }
  }

  // Fetch latest SEO log
  const { data: seoLog } = await supabase
    .from("seo_optimization_log")
    .select("score, issues, recommendations, optimized_at")
    .eq("blog_post_id", postId)
    .order("optimized_at", { ascending: false })
    .limit(1)
    .single()

  const latestSeoLog = seoLog
    ? {
        score: seoLog.score,
        issues: (seoLog.issues as { items?: string[] })?.items || [],
        recommendations: (seoLog.recommendations as { items?: string[] })?.items || [],
        optimized_at: seoLog.optimized_at,
      }
    : null

  return (
    <BlogEditorClient
      userId={user.id}
      brokerageId={userData.brokerage_id}
      post={{
        ...post,
        keywords,
        latestSeoLog,
      }}
    />
  )
}
