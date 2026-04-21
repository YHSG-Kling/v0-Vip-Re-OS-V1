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
  BookOpen,
  Eye,
  PenLine,
  Lightbulb,
  X,
} from "lucide-react"
import { generateBlogPost, generateTopicIdeas, saveBlogPost } from "@/app/actions/blog"
import type { TopicIdea } from "@/app/actions/blog"
import { format } from "date-fns"

interface BlogPost {
  id: string
  title: string
  slug: string
  excerpt: string
  publish_status: string
  category?: string | null
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

const CATEGORIES = [
  "All",
  "Market Update",
  "Buyer Tips",
  "Seller Tips",
  "Neighborhood Guide",
  "Investment Tips",
  "Company News",
]

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
  const [categoryFilter, setCategoryFilter] = useState<string>("All")
  const [isGenerateOpen, setIsGenerateOpen] = useState(false)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isTopicsOpen, setIsTopicsOpen] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [isLoadingTopics, setIsLoadingTopics] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [topicIdeas, setTopicIdeas] = useState<TopicIdea[]>([])
  const [topicError, setTopicError] = useState<string | null>(null)

  // Generate form state
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([])
  const [customTitle, setCustomTitle] = useState("")
  const [tone, setTone] = useState("professional")

  // Manual create form state
  const [newTitle, setNewTitle] = useState("")
  const [newCategory, setNewCategory] = useState("")

  // Stats
  const totalPosts = posts.length
  const publishedPosts = posts.filter((p) => p.publish_status === "published").length
  const draftPosts = posts.filter((p) => p.publish_status === "draft").length
  const avgWordsPerPost = 800 // industry estimate for generated posts
  const estimatedMonthlyReaders = publishedPosts * 150 // rough estimate: 150 readers/post/month

  // Filter posts
  const filteredPosts = posts.filter((post) => {
    const matchesSearch =
      post.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      post.excerpt?.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesStatus = statusFilter === "all" || post.publish_status === statusFilter
    const matchesCategory =
      !categoryFilter || categoryFilter === "All" || post.category === categoryFilter
    return matchesSearch && matchesStatus && matchesCategory
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

  const handleCreateBlankPost = async () => {
    if (!newTitle.trim()) {
      setCreateError("Please enter a title")
      return
    }
    setIsCreating(true)
    setCreateError(null)

    try {
      const result = await saveBlogPost({
        title: newTitle.trim(),
        category: newCategory || undefined,
        publishStatus: "draft",
      })

      if (result.success && result.postId) {
        setIsCreateOpen(false)
        setNewTitle("")
        setNewCategory("")
        router.push(`/dashboard/marketing/blog/${result.postId}`)
      } else {
        setCreateError(result.error || "Failed to create blog post")
      }
    } catch (err) {
      console.error("[BlogDashboard] Create error:", err)
      setCreateError("An unexpected error occurred")
    } finally {
      setIsCreating(false)
    }
  }

  const handleGenerateTopics = async () => {
    setIsLoadingTopics(true)
    setTopicError(null)

    try {
      const result = await generateTopicIdeas()
      if (result.success && result.ideas) {
        setTopicIdeas(result.ideas)
      } else {
        setTopicError(result.error || "Failed to generate topic ideas")
      }
    } catch (err) {
      console.error("[BlogDashboard] Topic ideas error:", err)
      setTopicError("An unexpected error occurred")
    } finally {
      setIsLoadingTopics(false)
    }
  }

  const handleUseTopic = (idea: TopicIdea) => {
    setNewTitle(idea.title)
    setNewCategory(idea.category)
    setIsTopicsOpen(false)
    setIsCreateOpen(true)
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
              Generate and manage SEO-optimized blog content for your market
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* AI Topic Ideas */}
            <Dialog open={isTopicsOpen} onOpenChange={setIsTopicsOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" onClick={() => { setTopicIdeas([]); setTopicError(null) }}>
                  <Lightbulb className="h-4 w-4 mr-2" />
                  Topic Ideas
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Lightbulb className="h-5 w-5" />
                    AI Topic Ideas
                  </DialogTitle>
                  <DialogDescription>
                    Generate 5 SEO-rich blog topic suggestions based on your market
                  </DialogDescription>
                </DialogHeader>

                <div className="py-4 space-y-4">
                  {topicIdeas.length === 0 && !topicError && (
                    <div className="text-center py-6">
                      <p className="text-muted-foreground text-sm mb-4">
                        Click below to generate topic ideas tailored to your brokerage market.
                      </p>
                      <Button onClick={handleGenerateTopics} disabled={isLoadingTopics}>
                        {isLoadingTopics ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Generating...
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-4 w-4 mr-2" />
                            Generate Topic Ideas
                          </>
                        )}
                      </Button>
                    </div>
                  )}

                  {topicError && (
                    <p className="text-sm text-destructive">{topicError}</p>
                  )}

                  {topicIdeas.length > 0 && (
                    <div className="space-y-3">
                      {topicIdeas.map((idea, i) => (
                        <div key={i} className="border rounded-lg p-3 hover:bg-muted/30 transition-colors">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm leading-tight">{idea.title}</p>
                              <div className="flex items-center gap-2 mt-1.5">
                                <Badge variant="outline" className="text-xs">{idea.category}</Badge>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1.5">{idea.rationale}</p>
                              <div className="flex flex-wrap gap-1 mt-2">
                                {idea.keywords.map((kw, ki) => (
                                  <span key={ki} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                                    {kw}
                                  </span>
                                ))}
                              </div>
                            </div>
                            <Button size="sm" variant="outline" onClick={() => handleUseTopic(idea)} className="shrink-0">
                              Use
                            </Button>
                          </div>
                        </div>
                      ))}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleGenerateTopics}
                        disabled={isLoadingTopics}
                        className="w-full"
                      >
                        {isLoadingTopics ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshIcon />}
                        Regenerate
                      </Button>
                    </div>
                  )}
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsTopicsOpen(false)}>
                    Close
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* Create Blank Post */}
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <PenLine className="h-4 w-4 mr-2" />
                  Write Post
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <PenLine className="h-5 w-5" />
                    New Blog Post
                  </DialogTitle>
                  <DialogDescription>
                    Create a blank post and write it yourself
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="newTitle">Title *</Label>
                    <Input
                      id="newTitle"
                      placeholder="Enter a blog post title"
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="newCategory">Category (optional)</Label>
                    <Select value={newCategory} onValueChange={setNewCategory}>
                      <SelectTrigger id="newCategory">
                        <SelectValue placeholder="Select a category" />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.filter((c) => c !== "All").map((cat) => (
                          <SelectItem key={cat} value={cat}>
                            {cat}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {createError && (
                    <p className="text-sm text-destructive">{createError}</p>
                  )}
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreateBlankPost} disabled={isCreating || !newTitle.trim()}>
                    {isCreating ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      <>
                        <Plus className="h-4 w-4 mr-2" />
                        Create Post
                      </>
                    )}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* AI Generate Post */}
            <Dialog open={isGenerateOpen} onOpenChange={setIsGenerateOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Sparkles className="h-4 w-4 mr-2" />
                  AI Generate
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5" />
                    AI Generate Blog Post
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
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-md bg-primary/10">
                  <FileText className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{totalPosts}</p>
                  <p className="text-xs text-muted-foreground">Total Posts</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-md bg-green-100 dark:bg-green-900">
                  <Eye className="h-5 w-5 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{publishedPosts}</p>
                  <p className="text-xs text-muted-foreground">Published</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-md bg-muted">
                  <PenLine className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{draftPosts}</p>
                  <p className="text-xs text-muted-foreground">Drafts</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-md bg-blue-100 dark:bg-blue-900">
                  <BookOpen className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {estimatedMonthlyReaders > 999
                      ? `${Math.round(estimatedMonthlyReaders / 1000)}k`
                      : estimatedMonthlyReaders}
                  </p>
                  <p className="text-xs text-muted-foreground">Est. Monthly Readers</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Category Filter Tabs */}
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <Button
              key={cat}
              variant={categoryFilter === cat ? "default" : "outline"}
              size="sm"
              onClick={() => setCategoryFilter(cat)}
              className="h-8"
            >
              {cat}
            </Button>
          ))}
        </div>

        {/* Search + Status Filter */}
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
            <CardContent className="flex flex-col items-center justify-center py-16">
              <div className="p-4 rounded-full bg-primary/10 mb-4">
                <Sparkles className="h-10 w-10 text-primary" />
              </div>
              <h3 className="text-lg font-semibold mb-2">
                {searchQuery || statusFilter !== "all"
                  ? "No posts match your filters"
                  : "Create your first blog post"}
              </h3>
              <p className="text-muted-foreground text-sm text-center max-w-sm mb-6">
                {searchQuery || statusFilter !== "all"
                  ? "Try adjusting your search or filter to find what you're looking for."
                  : "AI will help you write SEO-optimized content in minutes — just pick some keywords and let it do the work."}
              </p>
              {!searchQuery && statusFilter === "all" && (
                <div className="flex flex-wrap gap-3 justify-center">
                  <Button onClick={() => setIsTopicsOpen(true)} variant="outline">
                    <Lightbulb className="h-4 w-4 mr-2" />
                    Get Topic Ideas
                  </Button>
                  <Button onClick={() => setIsGenerateOpen(true)}>
                    <Sparkles className="h-4 w-4 mr-2" />
                    AI Generate Post
                  </Button>
                </div>
              )}
              {(searchQuery || statusFilter !== "all") && (
                <Button
                  variant="outline"
                  onClick={() => { setSearchQuery(""); setStatusFilter("all") }}
                >
                  <X className="h-4 w-4 mr-2" />
                  Clear Filters
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
                    <Badge className={`shrink-0 ${statusColors[post.publish_status] || ""}`}>
                      {post.publish_status.replace(/_/g, " ")}
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

// Small inline refresh icon to avoid adding unused imports
function RefreshIcon() {
  return (
    <svg className="h-4 w-4 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  )
}
