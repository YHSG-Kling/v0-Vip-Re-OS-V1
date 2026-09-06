"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ArrowLeft,
  Save,
  Send,
  CheckCircle,
  Globe,
  TrendingUp,
  RefreshCw,
  AlertTriangle,
  Lightbulb,
  ExternalLink,
  Loader2,
  Sparkles,
  Tag,
  Clock,
  BookOpen,
  X,
  Copy,
  Share2,
  Layers,
} from "lucide-react"
import { updateBlogPost, publishToWordPress, suggestSEOKeywords } from "@/app/actions/blog"
import { generateOmnipresent, generateVariations } from "@/app/actions/content-generation-engine"
import { createSocialPost } from "@/app/actions/social-publishing"
import { createEmailCampaign } from "@/app/actions/email-campaigns"
import { analyzeSEO, getSeoScoreHistory } from "@/lib/blog/seo-optimizer"
import { format } from "date-fns"
import { toast } from "sonner"

interface BlogPostData {
  id: string
  brokerage_id: string
  title: string
  slug: string
  excerpt: string
  content: string
  featured_image_url: string | null
  publish_status: string
  seo_score: number | null
  wordpress_post_id: string | null
  created_at: string
  published_at: string | null
  keywords: Array<{ id: string; keyword: string; is_primary: boolean }>
  latestSeoLog: {
    score: number
    issues: string[]
    recommendations: string[]
    optimized_at: string
  } | null
}

interface BlogEditorClientProps {
  userId: string
  brokerageId: string
  post: BlogPostData
}

const statusSteps = ["draft", "pending_review", "approved", "published"]

const CATEGORIES = [
  "Market Update",
  "Buyer Tips",
  "Seller Tips",
  "Neighborhood Guide",
  "Investment Tips",
  "Company News",
]

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  pending_review: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  approved: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  published: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
}

function SeoScoreCircle({ score }: { score: number }) {
  const getColor = () => {
    if (score >= 80) return "text-green-600 dark:text-green-400"
    if (score >= 60) return "text-amber-600 dark:text-amber-400"
    return "text-red-600 dark:text-red-400"
  }

  const getStrokeColor = () => {
    if (score >= 80) return "stroke-green-600 dark:stroke-green-400"
    if (score >= 60) return "stroke-amber-600 dark:stroke-amber-400"
    return "stroke-red-600 dark:stroke-red-400"
  }

  const circumference = 2 * Math.PI * 40
  const offset = circumference - (score / 100) * circumference

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg className="w-24 h-24 -rotate-90">
        <circle
          cx="48"
          cy="48"
          r="40"
          stroke="currentColor"
          strokeWidth="8"
          fill="none"
          className="text-muted/20"
        />
        <circle
          cx="48"
          cy="48"
          r="40"
          strokeWidth="8"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={getStrokeColor()}
        />
      </svg>
      <span className={`absolute text-2xl font-bold ${getColor()}`}>{score}</span>
    </div>
  )
}

