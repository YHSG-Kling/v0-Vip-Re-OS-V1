"use client"

import { useState, useEffect } from "react"
import {
  Scissors,
  Instagram,
  Youtube,
  Linkedin,
  Twitter,
  Music2,
  Facebook,
  Clock,
  Calendar,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Play,
  Trash2,
  Send,
  Eye,
  Filter,
  MoreHorizontal,
  Sparkles,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  getVideoSnippets,
  updateSnippetApprovalStatus,
  deleteSnippet,
  scheduleSnippetToSocial,
  type PlatformTarget,
  type SnippetApprovalStatus,
} from "@/app/actions/video-repurposing"

interface SnippetsDashboardProps {
  brokerageId: string
  userId?: string
}

const PLATFORM_ICONS: Record<string, React.ReactNode> = {
  instagram_reels: <Instagram className="h-4 w-4" />,
  instagram_story: <Instagram className="h-4 w-4" />,
  instagram_post: <Instagram className="h-4 w-4" />,
  tiktok: <Music2 className="h-4 w-4" />,
  youtube_shorts: <Youtube className="h-4 w-4" />,
  facebook_reels: <Facebook className="h-4 w-4" />,
  linkedin: <Linkedin className="h-4 w-4" />,
  twitter: <Twitter className="h-4 w-4" />,
}

const PLATFORM_COLORS: Record<string, string> = {
  instagram_reels: "bg-gradient-to-tr from-purple-500 to-pink-500",
  instagram_story: "bg-gradient-to-tr from-yellow-500 to-pink-500",
  instagram_post: "bg-gradient-to-tr from-purple-500 to-pink-500",
  tiktok: "bg-black",
  youtube_shorts: "bg-red-600",
  facebook_reels: "bg-blue-600",
  linkedin: "bg-blue-700",
  twitter: "bg-sky-500",
}

const STATUS_CONFIG: Record<SnippetApprovalStatus, { icon: React.ReactNode; label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { icon: <AlertCircle className="h-3 w-3" />, label: "Pending", variant: "secondary" },
  approved: { icon: <CheckCircle2 className="h-3 w-3" />, label: "Approved", variant: "default" },
  rejected: { icon: <XCircle className="h-3 w-3" />, label: "Rejected", variant: "destructive" },
}

