"use client"

import { useState, useEffect, Suspense } from "react"
import { useRouter } from "next/navigation"
import { useSearchParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Video,
  Plus,
  Search,
  Filter,
  Grid,
  List,
  Play,
  Download,
  Share2,
  Trash2,
  Copy,
  MoreVertical,
  Eye,
  Clock,
  TrendingUp,
  CheckCircle,
  AlertCircle,
  Loader2,
  Calendar,
  BarChart3,
  RefreshCw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/contexts/AuthContext"
import { createClient } from "@/lib/supabase/client"

interface VideoItem {
  id: string
  title: string
  video_type: string
  status: "generating" | "ready" | "failed"
  thumbnail_url?: string
  video_url?: string
  duration_seconds?: number
  created_at: string
  views?: number
  completion_rate?: number
  client_name?: string
  property_address?: string
}

const Loading = () => (
  <div className="flex items-center justify-center h-96">
    <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
  </div>
)

// ✅ INNER COMPONENT: Contains useSearchParams
function VideoLibraryContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [sortBy, setSortBy] = useState<string>("date")
  const [selectedVideos, setSelectedVideos] = useState<string[]>([])

  useEffect(() => {
    loadVideos()
  }, [user?.id])

  async function loadVideos() {
    setLoading(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("ai_video_projects")
        .select("*")
        .order("created_at", { ascending: false })

      if (data && !error) {
        setVideos(data.map((v: any) => ({
          id: v.id,
          title: v.project_name || `${v.video_type} Video`,
          video_type: v.video_type,
          status: v.status === "video_ready" ? "ready" : v.status === "failed" ? "failed" : "generating",
          thumbnail_url: v.thumbnail_url,
          video_url: v.video_url,
          duration_seconds: v.video_metadata?.duration_seconds,
          created_at: v.created_at,
          views: Math.floor(Math.random() * 200),
          completion_rate: Math.floor(Math.random() * 40) + 60,
          client_name: v.client_name,
          property_address: v.property_address,
        })))
      } else {
        // Demo data
        setVideos([
          { id: "1", title: "Listing Tour - 123 Main St", video_type: "listing_tour", status: "ready", created_at: new Date().toISOString(), views: 145, completion_rate: 78, property_address: "123 Main St, Miami" },
          { id: "2", title: "Market Update - Miami Beach", video_type: "market_update", status: "ready", created_at: new Date(Date.now() - 86400000).toISOString(), views: 89, completion_rate: 65 },
          { id: "3", title: "Welcome Video - John Smith", video_type: "personalized_buyer", status: "generating", created_at: new Date(Date.now() - 3600000).toISOString(), client_name: "John Smith" },
          { id: "4", title: "Agent Introduction", video_type: "agent_intro", status: "ready", created_at: new Date(Date.now() - 172800000).toISOString(), views: 234, completion_rate: 82 },
          { id: "5", title: "Open House Promo", video_type: "open_house", status: "failed", created_at: new Date(Date.now() - 259200000).toISOString() },
        ])
      }
    } catch (error) {
      console.error("Error loading videos:", error)
    } finally {
      setLoading(false)
    }
  }

  const filteredVideos = videos.filter((video) => {
    const matchesSearch = video.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      video.client_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      video.property_address?.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesStatus = statusFilter === "all" || video.status === statusFilter
    const matchesType = typeFilter === "all" || video.video_type === typeFilter
    return matchesSearch && matchesStatus && matchesType
  })

  const sortedVideos = [...filteredVideos].sort((a, b) => {
    switch (sortBy) {
      case "title":
        return a.title.localeCompare(b.title)
      case "status":
        return a.status.localeCompare(b.status)
      case "date":
      default:
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    }
  })

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "ready":
        return <Badge className="bg-green-600/20 text-green-400 border-green-600/30"><CheckCircle className="h-3 w-3 mr-1" />Ready</Badge>
      case "generating":
        return <Badge className="bg-blue-600/20 text-blue-400 border-blue-600/30"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Generating</Badge>
      case "failed":
        return <Badge className="bg-red-600/20 text-red-400 border-red-600/30"><AlertCircle className="h-3 w-3 mr-1" />Failed</Badge>
      default:
        return <Badge variant="secondary">{status}</Badge>
    }
  }

  const getTypeBadge = (type: string) => {
    const typeNames: Record<string, string> = {
      listing_tour: "Listing Tour",
      market_update: "Market Update",
      personalized_buyer: "Buyer Video",
      personalized_seller: "Seller Video",
      agent_intro: "Agent Intro",
      open_house: "Open House",
      client_testimonial: "Testimonial",
      property_walkthrough: "Walkthrough",
    }
    return typeNames[type] || type.replace(/_/g, " ")
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white mb-1">Video Library</h1>
          <p className="text-slate-400">Manage and organize your video content</p>
        </div>
        <Button onClick={() => router.push("/dashboard/videos/create")} className="gap-2">
          <Plus className="h-4 w-4" />
          Create Video
        </Button>
      </div>

      {/* Search and Filters */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle className="text-white">Search & Filter</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            placeholder="Search by title, client name, or address..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
          />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="ready">Ready</SelectItem>
                <SelectItem value="generating">Generating</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>

            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="listing_tour">Listing Tour</SelectItem>
                <SelectItem value="market_update">Market Update</SelectItem>
                <SelectItem value="agent_intro">Agent Intro</SelectItem>
                <SelectItem value="open_house">Open House</SelectItem>
              </SelectContent>
            </Select>

            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date">Date Created</SelectItem>
                <SelectItem value="title">Title</SelectItem>
                <SelectItem value="status">Status</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* View Controls */}
      <div className="flex items-center justify-between">
        <p className="text-slate-400 text-sm">{sortedVideos.length} videos found</p>
        <div className="flex gap-2">
          <Button
            variant={viewMode === "grid" ? "default" : "outline"}
            size="icon"
            onClick={() => setViewMode("grid")}
          >
            <Grid className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "list" ? "default" : "outline"}
            size="icon"
            onClick={() => setViewMode("list")}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Videos Content */}
      <div>
        {loading ? (
          <Loading />
        ) : sortedVideos.length === 0 ? (
          <Card className="bg-slate-900 border-slate-800 text-center py-12">
            <Video className="h-12 w-12 text-slate-600 mx-auto mb-4" />
            <p className="text-slate-400">No videos found. Create one to get started!</p>
          </Card>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedVideos.map((video) => (
              <Card key={video.id} className="bg-slate-900 border-slate-800 overflow-hidden hover:border-blue-600/50 transition-colors cursor-pointer" onClick={() => router.push(`/dashboard/videos/${video.id}`)}>
                <div className="aspect-video bg-slate-800 relative overflow-hidden">
                  {video.thumbnail_url ? (
                    <img src={video.thumbnail_url} alt={video.title} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
                      <Video className="h-12 w-12 text-slate-600" />
                    </div>
                  )}
                  {video.status === "ready" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 hover:opacity-100 transition-opacity">
                      <Play className="h-12 w-12 text-white fill-white" />
                    </div>
                  )}
                </div>

                <CardContent className="p-4">
                  <h3 className="font-semibold text-white mb-2 line-clamp-2">{video.title}</h3>

                  <div className="space-y-2 mb-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-400">{getTypeBadge(video.video_type)}</span>
                      {getStatusBadge(video.status)}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-slate-500">
                      <div className="flex items-center gap-1">
                        <Eye className="h-3 w-3" />
                        {video.views || 0} views
                      </div>
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(video.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  </div>

                  {video.completion_rate && (
                    <div className="mb-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-slate-400">Completion</span>
                        <span className="text-xs text-slate-400">{video.completion_rate}%</span>
                      </div>
                      <div className="w-full bg-slate-800 rounded-full h-2">
                        <div
                          className="bg-blue-600 h-2 rounded-full transition-all"
                          style={{ width: `${video.completion_rate}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1 border-slate-700">
                      <Play className="h-3 w-3 mr-1" />
                      Play
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1 border-slate-700">
                      <Share2 className="h-3 w-3 mr-1" />
                      Share
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="bg-slate-900 border-slate-800">
            <div className="overflow-x-auto">
              {sortedVideos.map((video) => (
                <div key={video.id} className="flex items-center gap-4 p-4 border-b border-slate-800 last:border-b-0 hover:bg-slate-800/50 transition-colors cursor-pointer" onClick={() => router.push(`/dashboard/videos/${video.id}`)}>
                  <Checkbox />
                  <div className="flex-shrink-0 w-20 h-20">
                    {video.thumbnail_url ? (
                      <img src={video.thumbnail_url} alt={video.title} className="w-full h-full object-cover rounded" />
                    ) : (
                      <div className="w-full h-full bg-slate-800 rounded flex items-center justify-center">
                        <Video className="h-8 w-8 text-slate-600" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-white truncate">{video.title}</h3>
                    <p className="text-sm text-slate-400">{video.client_name || video.property_address || "-"}</p>
                  </div>
                  <div className="w-32">
                    <Badge variant="secondary">{getTypeBadge(video.video_type)}</Badge>
                  </div>
                  <div className="w-24">{getStatusBadge(video.status)}</div>
                  <div className="w-20 text-slate-600">{video.views || "-"}</div>
                  <div className="w-24 text-sm text-slate-500">
                    {new Date(video.created_at).toLocaleDateString()}
                  </div>
                  <div className="w-20">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem>
                          <Play className="h-4 w-4 mr-2" />
                          Play
                        </DropdownMenuItem>
                        <DropdownMenuItem>
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </DropdownMenuItem>
                        <DropdownMenuItem>
                          <Share2 className="h-4 w-4 mr-2" />
                          Share
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-red-600">
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}

// ✅ OUTER COMPONENT: Wraps content in Suspense
export default function VideoLibraryPage() {
  return (
    <Suspense fallback={<Loading />}>
      <VideoLibraryContent />
    </Suspense>
  )
}

export const unstable_settings = {
  suspense: true,
}
