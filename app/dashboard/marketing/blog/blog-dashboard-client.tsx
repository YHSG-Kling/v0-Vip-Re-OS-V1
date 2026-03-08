"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import {
  FileText,
  Plus,
  Search,
  Calendar,
  TrendingUp,
  Sparkles,
  Loader2,
  ExternalLink,
  Filter,
} from "lucide-react"
import { generateBlogPost } from "@/app/actions/blog"
import { format } from "date-fns"

interface BlogPost {
  id: string
  title: string
  slug: string
  excerpt: string
  publish_status: string
  seo_score: number | null
  created_at: string
  published_at: string | null
  agent_user_id: string | null
}

interface Keyword {
  id: string
  keyword: string
  keyword_type: string
  is_active: boolean
}

interface BlogDashboardClientProps {
  userId: string
  brokerageId: string
  initialPosts: BlogPost[]
  keywords: Keyword[]
}

const statusColors: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  pending_review: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  approved: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  published: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
}

function SeoScoreGauge({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <div className="flex items-center gap-1 text-muted-foreground text-sm">
        <TrendingUp className="h-4 w-4" />
        <span>--</span>
      </div>
    )
  }

  const getColor = () => {
    if (score >= 80) return "text-green-600 dark:text-green-400"
    if (score >= 60) return "text-amber-600 dark:text-amber-400"
    return "text-red-600 dark:text-red-400"
  }

  return (
    <div className={`flex items-center gap-1 font-medium ${getColor()}`}>
      <TrendingUp className="h-4 w-4" />
      <span>{score}/100</span>
    </div>
  )
}

export function BlogDashboardClient({
  userId,
  brokerageId,
  initialPosts,
  keywords,
}: BlogDashboardClientProps) {
  const router = useRouter()
  const [posts, setPosts] = useState<BlogPost[]>(initialPosts)
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [isGenerateOpen, setIsGenerateOpen] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  // Generate form state
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([])
  const [customTitle, setCustomTitle] = useState("")
  const [tone, setTone] = useState("professional")

  // Filter posts
  const filteredPosts = posts.filter((post) => {
    const matchesSearch =
      post.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      post.excerpt?.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesStatus = statusFilter === "all" || post.publish_status === statusFilter
    return matchesSearch && matchesStatus
  })

  const handleGenerateBlogPost = async () => {
    if (selectedKeywords.length === 0) {
      setGenerateError("Please select at least one keyword")
      return
    }

    setIsGenerating(true)
    setGenerateError(null)

    try {
      const keywordStrings = selectedKeywords
        .map((id) => keywords.find((k) => k.id === id)?.keyword)
        .filter(Boolean) as string[]

      const result = await generateBlogPost(userId, {
        brokerageId,
        keywords: keywordStrings,
        title: customTitle || undefined,
        tone,
      })

      if (result.success && result.postId) {
        setIsGenerateOpen(false)
        setSelectedKeywords([])
        setCustomTitle("")
        router.push(`/dashboard/marketing/blog/${result.postId}`)
      } else {
        setGenerateError(result.error || "Failed to generate blog post")
      }
    } catch (err) {
      console.error("[BlogDashboard] Generate error:", err)
      setGenerateError("An unexpected error occurred")
    } finally {
      setIsGenerating(false)
    }
  }

  const toggleKeyword = (keywordId: string) => {
    setSelectedKeywords((prev) =>
      prev.includes(keywordId) ? prev.filter((id) => id !== keywordId) : [...prev, keywordId]
    )
  }

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      <div className="flex flex-col gap-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Blog Posts</h1>
            <p className="text-muted-foreground">
              Generate and manage SEO-optimized blog content
            </p>
          </div>
          <Dialog open={isGenerateOpen} onOpenChange={setIsGenerateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Generate Blog Post
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5" />
                  Generate Blog Post
                </DialogTitle>
                <DialogDescription>
                  Select keywords and let AI generate an SEO-optimized blog post
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                {/* Keywords selection */}
                <div className="space-y-2">
                  <Label>Keywords (select 1-5)</Label>
                  <div className="border rounded-md p-3 max-h-48 overflow-y-auto space-y-2">
                    {keywords.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No keywords found.{" "}
                        <a href="/dashboard/marketing/seo" className="text-primary underline">
                          Add keywords first
                        </a>
                      </p>
                    ) : (
                      keywords.map((keyword) => (
                        <div key={keyword.id} className="flex items-center gap-2">
                          <Checkbox
                            id={keyword.id}
                            checked={selectedKeywords.includes(keyword.id)}
                            onCheckedChange={() => toggleKeyword(keyword.id)}
                            disabled={
                              selectedKeywords.length >= 5 &&
                              !selectedKeywords.includes(keyword.id)
                            }
                          />
                          <label
                            htmlFor={keyword.id}
                            className="text-sm flex items-center gap-2 cursor-pointer"
                          >
                            {keyword.keyword}
                            <Badge variant="outline" className="text-xs">
                              {keyword.keyword_type}
                            </Badge>
                          </label>
                        </div>
                      ))
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    First selected keyword will be treated as primary
                  </p>
                </div>

                {/* Custom title */}
                <div className="space-y-2">
                  <Label htmlFor="customTitle">Custom Title (optional)</Label>
                  <Input
                    id="customTitle"
                    placeholder="Leave blank to auto-generate"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                  />
                </div>

                {/* Tone */}
                <div className="space-y-2">
                  <Label>Tone</Label>
                  <Select value={tone} onValueChange={setTone}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="professional">Professional</SelectItem>
                      <SelectItem value="friendly">Friendly</SelectItem>
                      <SelectItem value="authoritative">Authoritative</SelectItem>
                      <SelectItem value="conversational">Conversational</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {generateError && (
                  <p className="text-sm text-destructive">{generateError}</p>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setIsGenerateOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleGenerateBlogPost} disabled={isGenerating}>
                  {isGenerating ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4 mr-2" />
                      Generate
                    </>
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search blog posts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="pending_review">Pending Review</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Posts Grid */}
        {filteredPosts.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No blog posts found</h3>
              <p className="text-muted-foreground text-sm mb-4">
                {searchQuery || statusFilter !== "all"
                  ? "Try adjusting your filters"
                  : "Generate your first blog post to get started"}
              </p>
              {!searchQuery && statusFilter === "all" && (
                <Button onClick={() => setIsGenerateOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Generate Blog Post
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredPosts.map((post) => (
              <Card
                key={post.id}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => router.push(`/dashboard/marketing/blog/${post.id}`)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base line-clamp-2">{post.title}</CardTitle>
                    <Badge className={statusColors[post.publish_status] || ""}>
                      {post.publish_status.replace("_", " ")}
                    </Badge>
                  </div>
                  <CardDescription className="line-clamp-2">{post.excerpt}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Calendar className="h-4 w-4" />
                      <span>{format(new Date(post.created_at), "MMM d, yyyy")}</span>
                    </div>
                    <SeoScoreGauge score={post.seo_score} />
                  </div>
                  {post.published_at && (
                    <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
                      <ExternalLink className="h-3 w-3" />
                      <span>Published {format(new Date(post.published_at), "MMM d, yyyy")}</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