export function SnippetsDashboard({ brokerageId, userId }: SnippetsDashboardProps) {
  const [snippets, setSnippets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<"all" | SnippetApprovalStatus>("all")
  const [platformFilter, setPlatformFilter] = useState<PlatformTarget | "all">("all")
  const [scheduleDialog, setScheduleDialog] = useState<{ open: boolean; snippet: any | null }>({ open: false, snippet: null })
  const [scheduleDate, setScheduleDate] = useState("")
  const [scheduleTime, setScheduleTime] = useState("")

  useEffect(() => {
    loadSnippets()
  }, [brokerageId, activeTab, platformFilter])

  const loadSnippets = async () => {
    setLoading(true)
    try {
      const filters: any = { brokerageId }
      if (activeTab !== "all") {
        filters.approvalStatus = activeTab
      }
      if (platformFilter !== "all") {
        filters.platformTarget = platformFilter
      }
      const data = await getVideoSnippets(filters)
      setSnippets(data)
    } catch (error) {
      console.error("[v0] Failed to load snippets:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleApprove = async (snippetId: string) => {
    try {
      await updateSnippetApprovalStatus(snippetId, brokerageId, "approved", userId)
      loadSnippets()
    } catch (error) {
      console.error("[v0] Failed to approve snippet:", error)
    }
  }

  const handleReject = async (snippetId: string) => {
    try {
      await updateSnippetApprovalStatus(snippetId, brokerageId, "rejected", userId)
      loadSnippets()
    } catch (error) {
      console.error("[v0] Failed to reject snippet:", error)
    }
  }

  const handleDelete = async (snippetId: string) => {
    try {
      await deleteSnippet(snippetId)
      loadSnippets()
    } catch (error) {
      console.error("[v0] Failed to delete snippet:", error)
    }
  }

  const handleSchedule = async () => {
    if (!scheduleDialog.snippet || !scheduleDate || !scheduleTime) return
    
    try {
      const scheduledFor = `${scheduleDate}T${scheduleTime}:00.000Z`
      await scheduleSnippetToSocial({
        snippetId: scheduleDialog.snippet.id,
        brokerageId,
        scheduledFor,
        userId,
      })
      setScheduleDialog({ open: false, snippet: null })
      setScheduleDate("")
      setScheduleTime("")
      loadSnippets()
    } catch (error) {
      console.error("[v0] Failed to schedule snippet:", error)
    }
  }

  const stats = {
    total: snippets.length,
    pending: snippets.filter(s => s.approval_status === "pending").length,
    approved: snippets.filter(s => s.approval_status === "approved").length,
    rejected: snippets.filter(s => s.approval_status === "rejected").length,
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading snippets...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="border-2">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Snippets</p>
                <p className="text-3xl font-bold">{stats.total}</p>
              </div>
              <div className="bg-primary/10 p-3 rounded-full">
                <Scissors className="h-6 w-6 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-2">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Pending Review</p>
                <p className="text-3xl font-bold">{stats.pending}</p>
              </div>
              <div className="bg-yellow-500/10 p-3 rounded-full">
                <AlertCircle className="h-6 w-6 text-yellow-500" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-2">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Approved</p>
                <p className="text-3xl font-bold">{stats.approved}</p>
              </div>
              <div className="bg-green-500/10 p-3 rounded-full">
                <CheckCircle2 className="h-6 w-6 text-green-500" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-2">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Rejected</p>
                <p className="text-3xl font-bold">{stats.rejected}</p>
              </div>
              <div className="bg-red-500/10 p-3 rounded-full">
                <XCircle className="h-6 w-6 text-red-500" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <Card className="border-2">
        <CardHeader className="bg-muted/30">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Scissors className="h-5 w-5 text-primary" />
                Video Snippets Library
              </CardTitle>
              <CardDescription>Manage and schedule your video clips across platforms</CardDescription>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <Filter className="h-4 w-4" />
                  {platformFilter === "all" ? "All Platforms" : platformFilter.replace(/_/g, " ")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setPlatformFilter("all")}>All Platforms</DropdownMenuItem>
                <DropdownMenuSeparator />
                {Object.keys(PLATFORM_ICONS).map(platform => (
                  <DropdownMenuItem
                    key={platform}
                    onClick={() => setPlatformFilter(platform as PlatformTarget)}
                    className="gap-2"
                  >
                    {PLATFORM_ICONS[platform]}
                    {platform.replace(/_/g, " ")}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
            <TabsList className="grid w-full grid-cols-4 mb-6">
              <TabsTrigger value="all" className="gap-2">
                All
                <Badge variant="secondary" className="ml-1">{stats.total}</Badge>
              </TabsTrigger>
              <TabsTrigger value="pending" className="gap-2">
                Pending
                <Badge variant="secondary" className="ml-1">{stats.pending}</Badge>
              </TabsTrigger>
              <TabsTrigger value="approved" className="gap-2">
                Approved
                <Badge variant="secondary" className="ml-1">{stats.approved}</Badge>
              </TabsTrigger>
              <TabsTrigger value="rejected" className="gap-2">
                Rejected
                <Badge variant="secondary" className="ml-1">{stats.rejected}</Badge>
              </TabsTrigger>
            </TabsList>

            {snippets.length === 0 ? (
              <div className="text-center py-16 border-2 border-dashed rounded-xl">
                <div className="bg-muted rounded-full p-6 w-fit mx-auto mb-4">
                  <Scissors className="h-12 w-12 text-muted-foreground" />
                </div>
                <h3 className="text-xl font-semibold mb-2">No snippets yet</h3>
                <p className="text-muted-foreground max-w-md mx-auto">
                  Create snippets from your videos using the Snippet Generator
                </p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {snippets.map(snippet => {
                  const status = STATUS_CONFIG[snippet.approval_status as SnippetApprovalStatus]
                  const duration = snippet.end_seconds - snippet.start_seconds

                  return (
                    <Card key={snippet.id} className="border-2 overflow-hidden">
                      {/* Thumbnail/Preview */}
                      <div className="relative aspect-video bg-muted">
                        {snippet.thumbnail_url ? (
                          <img
                            src={snippet.thumbnail_url}
                            alt={snippet.snippet_title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Play className="h-12 w-12 text-muted-foreground" />
                          </div>
                        )}
                        
                        {/* Platform Badge */}
                        <div className={`absolute top-2 left-2 p-2 rounded-lg ${PLATFORM_COLORS[snippet.platform_target]} text-white`}>
                          {PLATFORM_ICONS[snippet.platform_target]}
                        </div>
                        
                        {/* Duration Badge */}
                        <Badge className="absolute bottom-2 right-2 bg-black/70">
                          <Clock className="h-3 w-3 mr-1" />
                          {duration}s
                        </Badge>
                      </div>

                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <h4 className="font-semibold truncate">{snippet.snippet_title}</h4>
                            <p className="text-xs text-muted-foreground">
                              {snippet.platform_target.replace(/_/g, " ")} · {snippet.aspect_ratio}
                            </p>
                          </div>
                          <Badge variant={status.variant} className="gap-1 shrink-0">
                            {status.icon}
                            {status.label}
                          </Badge>
                        </div>

                        {snippet.caption_text && (
                          <p className="text-sm text-muted-foreground line-clamp-2">
                            {snippet.caption_text}
                          </p>
                        )}

                        {snippet.hashtags && snippet.hashtags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {snippet.hashtags.slice(0, 3).map((tag: string, i: number) => (
                              <Badge key={i} variant="outline" className="text-xs">
                                #{tag}
                              </Badge>
                            ))}
                            {snippet.hashtags.length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{snippet.hashtags.length - 3}
                              </Badge>
                            )}
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-2 pt-2">
                          {snippet.approval_status === "pending" && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                className="flex-1 text-green-600 border-green-600 hover:bg-green-50"
                                onClick={() => handleApprove(snippet.id)}
                              >
                                <CheckCircle2 className="h-4 w-4 mr-1" />
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="flex-1 text-red-600 border-red-600 hover:bg-red-50"
                                onClick={() => handleReject(snippet.id)}
                              >
                                <XCircle className="h-4 w-4 mr-1" />
                                Reject
                              </Button>
                            </>
                          )}
                          {snippet.approval_status === "approved" && (
                            <Button
                              size="sm"
                              className="flex-1 gap-1"
                              onClick={() => setScheduleDialog({ open: true, snippet })}
                            >
                              <Calendar className="h-4 w-4" />
                              Schedule
                            </Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem className="gap-2">
                                <Eye className="h-4 w-4" />
                                Preview
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="gap-2 text-destructive"
                                onClick={() => handleDelete(snippet.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </Tabs>
        </CardContent>
      </Card>

      {/* Schedule Dialog */}
      <Dialog open={scheduleDialog.open} onOpenChange={(open) => setScheduleDialog({ open, snippet: open ? scheduleDialog.snippet : null })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5 text-primary" />
              Schedule Snippet
            </DialogTitle>
            <DialogDescription>
              Schedule "{scheduleDialog.snippet?.snippet_title}" to be published on {scheduleDialog.snippet?.platform_target?.replace(/_/g, " ")}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input
                type="date"
                value={scheduleDate}
                onChange={(e) => setScheduleDate(e.target.value)}
                min={new Date().toISOString().split("T")[0]}
              />
            </div>
            <div className="space-y-2">
              <Label>Time (UTC)</Label>
              <Input
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setScheduleDialog({ open: false, snippet: null })}>
              Cancel
            </Button>
            <Button onClick={handleSchedule} disabled={!scheduleDate || !scheduleTime}>
              <Send className="h-4 w-4 mr-2" />
              Schedule Post
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
