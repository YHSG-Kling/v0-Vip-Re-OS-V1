"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Textarea } from "@/app/components/ui/textarea"
import { Badge } from "@/app/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
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
} from "@/app/components/ui/alert-dialog"
import { Separator } from "@/app/components/ui/separator"
import {
  ArrowLeft,
  Save,
  Globe,
  TrendingUp,
  Tag,
  CheckCircle,
  AlertCircle,
  Loader2,
  FileText,
  ExternalLink,
} from "lucide-react"
import { updateBlogPost, publishToWordPress } from "@/app/actions/blog"
import { toast } from "sonner"
import { format } from "date-fns"

interface Keyword {
  id: string
  keyword: string
  is_primary: boolean
}

interface SeoLog {
  score: number
  issues: string[]
  recommendations: string[]
}

interface BlogPost {
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
  keywords: Keyword[]
  latestSeoLog: SeoLog | null
}

interface BlogPostEditorProps {
  post: BlogPost
  userId: string
}

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "pending_review", label: "Pending Review" },
  { value: "approved", label: "Approved" },
  { value: "published", label: "Published" },
  { value: "rejected", label: "Rejected" },
] as const

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  pending_review: "bg-amber-100 text-amber-800",
  approved: "bg-blue-100 text-blue-800",
  published: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
}

