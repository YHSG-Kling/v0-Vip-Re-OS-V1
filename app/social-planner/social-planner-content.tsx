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
import Link from "next/link"

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
            <Card className="border-2">
              <CardContent className="pt-16 pb-16">
                <div className="text-center">
                  <div className="bg-muted rounded-full p-6 w-fit mx-auto mb-4">
                    <BarChart3 className="h-12 w-12 text-muted-foreground" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">Detailed Analytics Coming Soon</h3>
                  <p className="text-muted-foreground max-w-md mx-auto leading-relaxed">
                    Track engagement metrics, reach, and performance across all platforms
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 4: Publishing Calendar */}
        <TabsContent value="calendar">
          <Card className="border-2">
            <CardHeader className="bg-muted/30">
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-primary" />
                Publishing Calendar
              </CardTitle>
              <CardDescription>Visualize your posting schedule across all platforms</CardDescription>
            </CardHeader>
            <CardContent className="pt-16 pb-16">
              <div className="text-center">
                <div className="bg-muted rounded-full p-6 w-fit mx-auto mb-4">
                  <Calendar className="h-12 w-12 text-muted-foreground" />
                </div>
                <h3 className="text-xl font-semibold mb-2">Calendar View Coming Soon</h3>
                <p className="text-muted-foreground max-w-md mx-auto leading-relaxed">
                  View and manage your content schedule with drag-and-drop calendar interface
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
