"use client"

// app/dashboard/social/social-dashboard-client.tsx
// Layer 9.2 Social Media Automation — Dashboard Client

import { useState, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  RotateCcw,
  Trash2,
  Pencil,
} from "lucide-react"
import {
  scheduleSocialPost,
  approveSocialPost,
  rejectSocialPost,
  retryFailedPost,
  deleteSocialPost,
  getSocialMediaAnalytics,
  rescheduleSocialPost,
  getSocialQueue,
  getPublishLog,
  getSocialEngagement,
  refreshPostEngagementFromSync,
} from "@/app/actions/social-media-automation"
import { cn } from "@/lib/utils"
import { shareListingPost, canAgentSharePost, getAgentShareHistory } from "@/app/actions/social-share"
import { predictPerformanceAction } from "@/app/actions/content-prediction"
import { PredictionWidget, type PredictionData } from "@/app/components/prediction-widget"
import { BarChart3, Sparkles } from "lucide-react"
import { SocialAiComposer } from "@/app/components/ai-copilot/social-ai-composer"
import { SocialCalendarAiPlanner } from "@/app/components/ai-copilot/social-calendar-ai-planner"
import { PostComposerDialog } from "./components/post-composer-dialog"
import { getPublishedPostUrl } from "@/lib/social/get-published-post-url"
import { toast } from "sonner"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

// ── Platform config ──────────────────────────────────────────────────────────

const PLATFORM_CONFIG: Record<string, { icon: string; color: string; bgColor: string }> = {
  facebook:  { icon: "f",  color: "text-blue-600",  bgColor: "bg-blue-100" },
  instagram: { icon: "ig", color: "text-pink-600",  bgColor: "bg-pink-100" },
  linkedin:  { icon: "in", color: "text-blue-700",  bgColor: "bg-blue-100" },
  twitter:   { icon: "x",  color: "text-gray-900",  bgColor: "bg-gray-100" },
  tiktok:    { icon: "tt", color: "text-black",     bgColor: "bg-gray-100" },
  youtube:   { icon: "yt", color: "text-red-600",   bgColor: "bg-red-100" },
  pinterest: { icon: "p",  color: "text-red-700",   bgColor: "bg-red-100" },
}

// Roles allowed to approve/reject posts

// ── Types ────────────────────────────────────────────────────────────────────

interface SocialDashboardClientProps {
  userId: string
  brokerageId: string
  userRole: string
  userName: string
  accounts: any[]
  initialPosts: any[]
  publishLogs: any[]
  openCreate?: boolean
  requiresBrokerApproval?: boolean
}

// ── Main Component ────────────────────────────────────────────────────────────

