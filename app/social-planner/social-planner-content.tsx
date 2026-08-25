"use client"
import { useState, useEffect } from "react"
import {
  Share2,
  Instagram,
  Facebook,
  Linkedin,
  ShieldCheck,
  Calendar,
  BarChart3,
  Trash2,
  Twitter,
  Music,
  Activity,
  TrendingUp,
  Clock,
} from "lucide-react"
import { getSocialPosts, deleteSocialPost } from "../actions/social-publishing"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { VideoGenerationButtons } from "@/components/video/VideoGenerationButtons"

interface ComplianceEvent {
  id: string
  postId: string
  status: "PASS" | "WARN" | "FAIL"
  reason: string
  suggestion: string
  timestamp: string
}

interface SocialPlannerContentProps {
  userId?: string
  userRole?: string
}

export default function SocialPlannerContent({ userId, userRole }: SocialPlannerContentProps) {
  const [activeTab, setActiveTab] = useState("queue")
  const [posts, setPosts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [complianceLogs, setComplianceLogs] = useState<ComplianceEvent[]>([])

  useEffect(() => {
    loadData()
  }, [userId, userRole])

  const loadData = async () => {
    try {
      setLoading(true)
      const postsData = await getSocialPosts({ userId, userRole })
      setPosts(postsData)
    } catch (error) {
      console.error("[v0] Failed to load social data:", error)
      setPosts([])
    } finally {
      setLoading(false)
    }
  }

  const loadPosts = async () => {
    try {
      setLoading(true)
      const data = await getSocialPosts({ userId, userRole })
      setPosts(data)
    } catch (error) {
      console.error("[v0] Failed to load social posts:", error)
      setPosts([])
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (postId: string) => {
    try {
      await deleteSocialPost(postId, userId)
      setPosts(posts.filter((p) => p.id !== postId))
    } catch (error) {
      console.error("Failed to delete post:", error)
    }
  }

  const getPlatformIcon = (platform: string) => {
    switch (platform) {
      case "facebook":
        return <Facebook className="w-4 h-4" />
      case "instagram":
        return <Instagram className="w-4 h-4" />
      case "linkedin":
        return <Linkedin className="w-4 h-4" />
      case "twitter":
        return <Twitter className="w-4 h-4" />
      case "tiktok":
        return <Music className="w-4 h-4" />
      default:
        return <Share2 className="w-4 h-4" />
    }
  }

  if (loading) {
    return (
      <div className="p-8 max-w-7xl mx-auto flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading Social Planner...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="bg-gradient-to-r from-blue-500/10 via-purple-500/5 to-background rounded-xl p-6 border">
        <h1 className="text-3xl lg:text-4xl font-bold mb-2 text-balance">Social Planner</h1>
        <p className="text-muted-foreground text-lg">
          Schedule and manage social media posts across all your connected platforms
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="grid w-full grid-cols-2 lg:grid-cols-4 gap-2 h-auto bg-muted/50 p-2 rounded-xl">
          <TabsTrigger
            value="queue"
            className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-background data-[state=active]:shadow-sm"
          >
            <Share2 className="h-5 w-5" />
            <span className="text-xs font-medium">Post Queue</span>
          </TabsTrigger>
          <TabsTrigger
            value="compliance"
            className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-background data-[state=active]:shadow-sm"
          >
            <ShieldCheck className="h-5 w-5" />
            <span className="text-xs font-medium">Compliance Audit</span>
          </TabsTrigger>
          <TabsTrigger
            value="analytics"
            className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-background data-[state=active]:shadow-sm"
          >
            <BarChart3 className="h-5 w-5" />
            <span className="text-xs font-medium">Performance</span>
          </TabsTrigger>
          <TabsTrigger
            value="calendar"
            className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-background data-[state=active]:shadow-sm"
          >
            <Calendar className="h-5 w-5" />
            <span className="text-xs font-medium">Publishing Calendar</span>
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Post Queue */}
        <TabsContent value="queue">
          <Card className="border-2">
            <CardHeader className="bg-muted/30">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Share2 className="h-5 w-5 text-primary" />
                    Scheduled Posts
                  </CardTitle>
                  <CardDescription>View and manage your upcoming social media posts</CardDescription>
                </div>
                <Badge variant="secondary" className="text-base px-3 py-1">
                  {posts.length} posts
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              {posts.length === 0 ? (
                <div className="text-center py-16 border-2 border-dashed rounded-xl">
                  <div className="bg-muted rounded-full p-6 w-fit mx-auto mb-4">
                    <Share2 className="h-12 w-12 text-muted-foreground" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">No scheduled posts yet</h3>
                  <p className="text-muted-foreground max-w-md mx-auto leading-relaxed">
                    Create posts in the Content & Marketing Studio and schedule them here
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {posts.map((post) => (
                    <Card key={post.id} className="border-2 hover:shadow-md transition-shadow">
                      <CardContent className="pt-6">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 space-y-3">
                            <div className="flex items-center gap-2 flex-wrap">
                              {post.platforms?.map((platform: string) => (
                                <Badge key={platform} variant="outline" className="px-3 py-1">
                                  {platform === "facebook" && <Facebook className="w-4 h-4" />}
                                  {platform === "instagram" && <Instagram className="w-4 h-4" />}
                                  {platform === "linkedin" && <Linkedin className="w-4 h-4" />}
                                  {platform === "twitter" && <Twitter className="w-4 h-4" />}
                                  {platform === "tiktok" && <Music className="w-4 h-4" />}
                                  {!["facebook", "instagram", "linkedin", "twitter", "tiktok"].includes(platform) && (
                                    <Share2 className="w-4 h-4" />
                                  )}
                                  <span className="ml-2 capitalize font-medium">{platform}</span>
                                </Badge>
                              ))}
                            </div>
                            <p className="text-base leading-relaxed">{post.content}</p>
                            <div className="flex items-center gap-4 text-sm text-muted-foreground pt-2">
                              <div className="flex items-center gap-1.5">
                                <Clock className="h-4 w-4" />
                                <span>{new Date(post.scheduled_for).toLocaleString()}</span>
                              </div>
                              <Badge
                                variant={post.status === "published" ? "default" : "secondary"}
                                className="capitalize"
                              >
                                {post.status}
                              </Badge>
                            </div>
                            {post.content && (
                              <div className="mt-3 pt-3 border-t">
                                <VideoGenerationButtons
                                  script={post.content}
                                  title={`Social Post - ${post.platform}`}
                                  userId={userId}
                                  size="sm"
                                  className="mt-2"
                                />
                              </div>
                            )}
                          </div>
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(post.id)} className="shrink-0">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 2: Compliance Audit */}
        <TabsContent value="compliance">
          <Card className="border-2">
            <CardHeader className="bg-muted/30">
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" />
                Compliance Logs
              </CardTitle>
              <CardDescription>Track Fair Housing Act and NAR compliance for all posts</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              {complianceLogs.length === 0 ? (
                <div className="text-center py-16 border-2 border-dashed rounded-xl bg-green-50 dark:bg-green-950/20">
                  <div className="bg-green-100 dark:bg-green-900/30 rounded-full p-6 w-fit mx-auto mb-4">
                    <ShieldCheck className="h-12 w-12 text-green-600 dark:text-green-400" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2 text-green-900 dark:text-green-100">All Posts Compliant</h3>
                  <p className="text-green-700 dark:text-green-300 max-w-md mx-auto leading-relaxed">
                    No compliance issues detected across your scheduled posts
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {complianceLogs.map((log) => (
                    <Card key={log.id} className="border-2">
                      <CardContent className="pt-6">
                        <div className="flex items-start gap-4">
                          <Badge
                            variant={
                              log.status === "PASS" ? "default" : log.status === "WARN" ? "secondary" : "destructive"
                            }
                            className="shrink-0 px-3 py-1 text-sm"
                          >
                            {log.status}
                          </Badge>
                          <div className="flex-1 space-y-2">
                            <p className="font-semibold text-base">{log.reason}</p>
                            <p className="text-muted-foreground leading-relaxed">{log.suggestion}</p>
                            <p className="text-xs text-muted-foreground pt-2">
                              {new Date(log.timestamp).toLocaleString()}
                            </p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Performance */}
        <TabsContent value="analytics">
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <Card className="border-2 hover:shadow-lg transition-shadow">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground font-medium">Total Posts</p>
                      <p className="text-4xl font-bold">{posts.length}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <TrendingUp className="h-3 w-3 text-green-600" />
                        All platforms
                      </p>
                    </div>
                    <div className="bg-blue-100 dark:bg-blue-900/30 rounded-full p-4">
                      <Activity className="h-8 w-8 text-blue-600 dark:text-blue-400" />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-2 hover:shadow-lg transition-shadow">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground font-medium">Published</p>
                      <p className="text-4xl font-bold">{posts.filter((p) => p.status === "published").length}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <ShieldCheck className="h-3 w-3 text-green-600" />
                        Live now
                      </p>
                    </div>
                    <div className="bg-green-100 dark:bg-green-900/30 rounded-full p-4">
                      <ShieldCheck className="h-8 w-8 text-green-600 dark:text-green-400" />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-2 hover:shadow-lg transition-shadow">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground font-medium">Scheduled</p>
                      <p className="text-4xl font-bold">{posts.filter((p) => p.status === "scheduled").length}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3 text-orange-600" />
                        Upcoming
                      </p>
                    </div>
                    <div className="bg-orange-100 dark:bg-orange-900/30 rounded-full p-4">
                      <Calendar className="h-8 w-8 text-orange-600 dark:text-orange-400" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
            {/* Real analytics derived from posts already in state */}
            {(() => {
              const published  = posts.filter(p => p.status === "published" || p.status === "sent")
              const scheduled  = posts.filter(p => p.status === "scheduled" || p.status === "pending")
              const failed     = posts.filter(p => p.status === "failed" || p.status === "error")

              const platformCounts: Record<string, number> = {}
              posts.forEach(p => {
                const platforms: string[] = Array.isArray(p.platforms) ? p.platforms : (p.platform ? [p.platform] : [])
                platforms.forEach((pl: string) => { platformCounts[pl] = (platformCounts[pl] || 0) + 1 })
              })
              const platformEntries = Object.entries(platformCounts).sort((a, b) => b[1] - a[1])

              const contentTypes: Record<string, number> = {}
              posts.forEach(p => {
                const type = p.content_type || p.type || "post"
                contentTypes[type] = (contentTypes[type] || 0) + 1
              })

              // Posts by day of week
              const dayLabels = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
              const byDay: number[] = [0,0,0,0,0,0,0]
              posts.forEach(p => {
                const d = p.scheduled_for || p.created_at
                if (d) byDay[new Date(d).getDay()]++
              })
              const maxDay = Math.max(...byDay, 1)

              return (
                <div className="space-y-6">
                  {/* Summary row */}
                  <div className="grid grid-cols-3 gap-4">
                    <Card>
                      <CardContent className="pt-5 pb-5">
                        <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Total Posts</p>
                        <p className="text-3xl font-bold">{posts.length}</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="pt-5 pb-5">
                        <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Published</p>
                        <p className="text-3xl font-bold text-green-600">{published.length}</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="pt-5 pb-5">
                        <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Scheduled</p>
                        <p className="text-3xl font-bold text-blue-600">{scheduled.length}</p>
                      </CardContent>
                    </Card>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Platform breakdown */}
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">Posts by Platform</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {platformEntries.length === 0 ? (
                          <p className="text-sm text-muted-foreground py-4 text-center">No posts yet</p>
                        ) : (
                          <div className="space-y-3">
                            {platformEntries.map(([platform, count]) => (
                              <div key={platform} className="flex items-center gap-3">
                                <div className="w-24 shrink-0 text-sm capitalize">{platform}</div>
                                <div className="flex-1 bg-muted rounded-full h-2.5">
                                  <div
                                    className="bg-primary h-2.5 rounded-full transition-all"
                                    style={{ width: `${(count / posts.length) * 100}%` }}
                                  />
                                </div>
                                <span className="text-sm font-medium w-6 text-right">{count}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {/* Posts by day of week */}
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">Posting Activity by Day</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="flex items-end gap-2 h-24">
                          {byDay.map((count, i) => (
                            <div key={i} className="flex flex-col items-center gap-1 flex-1">
                              <div className="w-full flex items-end justify-center" style={{ height: "72px" }}>
                                <div
                                  className="w-full bg-primary/80 rounded-t transition-all"
                                  style={{ height: `${(count / maxDay) * 72}px`, minHeight: count > 0 ? "4px" : "0" }}
                                />
                              </div>
                              <span className="text-[10px] text-muted-foreground">{dayLabels[i]}</span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Content type breakdown */}
                  {Object.keys(contentTypes).length > 0 && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">Content Types</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(contentTypes).map(([type, count]) => (
                            <div key={type} className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-lg">
                              <span className="text-sm capitalize">{type.replace(/_/g, " ")}</span>
                              <span className="text-xs font-bold text-primary">{count}</span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {failed.length > 0 && (
                    <Card className="border-destructive/40">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-destructive">Failed Posts ({failed.length})</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {failed.map(p => (
                            <div key={p.id} className="flex items-center justify-between text-sm p-2 bg-destructive/5 rounded">
                              <span className="truncate flex-1">{p.content?.slice(0,60) ?? "No content"}...</span>
                              <Badge variant="destructive" className="ml-2 shrink-0">Failed</Badge>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )
            })()}
          </div>
        </TabsContent>

        {/* Tab 4: Publishing Calendar — real 5-week grid built from posts in state */}
        <TabsContent value="calendar">
          <Card className="border-2">
            <CardHeader className="bg-muted/30">
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-primary" />
                Publishing Calendar
              </CardTitle>
              <CardDescription>Your content schedule for the next 5 weeks</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              {(() => {
                const today = new Date()
                today.setHours(0,0,0,0)
                // Build 35-day grid starting from the nearest Sunday before today
                const startOfGrid = new Date(today)
                startOfGrid.setDate(today.getDate() - today.getDay())

                // Index posts by their date string YYYY-MM-DD
                const postsByDate: Record<string, any[]> = {}
                posts.forEach(p => {
                  const raw = p.scheduled_for || p.created_at
                  if (!raw) return
                  const key = new Date(raw).toISOString().split("T")[0]
                  postsByDate[key] = postsByDate[key] ? [...postsByDate[key], p] : [p]
                })

                const dayLabels = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
                const cells: Date[] = []
                for (let i = 0; i < 35; i++) {
                  const d = new Date(startOfGrid)
                  d.setDate(startOfGrid.getDate() + i)
                  cells.push(d)
                }

                const platformColors: Record<string, string> = {
                  facebook:  "bg-blue-500",
                  instagram: "bg-pink-500",
                  linkedin:  "bg-sky-600",
                  twitter:   "bg-sky-400",
                  tiktok:    "bg-black",
                }

                return (
                  <div>
                    {/* Day headers */}
                    <div className="grid grid-cols-7 mb-1">
                      {dayLabels.map(d => (
                        <div key={d} className="text-center text-xs font-medium text-muted-foreground py-1">{d}</div>
                      ))}
                    </div>
                    {/* Calendar cells */}
                    <div className="grid grid-cols-7 gap-1">
                      {cells.map((day, i) => {
                        const key = day.toISOString().split("T")[0]
                        const dayPosts = postsByDate[key] || []
                        const isToday = day.getTime() === today.getTime()
                        const isPast  = day < today

                        return (
                          <div
                            key={i}
                            className={`min-h-[72px] rounded-lg border p-1.5 flex flex-col gap-1 transition-colors
                              ${isToday ? "border-primary bg-primary/5" : "border-border"}
                              ${isPast  ? "opacity-60" : ""}
                            `}
                          >
                            <span className={`text-xs font-medium ${isToday ? "text-primary" : "text-muted-foreground"}`}>
                              {day.getDate()}
                            </span>
                            {dayPosts.slice(0, 3).map((p, j) => {
                              const platform = Array.isArray(p.platforms) ? p.platforms[0] : (p.platform || "other")
                              const colorClass = platformColors[platform] || "bg-primary"
                              return (
                                <div
                                  key={j}
                                  title={p.content?.slice(0, 80) ?? "Post"}
                                  className={`${colorClass} text-white rounded px-1 py-0.5 text-[9px] truncate`}
                                >
                                  {platform}
                                </div>
                              )
                            })}
                            {dayPosts.length > 3 && (
                              <span className="text-[9px] text-muted-foreground">+{dayPosts.length - 3}</span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    {posts.length === 0 && (
                      <p className="text-center text-sm text-muted-foreground mt-6">
                        No scheduled posts yet. Create posts to see them appear on the calendar.
                      </p>
                    )}
                  </div>
                )
              })()}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