function SeoScoreDisplay({ score, log }: { score: number | null; log: SeoLog | null }) {
  if (score === null) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <TrendingUp className="h-4 w-4" />
        <span className="text-sm">No SEO score yet</span>
      </div>
    )
  }

  const color =
    score >= 80 ? "text-green-600" : score >= 60 ? "text-amber-600" : "text-red-600"
  const bgColor =
    score >= 80
      ? "bg-green-50 border-green-200"
      : score >= 60
        ? "bg-amber-50 border-amber-200"
        : "bg-red-50 border-red-200"

  return (
    <div className={`rounded-lg border p-4 space-y-3 ${bgColor}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className={`h-5 w-5 ${color}`} />
          <span className="font-semibold text-sm">SEO Score</span>
        </div>
        <span className={`text-2xl font-bold ${color}`}>{score}/100</span>
      </div>

      {log && log.issues.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Issues</p>
          {log.issues.slice(0, 3).map((issue, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs">
              <AlertCircle className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
              <span>{issue}</span>
            </div>
          ))}
        </div>
      )}

      {log && log.recommendations.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Recommendations
          </p>
          {log.recommendations.slice(0, 3).map((rec, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs">
              <CheckCircle className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
              <span>{rec}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function BlogPostEditor({ post, userId }: BlogPostEditorProps) {
  const router = useRouter()

  const [title, setTitle] = useState(post.title)
  const [slug, setSlug] = useState(post.slug)
  const [excerpt, setExcerpt] = useState(post.excerpt || "")
  const [content, setContent] = useState(post.content || "")
  const [publishStatus, setPublishStatus] = useState(post.publish_status)
  const [isSaving, setIsSaving] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isDirty, setIsDirty] = useState(false)

  function markDirty() {
    if (!isDirty) setIsDirty(true)
  }

  async function handleSave() {
    setIsSaving(true)
    try {
      const result = await updateBlogPost(userId, post.id, {
        title,
        slug,
        excerpt,
        content,
        publishStatus: publishStatus as "draft" | "pending_review" | "approved" | "published" | "rejected",
      })

      if (result.success) {
        toast.success("Blog post saved")
        setIsDirty(false)
        router.refresh()
      } else {
        toast.error(result.error || "Failed to save")
      }
    } catch {
      toast.error("Save failed")
    } finally {
      setIsSaving(false)
    }
  }

  async function handlePublishToWordPress() {
    setIsPublishing(true)
    try {
      const result = await publishToWordPress(userId, post.id)
      if (result.success) {
        toast.success("Published to WordPress")
        router.refresh()
      } else {
        toast.error(result.error || "WordPress publish failed")
      }
    } catch {
      toast.error("WordPress publish failed")
    } finally {
      setIsPublishing(false)
    }
  }

  const wordCount = content.split(/\s+/).filter(Boolean).length
  const isPublishedToWP = !!post.wordpress_post_id
  const canPublishToWP = publishStatus === "approved" || publishStatus === "published"

  return (
    <div className="min-h-screen bg-background">
      {/* Sticky header bar */}
      <div className="sticky top-0 z-10 bg-background border-b">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push("/dashboard/marketing/blog")}
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
            <Separator orientation="vertical" className="h-5" />
            <h1 className="text-sm font-medium truncate text-muted-foreground">
              {title || "Untitled Post"}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Badge className={STATUS_COLORS[publishStatus] || ""}>
              {STATUS_OPTIONS.find((s) => s.value === publishStatus)?.label || publishStatus}
            </Badge>
            {isDirty && (
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-1.5" />
              )}
              Save
            </Button>
            {canPublishToWP && !isPublishedToWP && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" disabled={isPublishing}>
                    {isPublishing ? (
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    ) : (
                      <Globe className="h-4 w-4 mr-1.5" />
                    )}
                    Publish to WordPress
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Publish to WordPress?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will publish &quot;{title}&quot; to your connected WordPress site. Make
                      sure all content is approved before proceeding.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handlePublishToWordPress}>Publish</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {isPublishedToWP && (
              <Badge className="bg-green-100 text-green-800 gap-1">
                <Globe className="h-3 w-3" />
                On WordPress
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Editor column */}
          <div className="lg:col-span-2 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => { setTitle(e.target.value); markDirty() }}
                placeholder="Blog post title"
                className="text-lg font-medium h-12"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">
                URL Slug
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  yoursite.com/blog/<span className="text-foreground">{slug}</span>
                </span>
              </Label>
              <Input
                id="slug"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))
                  markDirty()
                }}
                placeholder="my-blog-post-slug"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="excerpt">
                Excerpt / Meta Description
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  {excerpt.length}/160 chars
                </span>
              </Label>
              <Textarea
                id="excerpt"
                value={excerpt}
                onChange={(e) => { setExcerpt(e.target.value); markDirty() }}
                placeholder="A brief description for search results and previews..."
                rows={3}
                maxLength={160}
                className={excerpt.length > 155 ? "border-amber-400" : ""}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="content">Content</Label>
                <span className="text-xs text-muted-foreground">
                  {wordCount} words
                  {wordCount > 0 && wordCount < 600 && (
                    <span className="ml-1 text-amber-600">(aim for 600+)</span>
                  )}
                  {wordCount >= 600 && (
                    <span className="ml-1 text-green-600"> — good length</span>
                  )}
                </span>
              </div>
              <Textarea
                id="content"
                value={content}
                onChange={(e) => { setContent(e.target.value); markDirty() }}
                placeholder="Full blog post content (HTML supported)..."
                rows={28}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                HTML is supported. Use &lt;h2&gt;, &lt;h3&gt; for headings, &lt;p&gt; for paragraphs.
              </p>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-5">
            {/* Publish settings */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Publish Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select
                    value={publishStatus}
                    onValueChange={(v) => { setPublishStatus(v); markDirty() }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="text-xs text-muted-foreground space-y-1">
                  <div className="flex justify-between">
                    <span>Created</span>
                    <span>{format(new Date(post.created_at), "MMM d, yyyy")}</span>
                  </div>
                  {post.published_at && (
                    <div className="flex justify-between">
                      <span>Published</span>
                      <span>{format(new Date(post.published_at), "MMM d, yyyy")}</span>
                    </div>
                  )}
                  {post.wordpress_post_id && (
                    <div className="flex justify-between items-center">
                      <span>WordPress ID</span>
                      <span className="font-mono">#{post.wordpress_post_id}</span>
                    </div>
                  )}
                </div>

                <Button
                  className="w-full"
                  onClick={handleSave}
                  disabled={isSaving || !isDirty}
                  variant={isDirty ? "default" : "outline"}
                >
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  {isDirty ? "Save Changes" : "Saved"}
                </Button>
              </CardContent>
            </Card>

            {/* SEO score */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">SEO Analysis</CardTitle>
                <CardDescription className="text-xs">
                  AI-powered SEO evaluation
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SeoScoreDisplay score={post.seo_score} log={post.latestSeoLog} />
              </CardContent>
            </Card>

            {/* Keywords */}
            {post.keywords.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Tag className="h-4 w-4" />
                    Keywords
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {post.keywords.map((kw) => (
                      <Badge
                        key={kw.id}
                        variant={kw.is_primary ? "default" : "outline"}
                        className="text-xs"
                      >
                        {kw.keyword}
                        {kw.is_primary && (
                          <span className="ml-1 opacity-60">(primary)</span>
                        )}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* WordPress */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Globe className="h-4 w-4" />
                  WordPress
                </CardTitle>
                <CardDescription className="text-xs">
                  Publish to your connected WordPress site
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isPublishedToWP ? (
                  <div className="flex items-center gap-2 text-green-600 text-sm">
                    <CheckCircle className="h-4 w-4" />
                    <span>Published (ID #{post.wordpress_post_id})</span>
                  </div>
                ) : canPublishToWP ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" className="w-full" size="sm" disabled={isPublishing}>
                        {isPublishing ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <ExternalLink className="h-4 w-4 mr-2" />
                        )}
                        Publish to WordPress
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Publish to WordPress?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will publish &quot;{title}&quot; to your connected WordPress site.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handlePublishToWordPress}>
                          Publish
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : (
                  <div className="flex items-start gap-2 text-muted-foreground text-sm">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>
                      Set status to &quot;Approved&quot; or &quot;Published&quot; before pushing to
                      WordPress.
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Content stats */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Content Stats
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2 text-muted-foreground">
                <div className="flex justify-between">
                  <span>Word count</span>
                  <span
                    className={
                      wordCount >= 600 ? "text-green-600 font-medium" : "text-amber-600"
                    }
                  >
                    {wordCount}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Characters</span>
                  <span>{content.length.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>Excerpt length</span>
                  <span
                    className={excerpt.length > 155 ? "text-amber-600" : "text-green-600"}
                  >
                    {excerpt.length}/160
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Keywords linked</span>
                  <span>{post.keywords.length}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
