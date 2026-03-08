"use client"

// app/dashboard/social/social-dashboard-client.tsx
// Layer 9.2 Social Media Automation — Dashboard Client Component

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Calendar,
  Check,
  X,
  Clock,
  AlertCircle,
  MoreVertical,
  Eye,
  ThumbsUp,
  MessageCircle,
  Share2,
  TrendingUp,
  Plus,
  RefreshCw,
  ExternalLink,
  Image as ImageIcon,
} from "lucide-react"
import {
  scheduleSocialPost,
  approveSocialPost,
  rejectSocialPost,
  getSocialEngagement,
} from "@/app/actions/social-media-automation"
import { shareListingPost } from "@/app/actions/social-share"
import { predictPerformanceAction } from "@/app/actions/content-prediction"
import { PredictionWidget, type PredictionData } from "@/components/prediction-widget"
import { BarChart3 } from "lucide-react"

// Platform icons and colors
const PLATFORM_CONFIG: Record<
  string,
  { icon: string; color: string; bgColor: string }
> = {
  facebook: { icon: "f", color: "text-blue-600", bgColor: "bg-blue-100" },
  instagram: { icon: "ig", color: "text-pink-600", bgColor: "bg-pink-100" },
  linkedin: { icon: "in", color: "text-blue-700", bgColor: "bg-blue-100" },
  twitter: { icon: "x", color: "text-gray-900", bgColor: "bg-gray-100" },
  tiktok: { icon: "tt", color: "text-black", bgColor: "bg-gray-100" },
  youtube: { icon: "yt", color: "text-red-600", bgColor: "bg-red-100" },
  pinterest: { icon: "p", color: "text-red-700", bgColor: "bg-red-100" },
}

const POST_TYPES = [
  { value: "new_listing", label: "New Listing" },
  { value: "coming_soon", label: "Coming Soon" },
  { value: "open_house_announcement", label: "Open House Announcement" },
  { value: "open_house_reminder", label: "Open House Reminder" },
  { value: "price_reduction", label: "Price Reduction" },
  { value: "just_sold", label: "Just Sold" },
  { value: "open_house_recap", label: "Open House Recap" },
  { value: "market_update", label: "Market Update" },
  { value: "custom", label: "Custom" },
]

interface SocialDashboardClientProps {
  userId: string
  brokerageId: string
  userRole: string
  userName: string
  accounts: any[]
  initialPosts: any[]
  publishLogs: any[]
}

