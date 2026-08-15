"use server"

// lib/blog/seo-optimizer.ts
// Layer 9.6 — SEO Analyzer for Blog Posts
// Scores posts based on SEO best practices checklist

import { createClient } from "@/lib/supabase/server"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface SeoAnalysisResult {
  score: number
  issues: string[]
  recommendations: string[]
}

interface ChecklistItem {
  name: string
  points: number
  check: (data: AnalysisData) => boolean
  issue: string
  recommendation: string
}

interface AnalysisData {
  title: string
  slug: string
  excerpt: string
  content: string
  primaryKeyword: string | null
  secondaryKeywords: string[]
}

// ─── SCORING CHECKLIST ────────────────────────────────────────────────────────

const SEO_CHECKLIST: ChecklistItem[] = [
  {
    name: "title_has_primary_keyword",
    points: 20,
    check: (data) => {
      if (!data.primaryKeyword) return false
      return data.title.toLowerCase().includes(data.primaryKeyword.toLowerCase())
    },
    issue: "Title does not contain the primary keyword",
    recommendation: "Include the primary keyword in your title for better SEO",
  },
  {
    name: "content_length_600_plus",
    points: 15,
    check: (data) => {
      const wordCount = data.content.split(/\s+/).filter((w) => w.length > 0).length
      return wordCount >= 600
    },
    issue: "Content is less than 600 words",
    recommendation: "Expand your content to at least 600 words for better search rankings",
  },
  {
    name: "excerpt_present",
    points: 10,
    check: (data) => {
      return !!(data.excerpt && data.excerpt.trim().length > 0)
    },
    issue: "No excerpt/meta description provided",
    recommendation: "Add a compelling excerpt that summarizes the post in 150-160 characters",
  },
  {
    name: "primary_keyword_density",
    points: 20,
    check: (data) => {
      if (!data.primaryKeyword) return false
      const contentLower = data.content.toLowerCase()
      const keywordLower = data.primaryKeyword.toLowerCase()
      const wordCount = data.content.split(/\s+/).filter((w) => w.length > 0).length
      const keywordMatches = (contentLower.match(new RegExp(keywordLower, "gi")) || []).length
      const density = (keywordMatches / wordCount) * 100
      return density >= 0.5 && density <= 2.5
    },
    issue: "Primary keyword density is outside optimal range (0.5%-2.5%)",
    recommendation:
      "Adjust keyword usage to achieve 0.5%-2.5% density for natural optimization",
  },
  {
    name: "internal_structure",
    points: 15,
    check: (data) => {
      const hasH2 = /<h2[^>]*>/i.test(data.content) || /##\s/.test(data.content)
      const hasH3 =
        /<h3[^>]*>/i.test(data.content) ||
        /###\s/.test(data.content) ||
        hasH2 // H2 alone is acceptable
      return hasH2 || hasH3
    },
    issue: "Content lacks proper heading structure (H2/H3 tags)",
    recommendation: "Add H2 and H3 headings to structure your content for better readability",
  },
  {
    name: "meta_description_length",
    points: 10,
    check: (data) => {
      if (!data.excerpt) return false
      const length = data.excerpt.trim().length
      return length > 0 && length <= 160
    },
    issue: "Meta description exceeds 160 characters or is empty",
    recommendation: "Keep your excerpt/meta description under 160 characters",
  },
  {
    name: "slug_contains_keyword",
    points: 10,
    check: (data) => {
      if (!data.primaryKeyword) return false
      const slugWords = data.slug.toLowerCase().split("-")
      const keywordWords = data.primaryKeyword.toLowerCase().split(/\s+/)
      return keywordWords.some((kw) => slugWords.includes(kw))
    },
    issue: "URL slug does not contain the primary keyword",
    recommendation: "Include at least one keyword term in your URL slug",
  },
]

// ─── analyzeSEO ───────────────────────────────────────────────────────────────

export async function analyzeSEO(
  postId: string,
  brokerageId: string
): Promise<{ success: boolean; result?: SeoAnalysisResult; error?: string }> {
  const supabase = await createClient()

  // ── 1. Fetch blog post ──────────────────────────────────────────────────────
  const { data: post, error: postError } = await supabase
    .from("blog_posts")
    .select("id, title, slug, excerpt, content")
    .eq("id", postId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (postError || !post) {
    return { success: false, error: "Blog post not found" }
  }

  // ── 2. Fetch linked keywords via blog_post_keywords + seo_keywords ──────────
  const { data: keywordLinks } = await supabase
    .from("blog_post_keywords")
    .select("is_primary, seo_keyword_id")
    .eq("blog_post_id", postId)

  let primaryKeyword: string | null = null
  const secondaryKeywords: string[] = []

  if (keywordLinks?.length) {
    const keywordIds = keywordLinks.map((kl) => kl.seo_keyword_id)
    const { data: keywords } = await supabase
      .from("seo_keywords")
      .select("id, keyword")
      .in("id", keywordIds)

    if (keywords) {
      for (const kw of keywords) {
        const link = keywordLinks.find((kl) => kl.seo_keyword_id === kw.id)
        if (link?.is_primary) {
          primaryKeyword = kw.keyword
        } else {
          secondaryKeywords.push(kw.keyword)
        }
      }
    }
  }

  // ── 3. Run scoring checklist ────────────────────────────────────────────────
  const analysisData: AnalysisData = {
    title: post.title || "",
    slug: post.slug || "",
    excerpt: post.excerpt || "",
    content: post.content || "",
    primaryKeyword,
    secondaryKeywords,
  }

  let score = 0
  const issues: string[] = []
  const recommendations: string[] = []

  for (const item of SEO_CHECKLIST) {
    const passed = item.check(analysisData)
    if (passed) {
      score += item.points
    } else {
      issues.push(item.issue)
      recommendations.push(item.recommendation)
    }
  }

  // ── 4. Insert seo_optimization_log ──────────────────────────────────────────
  const { error: logError } = await supabase.from("seo_optimization_log").insert({
    brokerage_id: brokerageId,
    blog_post_id: postId,
    score,
    issues: { items: issues },
    recommendations: { items: recommendations },
    optimized_at: new Date().toISOString(),
  })

  if (logError) {
    console.error("[analyzeSEO] Log insert failed:", logError)
  }

  // ── 5. Update blog_posts.seo_score ──────────────────────────────────────────
  const { error: updateError } = await supabase
    .from("blog_posts")
    .update({ seo_score: score })
    .eq("id", postId)

  if (updateError) {
    console.error("[analyzeSEO] Score update failed:", updateError)
  }

  return {
    success: true,
    result: {
      score,
      issues,
      recommendations,
    },
  }
}

// ─── getSeoScoreHistory ───────────────────────────────────────────────────────

export async function getSeoScoreHistory(
  postId: string
): Promise<{
  success: boolean
  history?: Array<{
    score: number
    issues: string[]
    recommendations: string[]
    optimized_at: string
  }>
  error?: string
}> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("seo_optimization_log")
    .select("score, issues, recommendations, optimized_at")
    .eq("blog_post_id", postId)
    .order("optimized_at", { ascending: false })
    .limit(10)

  if (error) {
    console.error("[getSeoScoreHistory] Query failed:", error)
    return { success: false, error: "Failed to fetch SEO history" }
  }

  const history = (data || []).map((item) => ({
    score: item.score,
    issues: (item.issues as { items?: string[] })?.items || [],
    recommendations: (item.recommendations as { items?: string[] })?.items || [],
    optimized_at: item.optimized_at,
  }))

  return { success: true, history }
}
