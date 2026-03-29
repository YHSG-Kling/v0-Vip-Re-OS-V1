"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
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
} from "lucide-react"
import { updateBlogPost, publishToWordPress } from "@/app/actions/blog"
import { analyzeSEO } from "@/lib/blog/seo-optimizer"
import { format } from "date-fns"

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

export function BlogEditorClient({ userId, brokerageId, post }: BlogEditorClientProps) {
  const router = useRouter()

  // Form state
  const [title, setTitle] = useState(post.title)
  const [slug, setSlug] = useState(post.slug)
  const [excerpt, setExcerpt] = useState(post.excerpt || "")
  const [content, setContent] = useState(post.content || "")
  const [featuredImageUrl, setFeaturedImageUrl] = useState(post.featured_image_url || "")
  const [publishStatus, setPublishStatus] = useState(post.publish_status)
  const [seoScore, setSeoScore] = useState(post.seo_score)
  const [seoIssues, setSeoIssues] = useState(post.latestSeoLog?.issues || [])
  const [seoRecommendations, setSeoRecommendations] = useState(
    post.latestSeoLog?.recommendations || []
  )
  const [wordpressPostId, setWordpressPostId] = useState(post.wordpress_post_id)

  // Loading states
  const [isSaving, setIsSaving] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

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
          <Button variant="outline" onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save Draft
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
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {error}
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
                <span className="text-xs mt-1 capitalize">{step.replace("_", " ")}</span>
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Editor */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Content</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Blog post title"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="slug">URL Slug</Label>
                <Input
                  id="slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="blog-post-slug"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="excerpt">Excerpt / Meta Description</Label>
                <Textarea
                  id="excerpt"
                  value={excerpt}
                  onChange={(e) => setExcerpt(e.target.value)}
                  placeholder="Brief description (max 160 characters)"
                  rows={2}
                />
                <p className="text-xs text-muted-foreground">
                  {excerpt.length}/160 characters
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="content">Content</Label>
                <Textarea
                  id="content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Blog post content (supports HTML)"
                  rows={20}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  {content.split(/\s+/).filter((w) => w.length > 0).length} words
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="featuredImage">Featured Image URL</Label>
                <Input
                  id="featuredImage"
                  value={featuredImageUrl}
                  onChange={(e) => setFeaturedImageUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* SEO Panel */}
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
            </CardHeader>
            <CardContent className="flex flex-col items-center">
              {seoScore !== null ? (
                <SeoScoreCircle score={seoScore} />
              ) : (
                <div className="text-center py-4">
                  <p className="text-muted-foreground text-sm">No SEO analysis yet</p>
                  <Button variant="link" onClick={handleAnalyzeSEO} disabled={isAnalyzing}>
                    Run Analysis
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Issues */}
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
                      <span className="text-amber-600 dark:text-amber-400">-</span>
                      {issue}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Recommendations */}
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
                      <span className="text-primary">-</span>
                      {rec}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Keywords */}
          <Card>
            <CardHeader>
              <CardTitle>Keywords</CardTitle>
              <CardDescription>Linked SEO keywords</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {post.keywords.map((kw) => (
                  <Badge key={kw.id} variant={kw.is_primary ? "default" : "outline"}>
                    {kw.keyword}
                    {kw.is_primary && " (primary)"}
                  </Badge>
                ))}
                {post.keywords.length === 0 && (
                  <p className="text-sm text-muted-foreground">No keywords linked</p>
                )}
              </div>
            </CardContent>
          </Card>

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
                  <p className="text-sm text-muted-foreground">
                    Published to WordPress
                  </p>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-mono bg-muted px-2 py-1 rounded">
                      ID: {wordpressPostId}
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