export function SocialDashboardClient({
  userId,
  brokerageId,
  userRole,
  userName,
  accounts,
  initialPosts,
  publishLogs,
}: SocialDashboardClientProps) {
  const router = useRouter()
  const [posts, setPosts] = useState(initialPosts)
  const [activeTab, setActiveTab] = useState("scheduled")
  const [platformFilter, setPlatformFilter] = useState<string | null>(null)
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  
  // Prediction widget state
  const [predictionDialogOpen, setPredictionDialogOpen] = useState(false)
  const [selectedPostForPrediction, setSelectedPostForPrediction] = useState<any>(null)
  const [currentPrediction, setCurrentPrediction] = useState<PredictionData | null>(null)
  const [isPredicting, setIsPredicting] = useState(false)

  // Create post form state
  const [newPost, setNewPost] = useState({
    platform: "",
    postType: "custom",
    content: "",
    hashtags: "",
    scheduledFor: "",
    socialAccountId: "",
    mediaUrls: [] as string[],
  })

  // Filter posts by status
  const getFilteredPosts = useCallback(
    (status: string) => {
      let filtered = posts.filter((p) => {
        if (status === "all") return true
        if (status === "draft") return p.status === "draft"
        if (status === "scheduled") return p.status === "scheduled"
        if (status === "publishing") return p.status === "publishing"
        if (status === "published") return p.status === "published"
        if (status === "failed") return p.status === "failed"
        return true
      })

      if (platformFilter) {
        filtered = filtered.filter((p) => p.platform === platformFilter)
      }

      if (selectedAccount) {
        filtered = filtered.filter((p) => p.social_account_id === selectedAccount)
      }

      return filtered
    },
    [posts, platformFilter, selectedAccount]
  )

  // Handle approve post
  const handleApprove = async (postId: string) => {
    setIsLoading(true)
    const result = await approveSocialPost(postId, userId)
    if (result.success) {
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? { ...p, approval_status: "approved", approved_by: userId, approved_at: new Date().toISOString() }
            : p
        )
      )
    }
    setIsLoading(false)
  }

  // Handle reject post
  const handleReject = async (postId: string) => {
    setIsLoading(true)
    const result = await rejectSocialPost(postId, userId, "Rejected by approver")
    if (result.success) {
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? { ...p, approval_status: "rejected", status: "cancelled" }
            : p
        )
      )
    }
    setIsLoading(false)
  }

  // Handle share post
  const handleShare = async (postId: string, platform: string) => {
    setIsLoading(true)
    const result = await shareListingPost({
      socialPostId: postId,
      agentUserId: userId,
      sharePlatform: platform,
      brokerageId,
    })
    if (result.success) {
      router.refresh()
    } else {
      alert(result.error || "Failed to share post")
    }
    setIsLoading(false)
  }

  // Handle predict performance
  const handlePredictPerformance = async (post: any) => {
    setSelectedPostForPrediction(post)
    setPredictionDialogOpen(true)
    setIsPredicting(true)
    setCurrentPrediction(null)

    const result = await predictPerformanceAction({
      brokerageId,
      userId,
      contentType: "social_post",
      sourceTable: "social_posts",
      sourceId: post.id,
      contentText: post.content || "",
      platform: post.platform,
      scheduledFor: post.scheduled_for,
    })

    if (result.success && result.prediction) {
      setCurrentPrediction(result.prediction)
    }
    setIsPredicting(false)
  }

  // Handle create post
  const handleCreatePost = async () => {
    if (!newPost.platform || !newPost.content || !newPost.scheduledFor || !newPost.socialAccountId) {
      alert("Please fill in all required fields")
      return
    }

    setIsLoading(true)
    const result = await scheduleSocialPost({
      brokerageId,
      userId,
      platform: newPost.platform,
      postType: newPost.postType,
      content: newPost.content,
      hashtags: newPost.hashtags.split(",").map((h) => h.trim()).filter(Boolean),
      scheduledFor: new Date(newPost.scheduledFor).toISOString(),
      socialAccountId: newPost.socialAccountId,
      mediaUrls: newPost.mediaUrls,
    })

    if (result.success) {
      setPosts((prev) => [result.data, ...prev])
      setIsCreateOpen(false)
      setNewPost({
        platform: "",
        postType: "custom",
        content: "",
        hashtags: "",
        scheduledFor: "",
        socialAccountId: "",
        mediaUrls: [],
      })
    } else {
      alert(result.error || "Failed to create post")
    }
    setIsLoading(false)
  }

  // Get counts for tabs
  const getCounts = () => ({
    draft: posts.filter((p) => p.status === "draft").length,
    scheduled: posts.filter((p) => p.status === "scheduled").length,
    publishing: posts.filter((p) => p.status === "publishing").length,
    published: posts.filter((p) => p.status === "published").length,
    failed: posts.filter((p) => p.status === "failed").length,
  })

  const counts = getCounts()

  // Get status badge
  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
      draft: { variant: "secondary", label: "Draft" },
      scheduled: { variant: "default", label: "Scheduled" },
      publishing: { variant: "outline", label: "Publishing" },
      published: { variant: "default", label: "Published" },
      failed: { variant: "destructive", label: "Failed" },
      cancelled: { variant: "secondary", label: "Cancelled" },
    }
    const c = config[status] || { variant: "secondary", label: status }
    return <Badge variant={c.variant}>{c.label}</Badge>
  }

  // Get approval badge
  const getApprovalBadge = (status: string) => {
    if (status === "approved") {
      return <Badge className="bg-green-100 text-green-800">Approved</Badge>
    }
    if (status === "rejected") {
      return <Badge variant="destructive">Rejected</Badge>
    }
    return <Badge className="bg-yellow-100 text-yellow-800">Pending</Badge>
  }

  // Get platform icon
  const PlatformIcon = ({ platform }: { platform: string }) => {
    const config = PLATFORM_CONFIG[platform] || { icon: "?", color: "text-gray-600", bgColor: "bg-gray-100" }
    return (
      <div className={`w-8 h-8 rounded-full ${config.bgColor} flex items-center justify-center`}>
        <span className={`text-xs font-bold ${config.color}`}>{config.icon.toUpperCase()}</span>
      </div>
    )
  }

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Social Media</h1>
          <p className="text-muted-foreground">Schedule and manage your social media posts</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => router.refresh()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Post
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Schedule New Post</DialogTitle>
                <DialogDescription>Create and schedule a social media post</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Platform</Label>
                  <Select
                    value={newPost.platform}
                    onValueChange={(v) => {
                      setNewPost({ ...newPost, platform: v })
                      // Auto-select first account for this platform
                      const acc = accounts.find((a) => a.platform === v)
                      if (acc) {
                        setNewPost((prev) => ({ ...prev, platform: v, socialAccountId: acc.id }))
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select platform" />
                    </SelectTrigger>
                    <SelectContent>
                      {["facebook", "instagram", "linkedin", "twitter", "tiktok", "youtube", "pinterest"].map((p) => (
                        <SelectItem key={p} value={p} disabled={!accounts.some((a) => a.platform === p)}>
                          {p.charAt(0).toUpperCase() + p.slice(1)}
                          {!accounts.some((a) => a.platform === p) && " (Not connected)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {newPost.platform && (
                  <div className="space-y-2">
                    <Label>Account</Label>
                    <Select
                      value={newPost.socialAccountId}
                      onValueChange={(v) => setNewPost({ ...newPost, socialAccountId: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select account" />
                      </SelectTrigger>
                      <SelectContent>
                        {accounts
                          .filter((a) => a.platform === newPost.platform)
                          .map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.account_name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-2">
                  <Label>Post Type</Label>
                  <Select
                    value={newPost.postType}
                    onValueChange={(v) => setNewPost({ ...newPost, postType: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      {POST_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Content</Label>
                  <Textarea
                    value={newPost.content}
                    onChange={(e) => setNewPost({ ...newPost, content: e.target.value })}
                    placeholder="Write your post content..."
                    rows={4}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Hashtags (comma-separated)</Label>
                  <Input
                    value={newPost.hashtags}
                    onChange={(e) => setNewPost({ ...newPost, hashtags: e.target.value })}
                    placeholder="RealEstate, JustListed, HomesForSale"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Schedule For</Label>
                  <Input
                    type="datetime-local"
                    value={newPost.scheduledFor}
                    onChange={(e) => setNewPost({ ...newPost, scheduledFor: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreatePost} disabled={isLoading}>
                  {isLoading ? "Scheduling..." : "Schedule Post"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold">{counts.draft}</div>
            <p className="text-sm text-muted-foreground">Drafts</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold text-blue-600">{counts.scheduled}</div>
            <p className="text-sm text-muted-foreground">Scheduled</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold text-yellow-600">{counts.publishing}</div>
            <p className="text-sm text-muted-foreground">Publishing</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold text-green-600">{counts.published}</div>
            <p className="text-sm text-muted-foreground">Published</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold text-red-600">{counts.failed}</div>
            <p className="text-sm text-muted-foreground">Failed</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-sm text-muted-foreground">Filter:</span>
        <Button
          variant={platformFilter === null ? "default" : "outline"}
          size="sm"
          onClick={() => setPlatformFilter(null)}
        >
          All
        </Button>
        {["facebook", "instagram", "linkedin", "twitter", "tiktok", "youtube"].map((p) => (
          <Button
            key={p}
            variant={platformFilter === p ? "default" : "outline"}
            size="sm"
            onClick={() => setPlatformFilter(p === platformFilter ? null : p)}
          >
            {p.charAt(0).toUpperCase() + p.slice(1)}
          </Button>
        ))}

        {accounts.length > 0 && (
          <Select
            value={selectedAccount || "all"}
            onValueChange={(v) => setSelectedAccount(v === "all" ? null : v)}
          >
            <SelectTrigger className="w-48 ml-auto">
              <SelectValue placeholder="All accounts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All accounts</SelectItem>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.account_name} ({a.platform})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="draft">Draft ({counts.draft})</TabsTrigger>
          <TabsTrigger value="scheduled">Scheduled ({counts.scheduled})</TabsTrigger>
          <TabsTrigger value="publishing">Publishing ({counts.publishing})</TabsTrigger>
          <TabsTrigger value="published">Published ({counts.published})</TabsTrigger>
          <TabsTrigger value="failed">Failed ({counts.failed})</TabsTrigger>
        </TabsList>

        {["draft", "scheduled", "publishing", "published", "failed"].map((tabValue) => (
          <TabsContent key={tabValue} value={tabValue} className="space-y-4">
            {getFilteredPosts(tabValue).length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  No {tabValue} posts found
                </CardContent>
              </Card>
            ) : (
              getFilteredPosts(tabValue).map((post) => (
                <Card key={post.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      <PlatformIcon platform={post.platform} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          {getStatusBadge(post.status)}
                          {getApprovalBadge(post.approval_status)}
                          <Badge variant="outline">{post.post_type?.replace(/_/g, " ") || "Custom"}</Badge>
                          {post.brand_compliance_passed === true && (
                            <Badge className="bg-green-100 text-green-800">
                              <Check className="h-3 w-3 mr-1" />
                              Compliant
                            </Badge>
                          )}
                          {post.brand_compliance_passed === false && (
                            <Badge variant="destructive">
                              <AlertCircle className="h-3 w-3 mr-1" />
                              Non-compliant
                            </Badge>
                          )}
                        </div>

                        <p className="text-sm text-foreground line-clamp-3 mb-2">{post.content}</p>

                        {post.hashtags && post.hashtags.length > 0 && (
                          <p className="text-xs text-muted-foreground mb-2">
                            {post.hashtags.map((h: string) => `#${h}`).join(" ")}
                          </p>
                        )}

                        {post.media_urls && post.media_urls.length > 0 && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-2">
                            <ImageIcon className="h-3 w-3" />
                            {post.media_urls.length} media file(s)
                          </div>
                        )}

                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {post.scheduled_for
                              ? new Date(post.scheduled_for).toLocaleString()
                              : "Not scheduled"}
                          </span>
                          {post.published_at && (
                            <span>Published: {new Date(post.published_at).toLocaleString()}</span>
                          )}
                          {post.social_media_accounts?.account_name && (
                            <span>Account: {post.social_media_accounts.account_name}</span>
                          )}
                        </div>

                        {/* Engagement data for published posts */}
                        {post.status === "published" && post.social_engagement_tracking?.[0] && (
                          <div className="flex items-center gap-4 mt-3 text-sm">
                            <span className="flex items-center gap-1">
                              <Eye className="h-4 w-4" />
                              {post.social_engagement_tracking[0].impressions_count || 0}
                            </span>
                            <span className="flex items-center gap-1">
                              <ThumbsUp className="h-4 w-4" />
                              {post.social_engagement_tracking[0].likes_count || 0}
                            </span>
                            <span className="flex items-center gap-1">
                              <MessageCircle className="h-4 w-4" />
                              {post.social_engagement_tracking[0].comments_count || 0}
                            </span>
                            <span className="flex items-center gap-1">
                              <Share2 className="h-4 w-4" />
                              {post.social_engagement_tracking[0].shares_count || 0}
                            </span>
                          </div>
                        )}

                        {/* Error message for failed posts */}
                        {post.status === "failed" && post.error_message && (
                          <div className="mt-2 p-2 bg-red-50 text-red-700 text-xs rounded">
                            <AlertCircle className="h-3 w-3 inline mr-1" />
                            {post.error_message}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {/* Approve button - only for pending approval */}
                        {post.approval_status === "pending" && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-green-600 hover:text-green-700"
                              onClick={() => handleApprove(post.id)}
                              disabled={isLoading}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-red-600 hover:text-red-700"
                              onClick={() => handleReject(post.id)}
                              disabled={isLoading}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        )}

                        {/* Share button - only for approved + compliant */}
                        {post.approval_status === "approved" && post.brand_compliance_passed === true && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleShare(post.id, post.platform)}
                            disabled={isLoading}
                          >
                            <Share2 className="h-4 w-4 mr-1" />
                            Share
                          </Button>
                        )}

                        {/* External link for published posts */}
                        {post.status === "published" && post.external_post_id && (
                          <Button size="sm" variant="ghost" asChild>
                            <a href="#" target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        )}

{/* Predict Performance button */}
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => handlePredictPerformance(post)}
                                          disabled={isLoading || isPredicting}
                                          title="Predict Performance"
                                        >
                                          <BarChart3 className="h-4 w-4" />
                                        </Button>

                                        <DropdownMenu>
                                          <DropdownMenuTrigger asChild>
                                            <Button variant="ghost" size="sm">
                                              <MoreVertical className="h-4 w-4" />
                                            </Button>
                                          </DropdownMenuTrigger>
                                          <DropdownMenuContent align="end">
                                            <DropdownMenuItem>View Details</DropdownMenuItem>
                                            <DropdownMenuItem>Edit Post</DropdownMenuItem>
                                            <DropdownMenuItem>Reschedule</DropdownMenuItem>
                                            <DropdownMenuItem className="text-red-600">Delete</DropdownMenuItem>
                                          </DropdownMenuContent>
                                        </DropdownMenu>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>
        ))}
      </Tabs>

      {/* Performance Prediction Dialog */}
      <Dialog open={predictionDialogOpen} onOpenChange={setPredictionDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Performance Prediction</DialogTitle>
            <DialogDescription>
              AI-powered analysis of your content&apos;s potential performance
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {selectedPostForPrediction && (
              <div className="mb-4 p-3 bg-muted rounded-lg">
                <p className="text-sm line-clamp-2">{selectedPostForPrediction.content}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Platform: {selectedPostForPrediction.platform}
                </p>
              </div>
            )}
            <PredictionWidget
              prediction={currentPrediction}
              isLoading={isPredicting}
              onPredict={() => selectedPostForPrediction && handlePredictPerformance(selectedPostForPrediction)}
              showPredictButton={!!currentPrediction}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Connected Accounts Summary */}
      {accounts.length === 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>No Connected Accounts</CardTitle>
            <CardDescription>
              Connect your social media accounts to start scheduling posts
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline">Connect Account</Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
