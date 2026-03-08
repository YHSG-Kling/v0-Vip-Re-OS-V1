"use client"

import { useState, useEffect } from "react"
import {
  RefreshCw,
  Video,
  FileText,
  MessageSquare,
  Instagram,
  Youtube,
  Facebook,
  Linkedin,
  Twitter,
  Music2,
  CheckCircle2,
  Clock,
  AlertCircle,
  ArrowRight,
  Sparkles,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { getRepurposedContentLogs } from "@/app/actions/video-repurposing"

interface RepurposingQueueProps {
  brokerageId: string
}

const SOURCE_ICONS: Record<string, React.ReactNode> = {
  video_project: <Video className="h-4 w-4" />,
  video_asset: <Video className="h-4 w-4" />,
  script: <FileText className="h-4 w-4" />,
  social_post: <MessageSquare className="h-4 w-4" />,
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

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  created: { icon: <Clock className="h-3 w-3" />, color: "bg-blue-500", label: "Processing" },
  processing: { icon: <RefreshCw className="h-3 w-3 animate-spin" />, color: "bg-yellow-500", label: "In Progress" },
  completed: { icon: <CheckCircle2 className="h-3 w-3" />, color: "bg-green-500", label: "Completed" },
  failed: { icon: <AlertCircle className="h-3 w-3" />, color: "bg-red-500", label: "Failed" },
}

export function RepurposingQueue({ brokerageId }: RepurposingQueueProps) {
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadLogs()
  }, [brokerageId])

  const loadLogs = async () => {
    try {
      setLoading(true)
      const data = await getRepurposedContentLogs({ brokerageId })
      setLogs(data)
    } catch (error) {
      console.error("[v0] Failed to load repurposing logs:", error)
    } finally {
      setLoading(false)
    }
  }

  const stats = {
    total: logs.length,
    completed: logs.filter(l => l.status === "completed").length,
    processing: logs.filter(l => l.status === "processing" || l.status === "created").length,
    failed: logs.filter(l => l.status === "failed").length,
  }

  const completionRate = stats.total > 0 ? (stats.completed / stats.total) * 100 : 0

  if (loading) {
    return (
      <Card className="border-2">
        <CardContent className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-2">
      <CardHeader className="bg-muted/30">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-primary" />
              Content Repurposing Activity
            </CardTitle>
            <CardDescription>Track your content transformation pipeline</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={loadLogs}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-6 space-y-6">
        {/* Stats Overview */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center p-4 bg-muted/50 rounded-lg">
            <p className="text-3xl font-bold">{stats.total}</p>
            <p className="text-sm text-muted-foreground">Total Items</p>
          </div>
          <div className="text-center p-4 bg-green-500/10 rounded-lg">
            <p className="text-3xl font-bold text-green-600">{stats.completed}</p>
            <p className="text-sm text-muted-foreground">Completed</p>
          </div>
          <div className="text-center p-4 bg-yellow-500/10 rounded-lg">
            <p className="text-3xl font-bold text-yellow-600">{stats.processing}</p>
            <p className="text-sm text-muted-foreground">Processing</p>
          </div>
          <div className="text-center p-4 bg-red-500/10 rounded-lg">
            <p className="text-3xl font-bold text-red-600">{stats.failed}</p>
            <p className="text-sm text-muted-foreground">Failed</p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Completion Rate</span>
            <span className="font-medium">{completionRate.toFixed(0)}%</span>
          </div>
          <Progress value={completionRate} className="h-2" />
        </div>

        {/* Recent Activity */}
        {logs.length === 0 ? (
          <div className="text-center py-12 border-2 border-dashed rounded-xl">
            <div className="bg-muted rounded-full p-4 w-fit mx-auto mb-3">
              <Sparkles className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-semibold mb-1">No repurposing activity yet</h3>
            <p className="text-sm text-muted-foreground">
              Start creating snippets to see your content transformation history
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <h4 className="font-medium text-sm text-muted-foreground">Recent Activity</h4>
            <div className="space-y-2">
              {logs.slice(0, 10).map((log) => {
                const status = STATUS_CONFIG[log.status] || STATUS_CONFIG.created

                return (
                  <div
                    key={log.id}
                    className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    {/* Source */}
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className="bg-background p-2 rounded-lg border">
                        {SOURCE_ICONS[log.source_type] || <Video className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium capitalize truncate">
                          {log.source_type?.replace(/_/g, " ")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(log.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>

                    {/* Arrow */}
                    <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />

                    {/* Output */}
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {log.platform_target && (
                        <div className="bg-background p-2 rounded-lg border">
                          {PLATFORM_ICONS[log.platform_target] || <MessageSquare className="h-4 w-4" />}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium capitalize truncate">
                          {log.output_type?.replace(/_/g, " ")}
                        </p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {log.platform_target?.replace(/_/g, " ") || "Multiple platforms"}
                        </p>
                      </div>
                    </div>

                    {/* Status */}
                    <Badge variant="outline" className={`shrink-0 gap-1 ${status.color} text-white border-0`}>
                      {status.icon}
                      {status.label}
                    </Badge>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