export function SocialDashboardClient({
  userId,
  brokerageId,
  userRole,
  userName,
  accounts,
  initialPosts,
  publishLogs,
  openCreate = false,
  requiresBrokerApproval = false,
}: SocialDashboardClientProps) {
  const router = useRouter()
  const [posts, setPosts] = useState(initialPosts)
  const [activeTab, setActiveTab] = useState("scheduled")
  const [platformFilter, setPlatformFilter] = useState<string | null>(null)

  // Composer dialog
  const [composerOpen, setComposerOpen] = useState(openCreate)
  const [editingPost, setEditingPost] = useState<any>(null)

  // Delete confirmation
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deletingPostId, setDeletingPostId] = useState<string | null>(null)

  // Loading states (per-post)
  const [loadingPostId, setLoadingPostId] = useState<string | null>(null)

  // Performance prediction
  const [predictionDialogOpen, setPredictionDialogOpen] = useState(false)
  const [selectedPostForPrediction, setSelectedPostForPrediction] = useState<any>(null)
  const [currentPrediction, setCurrentPrediction] = useState<PredictionData | null>(null)
  const [isPredicting, setIsPredicting] = useState(false)

  // Analytics
  const [analytics, setAnalytics] = useState<any>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsLoaded, setAnalyticsLoaded] = useState(false)
  const [shareHistory, setShareHistory] = useState<any[]>([])
  const [shareHistoryLoaded, setShareHistoryLoaded] = useState(false)
  const [shareHistoryLoading, setShareHistoryLoading] = useState(false)

  // Reschedule
  const [reschedulingPostId, setReschedulingPostId] = useState<string | null>(null)
  const [rescheduleDate, setRescheduleDate] = useState("")

  // Server-backed queue reload (getSocialQueue) — the page's initial payload is
  // capped and unfiltered; this reloads the tenant's queue for the platform the
  // user actually picked, and surfaces a refused read instead of blanking out.
  const [queueLoading, setQueueLoading] = useState(false)
  const [queueError, setQueueError] = useState<string | null>(null)

  // Delivery log / measurement drawer for one post
  const [logPost, setLogPost] = useState<any>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [logAttempts, setLogAttempts] = useState<any[]>([])
  const [logMeasurements, setLogMeasurements] = useState<any[]>([])
  const [metricsPulling, setMetricsPulling] = useState(false)

  const isApprover = isAdminOrBroker({ user_type: userRole })

  // ── Computed ──────────────────────────────────────────────────────────────

  // APPROVAL IS NOT A STATUS. social_posts_status_check (live) allows only
  // draft|scheduled|publishing|published|failed|cancelled — there has never
  // been a 'pending_approval' status value, so this tab and its stat card
  // filtered on a string the column cannot hold and were permanently zero
  // however many posts were actually awaiting a broker. Approval lives in
  // social_posts.approval_status (pending|approved|rejected).
  const matchesTab = useCallback((p: any, tab: string) => {
    if (tab === "all") return true
    if (tab === "pending_approval") return p.approval_status === "pending"
    return p.status === tab
  }, [])

  const getFilteredPosts = useCallback((status: string) => {
    let filtered = posts.filter(p => matchesTab(p, status))
    if (platformFilter) filtered = filtered.filter(p => p.platform === platformFilter)
    return filtered
  }, [posts, platformFilter, matchesTab])

  const counts = useMemo(() => ({
    draft:            posts.filter(p => p.status === "draft").length,
    pending_approval: posts.filter(p => p.approval_status === "pending").length,
    scheduled:        posts.filter(p => p.status === "scheduled").length,
    publishing:       posts.filter(p => p.status === "publishing").length,
    published:        posts.filter(p => p.status === "published").length,
    failed:           posts.filter(p => p.status === "failed").length,
  }), [posts])

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleApprove = async (postId: string) => {
    setLoadingPostId(postId)
    const result = await approveSocialPost(postId, userId)
    if (result.success) {
      setPosts(prev => prev.map(p => p.id === postId
        ? { ...p, approval_status: "approved", approved_by: userId, approved_at: new Date().toISOString() }
        : p
      ))
      toast.success("Post approved")
    } else {
      toast.error(result.error || "Failed to approve")
    }
    setLoadingPostId(null)
  }

  const handleReject = async (postId: string) => {
    setLoadingPostId(postId)
    const result = await rejectSocialPost(postId, userId, "Rejected by approver")
    if (result.success) {
      setPosts(prev => prev.map(p => p.id === postId
        ? { ...p, approval_status: "rejected", status: "cancelled" }
        : p
      ))
      toast.success("Post rejected")
    } else {
      toast.error(result.error || "Failed to reject")
    }
    setLoadingPostId(null)
  }

  const handleRetry = async (postId: string) => {
    setLoadingPostId(postId)
    const result = await retryFailedPost(postId, userId)
    if (result.success) {
      setPosts(prev => prev.map(p => p.id === postId
        ? { ...p, status: "scheduled", approval_status: "pending", error_message: null }
        : p
      ))
      toast.success("Post queued for retry")
    } else {
      toast.error(result.error || "Retry failed")
    }
    setLoadingPostId(null)
  }

  const handleDeleteConfirm = async () => {
    if (!deletingPostId) return
    setLoadingPostId(deletingPostId)
    const result = await deleteSocialPost(deletingPostId, userId)
    if (result.success) {
      setPosts(prev => prev.filter(p => p.id !== deletingPostId))
      toast.success("Post deleted")
    } else {
      toast.error(result.error || "Delete failed")
    }
    setDeleteConfirmOpen(false)
    setDeletingPostId(null)
    setLoadingPostId(null)
  }

  const handleShare = async (postId: string, platform: string) => {
    setLoadingPostId(postId)
    // THE GATE, CONSULTED BEFORE THE SHARE. The button is only drawn for a post
    // that looked shareable when this page was rendered — approval can be
    // revoked, and brand compliance re-run, in the meantime. canAgentSharePost
    // re-reads the post's live approval + brand-compliance state under the
    // session's brokerage and says WHICH one failed; shareListingPost enforces
    // the same two conditions on the write, so this adds the reason, never the
    // permission.
    const gate = await canAgentSharePost({ socialPostId: postId })
    if (!gate.canShare) {
      toast.error(gate.reason || "This post cannot be shared")
      setLoadingPostId(null)
      return
    }
    const result = await shareListingPost({ socialPostId: postId, agentUserId: userId, sharePlatform: platform, brokerageId })
    if (result.success) {
      router.refresh()
      toast.success("Post shared")
      // A completed share belongs on the agent's own share record — refresh it
      // if it is on screen.
      if (shareHistoryLoaded) void loadShareHistory()
    } else {
      toast.error(result.error || "Share failed")
    }
    setLoadingPostId(null)
  }

  // ── THE AGENT'S OWN SHARE RECORD ────────────────────────────────────────────
  // agent_social_shares is written on every share above and was read by nothing:
  // an agent could not see what they had personally pushed out, on which
  // network, or when. Session-scoped inside the action — it is always the
  // caller's own history, never another agent's.
  const loadShareHistory = async () => {
    setShareHistoryLoading(true)
    try {
      const rows = await getAgentShareHistory({ limit: 50 })
      setShareHistory(rows as any[])
    } finally {
      setShareHistoryLoaded(true)
      setShareHistoryLoading(false)
    }
  }

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
    if (result.success && result.prediction) setCurrentPrediction(result.prediction)
    setIsPredicting(false)
  }

  const handleLoadAnalytics = async () => {
    if (analyticsLoaded) return
    setAnalyticsLoading(true)
    // Tenant comes from the session inside the action now; the argument is ignored.
    const data = await getSocialMediaAnalytics().catch(() => null)
    setAnalytics(data)
    setAnalyticsLoaded(true)
    setAnalyticsLoading(false)
  }

  /**
   * Reload the queue from the server for the platform currently selected.
   * Reads the action's verdict: an RLS refusal is shown as a refusal, not as
   * an empty queue.
   */
  const handleReloadQueue = async () => {
    setQueueLoading(true)
    setQueueError(null)
    const result = await getSocialQueue({
      platform: platformFilter ?? undefined,
      limit: 500,
    }).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
    if (result.ok) {
      setPosts(result.posts)
    } else {
      setQueueError(result.error)
      toast.error(result.error)
    }
    setQueueLoading(false)
    router.refresh()
  }

  /** Open the per-post delivery log: every publish attempt + measurement history. */
  const handleOpenLog = async (post: any) => {
    setLogPost(post)
    setLogLoading(true)
    setLogError(null)
    setLogAttempts([])
    setLogMeasurements([])
    const [logResult, engResult] = await Promise.all([
      getPublishLog(post.id).catch((e: unknown) => ({ ok: false as const, error: String(e) })),
      getSocialEngagement(post.id).catch((e: unknown) => ({ ok: false as const, error: String(e) })),
    ])
    if (logResult.ok) setLogAttempts(logResult.attempts)
    else setLogError(logResult.error)
    if (engResult.ok) setLogMeasurements(engResult.measurements)
    else setLogError(prev => prev ?? engResult.error)
    setLogLoading(false)
  }

  /**
   * Pull the latest REAL platform measurement (written by the nightly
   * analytics sync from the platform's own API) into this post's engagement
   * row. Never fabricates a number: if the sync has not measured this post the
   * server says so and nothing is written.
   */
  const handlePullMetrics = async () => {
    if (!logPost) return
    setMetricsPulling(true)
    const result = await refreshPostEngagementFromSync(logPost.id).catch((e: unknown) => ({
      success: false as const,
      error: String(e),
    }))
    if (result.success) {
      toast.success(
        `Metrics updated from the ${new Date(result.measuredAt!).toLocaleString()} platform measurement`
      )
      const engResult = await getSocialEngagement(logPost.id).catch(() => null)
      if (engResult?.ok) setLogMeasurements(engResult.measurements)
      router.refresh()
    } else {
      toast.error(result.error || "Could not refresh metrics")
    }
    setMetricsPulling(false)
  }

  const handleReschedule = async (postId: string) => {
    if (!rescheduleDate) return
    setLoadingPostId(postId)
    const result = await rescheduleSocialPost(postId, userId, new Date(rescheduleDate).toISOString())
    if (result.success) {
      setPosts(prev => prev.map(p => p.id === postId ? { ...p, scheduled_for: rescheduleDate } : p))
      toast.success("Post rescheduled")
      setReschedulingPostId(null)
      setRescheduleDate("")
    } else {
      toast.error((result as any).error || "Failed to reschedule")
    }
    setLoadingPostId(null)
  }

  const handlePostSaved = (post: any) => {
    if (!post) { router.refresh(); return }
    const exists = posts.some(p => p.id === post.id)
    if (exists) {
      setPosts(prev => prev.map(p => p.id === post.id ? { ...p, ...post } : p))
    } else {
      setPosts(prev => [post, ...prev])
    }
  }

  // ── Sub-components ────────────────────────────────────────────────────────

  function PlatformIcon({ platform }: { platform: string }) {
    const config = PLATFORM_CONFIG[platform] || { icon: "?", color: "text-gray-600", bgColor: "bg-gray-100" }
    return (
      <div className={`w-8 h-8 rounded-full flex-shrink-0 ${config.bgColor} flex items-center justify-center`}>
        <span className={`text-xs font-bold ${config.color}`}>{config.icon.toUpperCase()}</span>
      </div>
    )
  }

  function getStatusBadge(status: string) {
    const map: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
      draft:            { variant: "secondary",   label: "Draft" },
      pending_approval: { variant: "outline",     label: "Pending Approval" },
      scheduled:        { variant: "default",     label: "Scheduled" },
      publishing:       { variant: "outline",     label: "Publishing" },
      published:        { variant: "default",     label: "Published" },
      failed:           { variant: "destructive", label: "Failed" },
      cancelled:        { variant: "secondary",   label: "Cancelled" },
    }
    const c = map[status] || { variant: "secondary", label: status }
    return <Badge variant={c.variant}>{c.label}</Badge>
  }

  function getApprovalBadge(status: string) {
    if (status === "approved") return <Badge className="bg-green-100 text-green-800">Approved</Badge>
    if (status === "rejected") return <Badge variant="destructive">Rejected</Badge>
    return <Badge className="bg-yellow-100 text-yellow-800">Pending Approval</Badge>
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Social Media</h1>
          <p className="text-muted-foreground text-sm">Schedule and manage your social posts</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleReloadQueue} disabled={queueLoading}>
            <RefreshCw className={cn("h-4 w-4 mr-2", queueLoading && "animate-spin")} />
            {queueLoading ? "Reloading…" : "Refresh"}
          </Button>
          <Button onClick={() => { setEditingPost(null); setComposerOpen(true) }}>
            <Plus className="h-4 w-4 mr-2" />New Post
          </Button>
        </div>
      </div>

      {/* Queue reload refusal — shown as a refusal, never as an empty queue */}
      {queueError && (
        <Card className="mb-6 border-red-200 bg-red-50">
          <CardContent className="py-4 flex items-center gap-3 text-sm text-red-800">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            Could not reload the queue: {queueError}. What is shown below may be stale.
          </CardContent>
        </Card>
      )}

      {/* No accounts notice */}
      {accounts.length === 0 && (
        <Card className="mb-6 border-amber-200 bg-amber-50">
          <CardContent className="py-4 flex items-center gap-3 text-sm text-amber-800">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            No social accounts connected. Connect accounts in Settings to schedule posts.
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
        {[
          { label: "Drafts",          count: counts.draft,            color: "" },
          { label: "Pending Approval", count: counts.pending_approval, color: "text-amber-600" },
          { label: "Scheduled",       count: counts.scheduled,        color: "text-blue-600" },
          { label: "Publishing",      count: counts.publishing,       color: "text-yellow-600" },
          { label: "Published",       count: counts.published,        color: "text-green-600" },
          { label: "Failed",          count: counts.failed,           color: "text-red-600" },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className="pt-4">
              <div className={`text-2xl font-bold ${s.color}`}>{s.count}</div>
              <p className="text-sm text-muted-foreground">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Platform filter */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-sm text-muted-foreground">Platform:</span>
        {[null, "facebook", "instagram", "linkedin", "twitter", "tiktok", "youtube"].map(p => (
          <Button
            key={p ?? "all"}
            variant={platformFilter === p ? "default" : "outline"}
            size="sm"
            onClick={() => setPlatformFilter(p)}
          >
            {p ? p.charAt(0).toUpperCase() + p.slice(1) : "All"}
          </Button>
        ))}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="ai-composer" className="gap-1">
            <Sparkles className="h-4 w-4" />AI Composer
          </TabsTrigger>
          <TabsTrigger value="calendar" className="gap-1">
            <Calendar className="h-4 w-4" />Calendar
          </TabsTrigger>
          <TabsTrigger value="analytics" className="gap-1" onClick={handleLoadAnalytics}>
            <BarChart3 className="h-4 w-4" />Analytics
          </TabsTrigger>
          <TabsTrigger value="draft">Draft ({counts.draft})</TabsTrigger>
          <TabsTrigger value="pending_approval" className={counts.pending_approval > 0 ? "text-amber-700" : ""}>
            Pending Approval ({counts.pending_approval})
          </TabsTrigger>
          <TabsTrigger value="scheduled">Scheduled ({counts.scheduled})</TabsTrigger>
          <TabsTrigger value="publishing">Publishing ({counts.publishing})</TabsTrigger>
          <TabsTrigger value="published">Published ({counts.published})</TabsTrigger>
          <TabsTrigger value="failed">Failed ({counts.failed})</TabsTrigger>
        </TabsList>

        {/* AI Composer */}
        <TabsContent value="ai-composer">
          <SocialAiComposer
            agentId={userId}
            brokerageId={brokerageId}
            connectedPlatforms={accounts.map(a => a.platform)}
            accounts={accounts}
            onPostScheduled={() => router.refresh()}
          />
        </TabsContent>

        {/* Calendar */}
        <TabsContent value="calendar">
          <SocialCalendarAiPlanner
            agentId={userId}
            brokerageId={brokerageId}
            userId={userId}
            posts={posts}
            onRefresh={() => router.refresh()}
          />
        </TabsContent>

        {/* Analytics */}
        <TabsContent value="analytics" className="space-y-4">
          {/* Your shares — agent_social_shares, the ledger every Share button writes. */}
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <p className="text-sm font-semibold">Your Shares</p>
                <Button size="sm" variant="outline" onClick={loadShareHistory} disabled={shareHistoryLoading}>
                  {shareHistoryLoading ? (
                    <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <Share2 className="h-3.5 w-3.5 mr-1" />
                  )}
                  {shareHistoryLoaded ? "Refresh" : "Load my shares"}
                </Button>
              </div>
              {!shareHistoryLoaded && !shareHistoryLoading && (
                <p className="text-xs text-muted-foreground">
                  Every post you personally shared, on which network and when.
                </p>
              )}
              {shareHistoryLoaded && shareHistory.length === 0 && (
                <p className="text-xs text-muted-foreground">You have not shared any posts yet.</p>
              )}
              {shareHistory.length > 0 && (
                <div className="space-y-2">
                  {shareHistory.map((sh) => (
                    <div key={sh.id} className="flex items-start justify-between gap-2 p-2 rounded border text-xs">
                      <div className="min-w-0">
                        <p className="font-medium capitalize">{sh.share_platform}</p>
                        <p className="text-muted-foreground line-clamp-2">
                          {sh.share_variant_text || sh.social_posts?.content || "(no caption recorded)"}
                        </p>
                      </div>
                      <span className="text-muted-foreground shrink-0">
                        {sh.shared_at ? new Date(sh.shared_at).toLocaleString() : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {analyticsLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />Loading analytics…
            </div>
          )}
          {!analyticsLoading && analyticsLoaded && !analytics && (
            <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No analytics data available yet.</CardContent></Card>
          )}
          {analytics && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "Total Posts",      value: analytics.totalPosts,                  icon: ImageIcon },
                  { label: "Impressions",      value: analytics.totalImpressions.toLocaleString(), icon: Eye },
                  { label: "Engagement",       value: analytics.totalEngagement.toLocaleString(),  icon: ThumbsUp },
                  { label: "Eng. Rate",        value: `${analytics.avgEngagementRate.toFixed(2)}%`, icon: TrendingUp },
                ].map(({ label, value, icon: Icon }) => (
                  <Card key={label}>
                    <CardContent className="p-4 flex items-center gap-3">
                      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-xl font-bold leading-none">{value}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Platform breakdown */}
              {Object.keys(analytics.platformBreakdown).length > 0 && (
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-sm font-semibold mb-3">Platform Breakdown</p>
                    <div className="space-y-2">
                      {Object.entries(analytics.platformBreakdown as Record<string, { posts: number; impressions: number; engagement: number }>).map(([platform, data]) => (
                        <div key={platform} className="flex items-center gap-3 text-sm">
                          <span className="w-20 font-medium capitalize">{platform}</span>
                          <span className="text-muted-foreground">{data.posts} posts</span>
                          <span className="text-muted-foreground">{data.impressions.toLocaleString()} impressions</span>
                          <span className="text-muted-foreground">{data.engagement.toLocaleString()} engagement</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Top posts */}
              {analytics.topPosts.length > 0 && (
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-sm font-semibold mb-3">Top Performing Posts</p>
                    <div className="space-y-2">
                      {analytics.topPosts.map((post: any) => (
                        <div key={post.id} className="flex items-start justify-between gap-2 p-2 rounded border text-xs">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium capitalize">{post.platform}</p>
                            <p className="text-muted-foreground line-clamp-2">{post.content?.slice(0, 100)}</p>
                          </div>
                          {post.engagement && (
                            <div className="flex items-center gap-2 shrink-0 text-muted-foreground">
                              <span className="flex items-center gap-0.5"><ThumbsUp className="h-3 w-3" />{(Array.isArray(post.engagement) ? post.engagement[0] : post.engagement)?.likes_count ?? 0}</span>
                              <span className="flex items-center gap-0.5"><MessageCircle className="h-3 w-3" />{(Array.isArray(post.engagement) ? post.engagement[0] : post.engagement)?.comments_count ?? 0}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        {/* Post list tabs */}
        {(["draft", "pending_approval", "scheduled", "publishing", "published", "failed"] as const).map(tabValue => (
          <TabsContent key={tabValue} value={tabValue} className="space-y-3">
            {getFilteredPosts(tabValue).length === 0 ? (
              <Card>
                <CardContent className="py-10 text-center text-muted-foreground">
                  <p className="text-sm">No {tabValue} posts</p>
                  {tabValue === "scheduled" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => { setEditingPost(null); setComposerOpen(true) }}
                    >
                      <Plus className="h-4 w-4 mr-2" />Create your first post
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : (
              getFilteredPosts(tabValue).map(post => {
                const isLoading = loadingPostId === post.id
                const postUrl = post.external_post_id
                  ? getPublishedPostUrl(post.platform, post.external_post_id)
                  : null
                const failedLog = publishLogs.find(l => l.social_post_id === post.id)

                return (
                  <Card key={post.id} className={isLoading ? "opacity-60" : ""}>
                    <CardContent className="p-4">
                      <div className="flex items-start gap-4">
                        <PlatformIcon platform={post.platform} />

                        <div className="flex-1 min-w-0">
                          {/* Badges row */}
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            {getStatusBadge(post.status)}
                            {getApprovalBadge(post.approval_status)}
                            <Badge variant="outline" className="text-xs">
                              {post.post_type?.replace(/_/g, " ") || "Custom"}
                            </Badge>
                            {post.ai_generated && (
                              <Badge variant="secondary" className="text-xs gap-1">
                                <Sparkles className="h-3 w-3" />AI
                              </Badge>
                            )}
                            {post.brand_compliance_passed === true && (
                              <Badge className="bg-green-100 text-green-800 text-xs">
                                <Check className="h-3 w-3 mr-1" />Compliant
                              </Badge>
                            )}
                            {post.brand_compliance_passed === false && (
                              <Badge variant="destructive" className="text-xs">
                                <AlertCircle className="h-3 w-3 mr-1" />Non-compliant
                              </Badge>
                            )}
                          </div>

                          {/* Content */}
                          <p className="text-sm text-foreground line-clamp-3 mb-2">{post.content}</p>

                          {/* Hashtags */}
                          {post.hashtags && post.hashtags.length > 0 && (
                            <p className="text-xs text-blue-600 mb-2">
                              {post.hashtags.slice(0, 6).map((h: string) => `#${h}`).join(" ")}
                              {post.hashtags.length > 6 && ` +${post.hashtags.length - 6} more`}
                            </p>
                          )}

                          {/* Media thumbnails */}
                          {post.media_urls && post.media_urls.length > 0 && (
                            <div className="flex gap-1 mb-2">
                              {post.media_urls.slice(0, 3).map((url: string, i: number) => (
                                <img
                                  key={i}
                                  src={url}
                                  alt="Media"
                                  crossOrigin="anonymous"
                                  className="w-12 h-12 rounded object-cover border"
                                />
                              ))}
                              {post.media_urls.length > 3 && (
                                <div className="w-12 h-12 rounded border bg-muted flex items-center justify-center text-xs text-muted-foreground">
                                  +{post.media_urls.length - 3}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Meta row */}
                          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
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
                              <span>@{post.social_media_accounts.account_name}</span>
                            )}
                          </div>

                          {/* Engagement for published */}
                          {post.status === "published" && post.social_engagement_tracking?.[0] && (
                            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1"><Eye className="h-3 w-3" />{post.social_engagement_tracking[0].impressions_count ?? 0}</span>
                              <span className="flex items-center gap-1"><ThumbsUp className="h-3 w-3" />{post.social_engagement_tracking[0].likes_count ?? 0}</span>
                              <span className="flex items-center gap-1"><MessageCircle className="h-3 w-3" />{post.social_engagement_tracking[0].comments_count ?? 0}</span>
                              <span className="flex items-center gap-1"><Share2 className="h-3 w-3" />{post.social_engagement_tracking[0].shares_count ?? 0}</span>
                            </div>
                          )}

                          {/* Error detail for failed posts */}
                          {post.status === "failed" && (
                            <div className="mt-2 p-2 bg-red-50 text-red-700 text-xs rounded border border-red-200">
                              <AlertCircle className="h-3 w-3 inline mr-1" />
                              {post.error_message || failedLog?.error_message || "Unknown error — check publish log"}
                            </div>
                          )}
                        </div>

                        {/* Actions column */}
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {/* Broker approval buttons — approver role only */}
                          {isApprover && post.approval_status === "pending" && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-green-600 hover:text-green-700 h-8 w-8 p-0"
                                onClick={() => handleApprove(post.id)}
                                disabled={isLoading}
                                title="Approve"
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-red-600 hover:text-red-700 h-8 w-8 p-0"
                                onClick={() => handleReject(post.id)}
                                disabled={isLoading}
                                title="Reject"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </>
                          )}

                          {/* Share — approved + compliant */}
                          {post.approval_status === "approved" && post.brand_compliance_passed === true && post.status === "scheduled" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 px-2 text-xs"
                              onClick={() => handleShare(post.id, post.platform)}
                              disabled={isLoading}
                            >
                              <Share2 className="h-3 w-3 mr-1" />Share
                            </Button>
                          )}

                          {/* Retry — failed posts only */}
                          {post.status === "failed" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 w-8 p-0 text-blue-600"
                              onClick={() => handleRetry(post.id)}
                              disabled={isLoading}
                              title="Retry"
                            >
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                          )}

                          {/* External link for published */}
                          {post.status === "published" && postUrl && (
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" asChild>
                              <a href={postUrl} target="_blank" rel="noopener noreferrer" title="View on platform">
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            </Button>
                          )}

                          {/* Performance prediction */}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            onClick={() => handlePredictPerformance(post)}
                            disabled={isLoading || isPredicting}
                            title="Predict performance"
                          >
                            <BarChart3 className="h-4 w-4" />
                          </Button>

                          {/* More actions menu */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {/* Delivery log — every publish attempt + measured engagement */}
                              <DropdownMenuItem onClick={() => handleOpenLog(post)}>
                                <ExternalLink className="h-4 w-4 mr-2" />Delivery log
                              </DropdownMenuItem>
                              {/* Edit — only draft/scheduled */}
                              {["draft", "scheduled"].includes(post.status) && (
                                <DropdownMenuItem onClick={() => { setEditingPost(post); setComposerOpen(true) }}>
                                  <Pencil className="h-4 w-4 mr-2" />Edit Post
                                </DropdownMenuItem>
                              )}
                              {/* Reschedule — scheduled posts */}
                              {post.status === "scheduled" && (
                                <DropdownMenuItem onClick={() => { setReschedulingPostId(post.id); setRescheduleDate(post.scheduled_for?.slice(0, 16) ?? "") }}>
                                  <Clock className="h-4 w-4 mr-2" />Reschedule
                                </DropdownMenuItem>
                              )}
                              {/* Delete — any non-published */}
                              {post.status !== "published" && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="text-red-600 focus:text-red-600"
                                    onClick={() => { setDeletingPostId(post.id); setDeleteConfirmOpen(true) }}
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />Delete Post
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })
            )}
          </TabsContent>
        ))}
      </Tabs>

      {/* Delivery log + measured engagement for one post */}
      <Dialog open={!!logPost} onOpenChange={(o) => { if (!o) setLogPost(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Delivery log</DialogTitle>
            <DialogDescription>
              Every publish attempt this post made, and the engagement measurements
              recorded against it.
            </DialogDescription>
          </DialogHeader>

          {logLoading && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin inline mr-2" />Loading…
            </div>
          )}

          {!logLoading && logError && (
            <div className="p-3 rounded border border-red-200 bg-red-50 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 inline mr-1" />
              {logError}
            </div>
          )}

          {!logLoading && !logError && (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Publish attempts ({logAttempts.length})
                </p>
                {logAttempts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No publish attempt has been logged for this post yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {logAttempts.map((a: any) => (
                      <div key={a.id} className="rounded border p-2 text-xs space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant={a.publish_status === "failed" ? "destructive" : "outline"}
                            className="text-xs capitalize"
                          >
                            {a.publish_status}
                          </Badge>
                          <span className="capitalize">{a.platform}</span>
                          <span className="text-muted-foreground">
                            {a.created_at ? new Date(a.created_at).toLocaleString() : ""}
                          </span>
                        </div>
                        {a.external_post_id && (
                          <p className="text-muted-foreground">Platform post id: {a.external_post_id}</p>
                        )}
                        {a.error_message && <p className="text-red-700">{a.error_message}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Measured engagement ({logMeasurements.length})
                  </p>
                  {logPost?.status === "published" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={handlePullMetrics}
                      disabled={metricsPulling}
                    >
                      <RefreshCw className={cn("h-3 w-3 mr-1", metricsPulling && "animate-spin")} />
                      Pull latest metrics
                    </Button>
                  )}
                </div>
                {logMeasurements.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No engagement has been measured for this post yet. Metrics come from
                    the nightly platform analytics sync — nothing here is estimated.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {logMeasurements.map((m: any) => (
                      <div key={m.id} className="rounded border p-2 text-xs">
                        <p className="text-muted-foreground mb-1">
                          {m.captured_at ? new Date(m.captured_at).toLocaleString() : ""} · {m.platform}
                        </p>
                        <div className="flex items-center gap-4 flex-wrap">
                          <span className="flex items-center gap-1"><Eye className="h-3 w-3" />{m.impressions_count ?? 0}</span>
                          <span className="flex items-center gap-1"><ThumbsUp className="h-3 w-3" />{m.likes_count ?? 0}</span>
                          <span className="flex items-center gap-1"><MessageCircle className="h-3 w-3" />{m.comments_count ?? 0}</span>
                          <span className="flex items-center gap-1"><Share2 className="h-3 w-3" />{m.shares_count ?? 0}</span>
                          <span>Clicks {m.clicks_count ?? 0}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Post Composer Dialog */}
      <PostComposerDialog
        open={composerOpen}
        onOpenChange={setComposerOpen}
        userId={userId}
        agentId={userId}
        brokerageId={brokerageId}
        userRole={userRole}
        accounts={accounts}
        initialPost={editingPost ?? undefined}
        requiresBrokerApproval={requiresBrokerApproval}
        onSaved={(post) => {
          handlePostSaved(post)
          // approval_status, not status — 'pending_approval' is not a value the
          // social_posts.status CHECK constraint permits, so this never fired.
          if (requiresBrokerApproval && post?.approval_status === "pending") {
            setActiveTab("pending_approval")
          }
        }}
      />

      {/* Delete confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this post?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel the post. Published posts cannot be deleted. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={handleDeleteConfirm}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reschedule Dialog */}
      <Dialog open={!!reschedulingPostId} onOpenChange={(v) => !v && setReschedulingPostId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reschedule Post</DialogTitle>
            <DialogDescription>Choose a new date and time for this post</DialogDescription>
          </DialogHeader>
          <Input
            type="datetime-local"
            value={rescheduleDate}
            onChange={(e) => setRescheduleDate(e.target.value)}
          />
          <div className="flex gap-2 pt-2">
            <Button className="flex-1" onClick={() => reschedulingPostId && handleReschedule(reschedulingPostId)} disabled={!rescheduleDate || !!loadingPostId}>
              {loadingPostId ? <RefreshCw className="h-4 w-4 animate-spin mr-1" /> : null}
              Confirm
            </Button>
            <Button variant="outline" onClick={() => setReschedulingPostId(null)}>Cancel</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Performance Prediction Dialog */}
      <Dialog open={predictionDialogOpen} onOpenChange={setPredictionDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Performance Prediction</DialogTitle>
            <DialogDescription>AI-powered analysis of your content&apos;s potential performance</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {selectedPostForPrediction && (
              <div className="mb-4 p-3 bg-muted rounded-lg">
                <p className="text-sm line-clamp-2">{selectedPostForPrediction.content}</p>
                <p className="text-xs text-muted-foreground mt-1">{selectedPostForPrediction.platform}</p>
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
    </div>
  )
}