function computeLocalSeoScore(
  title: string,
  excerpt: string,
  content: string,
  keywords: string[]
): number {
  let score = 0
  const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length
  const primaryKw = keywords[0] || ""

  // Title has primary keyword (+20)
  if (primaryKw && title.toLowerCase().includes(primaryKw.toLowerCase())) score += 20
  // Content >= 600 words (+15)
  if (wordCount >= 600) score += 15
  // Excerpt present (+10)
  if (excerpt.trim().length > 0) score += 10
  // Excerpt <= 160 chars (+10)
  if (excerpt.trim().length > 0 && excerpt.trim().length <= 160) score += 10
  // Content has H2/H3 (+15)
  if (/<h[23][^>]*>/i.test(content) || /##\s/.test(content)) score += 15
  // Primary keyword density 0.5–2.5% (+20)
  if (primaryKw && wordCount > 0) {
    const escapedPrimaryKw = primaryKw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const matches = (content.toLowerCase().match(new RegExp(`\\b${escapedPrimaryKw}\\b`, "gi")) || []).length
    const density = (matches / wordCount) * 100
    if (density >= 0.5 && density <= 2.5) score += 20
  }
  // Has call-to-action hint in content (+10)
  if (/contact\s+us|call\s+us|get\s+in\s+touch|schedule|book\s+a/i.test(content)) score += 10

  return Math.min(score, 100)
}

export function BlogEditorClient({ userId, brokerageId, post }: BlogEditorClientProps) {
  const router = useRouter()

  // Form state
  const [title, setTitle] = useState(post.title)
  const [slug, setSlug] = useState(post.slug)
  const [excerpt, setExcerpt] = useState(post.excerpt || "")
  const [content, setContent] = useState(post.content || "")
  const [featuredImageUrl, setFeaturedImageUrl] = useState(post.featured_image_url || "")
  const [imageLoadError, setImageLoadError] = useState(false)

  useEffect(() => {
    setImageLoadError(false)
  }, [featuredImageUrl])

  const [callToAction, setCallToAction] = useState((post as any).call_to_action || "")
  const [category, setCategory] = useState((post as any).category || "")
  const [publishStatus, setPublishStatus] = useState(post.publish_status)
  const [seoScore, setSeoScore] = useState(post.seo_score)
  const [seoIssues, setSeoIssues] = useState(post.latestSeoLog?.issues || [])
  const [seoRecommendations, setSeoRecommendations] = useState(
    post.latestSeoLog?.recommendations || []
  )
  // SEO score trend (getSeoScoreHistory) — the server page only ships the
  // LATEST seo_optimization_log row, so before this the editor could never show
  // whether an edit moved the score up or down. The history read is the
  // brokerage-scoped, session-gated action in lib/blog/seo-optimizer.ts.
  const [seoHistory, setSeoHistory] = useState<
    Array<{ score: number; optimized_at: string }>
  >([])
  const [wordpressPostId, setWordpressPostId] = useState(post.wordpress_post_id)
  const [suggestedKeywords, setSuggestedKeywords] = useState<
    Array<{ keyword: string; type: string }>
  >([])

  // Loading states
  const [isSaving, setIsSaving] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isSuggestingKeywords, setIsSuggestingKeywords] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Repurpose + Variations
  const [repurposeLoading, setRepurposeLoading] = useState(false)
  const [repurposeResults, setRepurposeResults] = useState<Array<{ format: string; body: string }> | null>(null)
  const [variationsLoading, setVariationsLoading] = useState(false)
  const [variations, setVariations] = useState<Array<{ body: string }> | null>(null)
  const [sendingKey, setSendingKey] = useState<string | null>(null)

  // Computed values
  const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length
  const readTime = Math.max(1, Math.ceil(wordCount / 200))
  const localSeoScore = computeLocalSeoScore(
    title,
    excerpt,
    content,
    post.keywords.map((k) => k.keyword)
  )

  const handleSave = async () => {
    setIsSaving(true)
    setError(null)
    setSuccessMessage(null)

    try {
      const result = await updateBlogPost(userId, post.id, {
        title,
        slug,
        excerpt,
        content,
        featuredImageUrl: featuredImageUrl || undefined,
        category: category || undefined,
        callToAction: callToAction || undefined,
      })

      if (result.success) {
        setSuccessMessage("Saved successfully")
        setTimeout(() => setSuccessMessage(null), 3000)
      } else {
        setError(result.error || "Failed to save")
      }
    } catch (err) {
      console.error("[BlogEditor] Save error:", err)
      setError("An unexpected error occurred")
    } finally {
      setIsSaving(false)
    }
  }

  const handleStatusChange = async (newStatus: string) => {
    setIsSaving(true)
    setError(null)

    try {
      const result = await updateBlogPost(userId, post.id, {
        publishStatus: newStatus as "draft" | "pending_review" | "approved" | "published",
      })

      if (result.success) {
        setPublishStatus(newStatus)
        setSuccessMessage(`Status updated to ${newStatus.replace("_", " ")}`)
        setTimeout(() => setSuccessMessage(null), 3000)
      } else {
        setError(result.error || "Failed to update status")
      }
    } catch (err) {
      console.error("[BlogEditor] Status change error:", err)
      setError("An unexpected error occurred")
    } finally {
      setIsSaving(false)
    }
  }

  // Load the score trend once on mount, and again after every re-analysis.
  const refreshSeoHistory = async () => {
    const h = await getSeoScoreHistory(post.id).catch(() => null)
    if (h?.success && h.history) {
      setSeoHistory(h.history.map((e) => ({ score: e.score, optimized_at: e.optimized_at })))
    }
  }

  useEffect(() => {
    void refreshSeoHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id])

  const handleAnalyzeSEO = async () => {
    setIsAnalyzing(true)
    setError(null)

    try {
      // Save first to ensure latest content is analyzed
      await updateBlogPost(userId, post.id, {
        title,
        slug,
        excerpt,
        content,
      })

      const result = await analyzeSEO(post.id, brokerageId)

      if (result.success && result.result) {
        setSeoScore(result.result.score)
        setSeoIssues(result.result.issues)
        setSeoRecommendations(result.result.recommendations)
        setSuccessMessage("SEO analysis complete")
        setTimeout(() => setSuccessMessage(null), 3000)
        void refreshSeoHistory()
      } else {
        setError(result.error || "Failed to analyze SEO")
      }
    } catch (err) {
      console.error("[BlogEditor] SEO analysis error:", err)
      setError("An unexpected error occurred")
    } finally {
      setIsAnalyzing(false)
    }
  }

  const handlePublishToWordPress = async () => {
    setIsPublishing(true)
    setError(null)

    try {
      const result = await publishToWordPress(userId, post.id)

      if (result.success) {
        setWordpressPostId(result.wordpressPostId || null)
        setPublishStatus("published")
        setSuccessMessage("Published to WordPress successfully")
        setTimeout(() => setSuccessMessage(null), 3000)
      } else {
        setError(result.error || "Failed to publish to WordPress")
      }
    } catch (err) {
      console.error("[BlogEditor] WordPress publish error:", err)
      setError("An unexpected error occurred")
    } finally {
      setIsPublishing(false)
    }
  }

  const handleSuggestKeywords = async () => {
    if (!title.trim()) {
      setError("Please enter a title before suggesting keywords")
      return
    }
    setIsSuggestingKeywords(true)
    setError(null)

    try {
      const result = await suggestSEOKeywords({ title, content: content || undefined })
      if (result.success && result.keywords) {
        setSuggestedKeywords(result.keywords)
        setSuccessMessage("SEO keyword suggestions generated")
        setTimeout(() => setSuccessMessage(null), 3000)
      } else {
        setError(result.error || "Failed to suggest keywords")
      }
    } catch (err) {
      console.error("[BlogEditor] Keyword suggest error:", err)
      setError("An unexpected error occurred")
    } finally {
      setIsSuggestingKeywords(false)
    }
  }

  const handleAutoSlug = () => {
    const generatedSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 80)
    setSlug(generatedSlug)
  }

  async function handlePostToSocial(body: string, key: string) {
    setSendingKey(key)
    try {
      const result = await createSocialPost({
        content: body,
        scheduledFor: new Date().toISOString(),
        platforms: ["facebook", "instagram"],
        contentType: "custom",
        generatedByAi: true,
        userId,
      })
      if (result && (result as any).success === false) {
        // Both refusals now carry their own reason — a compliance hold, or "no
        // connected account for this platform". Show the server's own words
        // rather than a generic failure.
        const msg =
          (result as any).message ??
          ((result as any).complianceBlocked ? "Post held for compliance review" : "Failed to queue social post")
        toast.error(msg)
      } else {
        const platforms: string[] = (result as any)?.scheduledPlatforms ?? []
        toast.success(
          platforms.length > 0
            ? `Queued for ${platforms.join(", ")} — check Social dashboard`
            : "Queued for social — check Social dashboard",
        )
      }
    } finally {
      setSendingKey(null)
    }
  }

  async function handleSaveAsEmailCampaign(body: string, key: string) {
    setSendingKey(key)
    try {
      const result = await createEmailCampaign({
        brokerageId,
        agentId: userId,
        campaignName: `Blog: ${title || "Untitled"}`,
        subjectLine: title || "Newsletter",
        content: body,
        createdBy: userId,
      })
      if (result.success) {
        toast.success("Saved as email campaign draft")
      } else {
        toast.error("Failed to save campaign")
      }
    } finally {
      setSendingKey(null)
    }
  }

  const handleRepurpose = async () => {
    if (!content) { toast.error("No content to repurpose"); return }
    setRepurposeLoading(true)
    try {
      const result = await generateOmnipresent({
        agent_id: userId,
        core_idea: title || content.slice(0, 200),
        formats: ["social_post", "newsletter", "blog"],
      })
      if (result.success && result.contents) {
        setRepurposeResults(result.contents.map((c: any, i: number) => ({
          format: (["Social Post", "Newsletter Email", "Short Blog"] as const)[i] ?? `Variation ${i + 1}`,
          body: c.body ?? c.content ?? c.script ?? "",
        })))
        toast.success("Content repurposed")
      } else {
        toast.error("Could not repurpose content")
      }
    } finally {
      setRepurposeLoading(false)
    }
  }

  const handleVariations = async () => {
    if (!content) { toast.error("Write some content first"); return }
    setVariationsLoading(true)
    try {
      const result = await generateVariations({
        agent_id: userId,
        content_type: "social_post",
        custom_prompt: title,
        variation_count: 3,
      })
      if (result.success && result.contents) {
        setVariations(result.contents.map((c: any) => ({ body: c.body ?? c.content ?? "" })))
        toast.success("3 variations generated")
      } else {
        toast.error("Could not generate variations")
      }
    } finally {
      setVariationsLoading(false)
    }
  }

  const currentStepIndex = statusSteps.indexOf(publishStatus)

  const getNextAction = () => {
    switch (publishStatus) {
      case "draft":
        return { label: "Submit for Review", status: "pending_review" }
      case "pending_review":
        return { label: "Approve", status: "approved" }
      case "approved":
        return { label: "Publish", status: "published" }
      default:
        return null
    }
  }

  const nextAction = getNextAction()
  const displayScore = seoScore !== null ? seoScore : localSeoScore

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard/marketing/blog")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Edit Blog Post</h1>
            <p className="text-sm text-muted-foreground">
              Created {format(new Date(post.created_at), "MMM d, yyyy")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Status badge */}
          <Badge className={STATUS_COLORS[publishStatus] || ""}>
            {publishStatus.replace(/_/g, " ")}
          </Badge>

          <Button variant="outline" size="sm" onClick={handleRepurpose} disabled={repurposeLoading}>
            {repurposeLoading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Share2 className="h-4 w-4 mr-1.5" />}
            Repurpose
          </Button>
          <Button variant="outline" size="sm" onClick={handleVariations} disabled={variationsLoading}>
            {variationsLoading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Layers className="h-4 w-4 mr-1.5" />}
            Variations
          </Button>
          <Button variant="outline" onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save
          </Button>
          {nextAction && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={isSaving}>
                  {publishStatus === "approved" ? (
                    <Globe className="h-4 w-4 mr-2" />
                  ) : publishStatus === "pending_review" ? (
                    <CheckCircle className="h-4 w-4 mr-2" />
                  ) : (
                    <Send className="h-4 w-4 mr-2" />
                  )}
                  {nextAction.label}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{nextAction.label}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {publishStatus === "draft" &&
                      "This will submit the post for review. Are you sure?"}
                    {publishStatus === "pending_review" &&
                      "This will approve the post. Make sure all content meets brand guidelines."}
                    {publishStatus === "approved" &&
                      "This will publish the post and make it publicly visible."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => handleStatusChange(nextAction.status)}>
                    Continue
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-center justify-between">
          <span>{error}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setError(null)}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
      {successMessage && (
        <div className="mb-4 p-3 rounded-md bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 text-sm">
          {successMessage}
        </div>
      )}

      {/* Progress Steps */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          {statusSteps.map((step, index) => (
            <div key={step} className="flex items-center flex-1">
              <div className="flex flex-col items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    index <= currentStepIndex
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {index + 1}
                </div>
                <span className="text-xs mt-1 capitalize">{step.replace(/_/g, " ")}</span>
              </div>
              {index < statusSteps.length - 1 && (
                <div
                  className={`flex-1 h-1 mx-2 ${
                    index < currentStepIndex ? "bg-primary" : "bg-muted"
                  }`}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Stats Bar */}
      <div className="flex flex-wrap gap-4 mb-6 p-3 rounded-lg bg-muted/30 border">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <BookOpen className="h-4 w-4" />
          <span>{wordCount} words</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="h-4 w-4" />
          <span>{readTime} min read</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <TrendingUp className="h-4 w-4" />
          <span className={
            displayScore >= 80
              ? "text-green-600 dark:text-green-400 font-medium"
              : displayScore >= 60
                ? "text-amber-600 dark:text-amber-400 font-medium"
                : "text-red-600 dark:text-red-400 font-medium"
          }>
            SEO {displayScore}/100{seoScore === null ? " (live preview)" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{excerpt.length}/160 meta chars</span>
        </div>
      </div>

      {/* Repurpose results panel */}
      {repurposeResults && (
        <Card className="mb-4 border-purple-200">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Share2 className="h-4 w-4 text-purple-600" />
              Repurposed Content
            </CardTitle>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setRepurposeResults(null)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {repurposeResults.map((r, i) => {
                const key = `repurpose-${i}`
                const isSending = sendingKey === key
                const isSocial = r.format.toLowerCase().includes("social")
                const isNewsletter = r.format.toLowerCase().includes("newsletter") || r.format.toLowerCase().includes("email")
                return (
                  <div key={i} className="rounded-lg border bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-foreground">{r.format}</p>
                      <button
                        onClick={() => { navigator.clipboard.writeText(r.body); toast.success("Copied") }}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-5">{r.body}</p>
                    {isSocial && (
                      <Button size="sm" variant="outline" className="w-full h-7 text-xs"
                        disabled={isSending}
                        onClick={() => handlePostToSocial(r.body, key)}
                      >
                        {isSending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                        Post to Social
                      </Button>
                    )}
                    {isNewsletter && (
                      <Button size="sm" variant="outline" className="w-full h-7 text-xs"
                        disabled={isSending}
                        onClick={() => handleSaveAsEmailCampaign(r.body, key)}
                      >
                        {isSending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                        Save as Campaign
                      </Button>
                    )}
                    {!isSocial && !isNewsletter && (
                      <Button size="sm" variant="outline" className="w-full h-7 text-xs"
                        onClick={() => { setContent(r.body); toast.success("Content updated") }}
                      >
                        Use as Content
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Variations panel */}
      {variations && (
        <Card className="mb-4 border-indigo-200">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Layers className="h-4 w-4 text-indigo-600" />
              Social Post Variations
            </CardTitle>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setVariations(null)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {variations.map((v, i) => {
                const key = `variation-${i}`
                const isSending = sendingKey === key
                return (
                  <div key={i} className="rounded-lg border bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-foreground">Variation {i + 1}</p>
                      <button
                        onClick={() => { navigator.clipboard.writeText(v.body); toast.success("Copied") }}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">{v.body}</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="flex-1 h-7 text-xs"
                        onClick={() => { setContent(v.body); toast.success("Draft updated") }}
                      >
                        Use This
                      </Button>
                      <Button size="sm" variant="outline" className="flex-1 h-7 text-xs"
                        disabled={isSending}
                        onClick={() => handlePostToSocial(v.body, key)}
                      >
                        {isSending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                        Post Now
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Editor */}
        <div className="lg:col-span-2 space-y-6">
          {/* Core Content */}
          <Card>
            <CardHeader>
              <CardTitle>Content</CardTitle>
              <CardDescription>Write or edit your blog post content</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Title */}
              <div className="space-y-2">
                <Label htmlFor="title">Title *</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Blog post title"
                />
              </div>

              {/* Slug */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="slug">URL Slug</Label>
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleAutoSlug}>
                    Auto-generate
                  </Button>
                </div>
                <Input
                  id="slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="blog-post-slug"
                />
              </div>

              {/* Meta Description */}
              <div className="space-y-2">
                <Label htmlFor="excerpt">Meta Description</Label>
                <Textarea
                  id="excerpt"
                  value={excerpt}
                  onChange={(e) => setExcerpt(e.target.value)}
                  placeholder="Brief description for search engines (max 160 characters)"
                  rows={2}
                />
                <p className={`text-xs ${excerpt.length > 160 ? "text-destructive" : "text-muted-foreground"}`}>
                  {excerpt.length}/160 characters
                  {excerpt.length > 160 && " — exceeds recommended length"}
                </p>
              </div>

              {/* Category */}
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger id="category">
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Hero Image URL */}
              <div className="space-y-2">
                <Label htmlFor="featuredImage">Hero Image URL</Label>
                <Input
                  id="featuredImage"
                  value={featuredImageUrl}
                  onChange={(e) => setFeaturedImageUrl(e.target.value)}
                  placeholder="https://..."
                />
                {featuredImageUrl && !imageLoadError && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={featuredImageUrl}
                    alt="Hero preview"
                    className="w-full h-32 object-cover rounded-md border"
                    onError={() => setImageLoadError(true)}
                  />
                )}
              </div>
            </CardContent>
          </Card>

          {/* Body Content */}
          <Card>
            <CardHeader>
              <CardTitle>Body Content</CardTitle>
              <CardDescription>
                Supports HTML tags (h2, h3, p, ul, li, strong, em). Use headings for better SEO.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                id="content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={`<h2>Introduction</h2>\n<p>Your blog post content here...</p>\n\n<h2>Key Points</h2>\n<p>Expand on your main topic...</p>\n\n<h2>Conclusion</h2>\n<p>Wrap up your post...</p>`}
                rows={22}
                className="font-mono text-sm"
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{wordCount} words</span>
                <span className={wordCount >= 600 ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}>
                  {wordCount >= 600 ? "Good length" : `${600 - wordCount} more words for optimal SEO`}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Call-to-Action */}
          <Card>
            <CardHeader>
              <CardTitle>Call-to-Action</CardTitle>
              <CardDescription>
                The action you want readers to take after reading this post
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                id="callToAction"
                value={callToAction}
                onChange={(e) => setCallToAction(e.target.value)}
                placeholder="e.g., Ready to find your dream home? Contact us today for a free consultation."
                rows={3}
              />
              <p className="text-xs text-muted-foreground mt-2">
                Add this at the end of your content to drive engagement.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Right Panel */}
        <div className="space-y-6">
          {/* SEO Score */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" />
                  SEO Score
                </CardTitle>
                <Button variant="outline" size="sm" onClick={handleAnalyzeSEO} disabled={isAnalyzing}>
                  {isAnalyzing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <CardDescription>
                {seoScore !== null ? "Last saved score" : "Live preview (save to get full score)"}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-3">
              <SeoScoreCircle score={displayScore} />
              <div className="text-center">
                <p className="text-sm font-medium">
                  {displayScore >= 80
                    ? "Excellent"
                    : displayScore >= 60
                      ? "Good — room to improve"
                      : "Needs work"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Target: 80+ for best search ranking
                </p>
              </div>

              {/* Score trend — the last 10 recorded analyses for this post.
                  Empty until the post has been analyzed at least once. */}
              {seoHistory.length > 1 && (
                <div className="w-full pt-3 border-t">
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Score history
                  </p>
                  <ul className="space-y-1">
                    {seoHistory.map((entry, i) => {
                      const prev = seoHistory[i + 1]
                      const delta = prev ? entry.score - prev.score : null
                      return (
                        <li
                          key={`${entry.optimized_at}-${i}`}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-muted-foreground">
                            {new Date(entry.optimized_at).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </span>
                          <span className="flex items-center gap-1.5 font-medium">
                            {entry.score}
                            {delta !== null && delta !== 0 && (
                              <span
                                className={
                                  delta > 0 ? "text-green-600" : "text-red-600"
                                }
                              >
                                {delta > 0 ? `+${delta}` : delta}
                              </span>
                            )}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          {/* AI SEO Keyword Suggestions */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Tag className="h-5 w-5" />
                  SEO Keywords
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSuggestKeywords}
                  disabled={isSuggestingKeywords || !title.trim()}
                >
                  {isSuggestingKeywords ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <CardDescription>
                AI-suggested keywords for this post
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Linked keywords */}
              {post.keywords.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Linked keywords</p>
                  <div className="flex flex-wrap gap-1.5">
                    {post.keywords.map((kw) => (
                      <Badge key={kw.id} variant={kw.is_primary ? "default" : "outline"} className="text-xs">
                        {kw.keyword}
                        {kw.is_primary && " ★"}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* AI suggestions */}
              {suggestedKeywords.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">AI suggestions</p>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestedKeywords.map((kw, i) => (
                      <Badge
                        key={i}
                        variant="outline"
                        className={`text-xs ${
                          kw.type === "primary"
                            ? "border-blue-400 text-blue-700 dark:text-blue-300"
                            : kw.type === "long_tail"
                              ? "border-purple-400 text-purple-700 dark:text-purple-300"
                              : ""
                        }`}
                      >
                        {kw.keyword}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Blue = primary, purple = long-tail
                  </p>
                </div>
              )}

              {post.keywords.length === 0 && suggestedKeywords.length === 0 && (
                <div className="text-center py-3">
                  <p className="text-sm text-muted-foreground mb-2">No keywords yet</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSuggestKeywords}
                    disabled={isSuggestingKeywords || !title.trim()}
                    className="w-full"
                  >
                    <Sparkles className="h-4 w-4 mr-2" />
                    Suggest SEO Keywords
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* SEO Issues */}
          {seoIssues.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-5 w-5" />
                  Issues ({seoIssues.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {seoIssues.map((issue, index) => (
                    <li key={index} className="text-sm text-muted-foreground flex items-start gap-2">
                      <span className="text-amber-600 dark:text-amber-400 mt-0.5">•</span>
                      {issue}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* SEO Recommendations */}
          {seoRecommendations.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Lightbulb className="h-5 w-5" />
                  Recommendations
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {seoRecommendations.map((rec, index) => (
                    <li key={index} className="text-sm text-muted-foreground flex items-start gap-2">
                      <span className="text-primary mt-0.5">•</span>
                      {rec}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* WordPress */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="h-5 w-5" />
                WordPress
              </CardTitle>
            </CardHeader>
            <CardContent>
              {wordpressPostId ? (
                <div className="space-y-2">
                  <p className="text-sm text-green-600 dark:text-green-400 font-medium flex items-center gap-1">
                    <CheckCircle className="h-4 w-4" />
                    Published to WordPress
                  </p>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-mono bg-muted px-2 py-1 rounded text-xs">
                      Post ID: {wordpressPostId}
                    </span>
                    <ExternalLink className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {publishStatus === "approved" ? (
                    <Button
                      className="w-full"
                      onClick={handlePublishToWordPress}
                      disabled={isPublishing}
                    >
                      {isPublishing ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Globe className="h-4 w-4 mr-2" />
                      )}
                      Publish to WordPress
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Post must be approved before publishing to WordPress
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
