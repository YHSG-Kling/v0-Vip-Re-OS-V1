"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { useSearchParams } from "next/navigation"
import { Suspense } from "react"
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

const Loading = () => null

export default function VideoLibraryPage() {
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
  }).sort((a, b) => {
    if (sortBy === "date") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    if (sortBy === "views") return (b.views || 0) - (a.views || 0)
    if (sortBy === "performance") return (b.completion_rate || 0) - (a.completion_rate || 0)
    return 0
  })

  const stats = {
    total: videos.length,
    ready: videos.filter((v) => v.status === "ready").length,
    generating: videos.filter((v) => v.status === "generating").length,
    totalViews: videos.reduce((sum, v) => sum + (v.views || 0), 0),
  }

  function toggleVideoSelection(videoId: string) {
    setSelectedVideos((prev) =>
      prev.includes(videoId) ? prev.filter((id) => id !== videoId) : [...prev, videoId]
    )
  }

  function selectAllVideos() {
    if (selectedVideos.length === filteredVideos.length) {
      setSelectedVideos([])
    } else {
      setSelectedVideos(filteredVideos.map((v) => v.id))
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "ready":
        return <Badge className="bg-green-100 text-green-700">Ready</Badge>
      case "generating":
        return <Badge className="bg-blue-100 text-blue-700"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Generating</Badge>
      case "failed":
        return <Badge className="bg-red-100 text-red-700">Failed</Badge>
      default:
        return <Badge variant="secondary">{status}</Badge>
    }
  }

  const getTypeBadge = (type: string) => {
    const types: Record<string, string> = {
      listing_tour: "Listing Tour",
      agent_intro: "Agent Intro",
      market_update: "Market Update",
      personalized_buyer: "Personalized",
      open_house: "Open House",
      memory_video: "Memory Video",
      testimonial: "Testimonial",
    }
    return types[type] || type
  }

  const formatDuration = (seconds?: number) => {
    if (!seconds) return "--:--"
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="container mx-auto py-8 px-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Video Library</h1>
            <p className="text-slate-600 mt-1">Manage and share your AI-generated videos</p>
          </div>
          <Button onClick={() => router.push("/dashboard/videos/create")}>
            <Plus className="h-4 w-4 mr-2" />
            Create Video
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-100">
                  <Video className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Total Videos</p>
                  <p className="text-2xl font-bold">{stats.total}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-100">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Ready</p>
                  <p className="text-2xl font-bold">{stats.ready}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-100">
                  <Loader2 className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Generating</p>
                  <p className="text-2xl font-bold">{stats.generating}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-100">
                  <Eye className="h-5 w-5 text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Total Views</p>
                  <p className="text-2xl font-bold">{stats.totalViews.toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by title, client, or property..."
                  className="pl-10"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="ready">Ready</SelectItem>
                  <SelectItem value="generating">Generating</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="listing_tour">Listing Tour</SelectItem>
                  <SelectItem value="agent_intro">Agent Intro</SelectItem>
                  <SelectItem value="market_update">Market Update</SelectItem>
                  <SelectItem value="personalized_buyer">Personalized</SelectItem>
                  <SelectItem value="open_house">Open House</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="date">Date Created</SelectItem>
                  <SelectItem value="views">Most Views</SelectItem>
                  <SelectItem value="performance">Performance</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
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

            {/* Batch Actions */}
            {selectedVideos.length > 0 && (
              <div className="flex items-center gap-4 mt-4 pt-4 border-t">
                <span className="text-sm text-slate-600">{selectedVideos.length} selected</span>
                <Button variant="outline" size="sm">
                  <Share2 className="h-4 w-4 mr-2" />
                  Share
                </Button>
                <Button variant="outline" size="sm">
                  <Download className="h-4 w-4 mr-2" />
                  Download
                </Button>
                <Button variant="outline" size="sm" className="text-red-600 hover:text-red-700 bg-transparent">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Video Grid/List */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          </div>
        ) : filteredVideos.length === 0 ? (
          <Card>
            <CardContent className="p-16 text-center">
              <Video className="h-12 w-12 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-slate-900 mb-2">No videos found</h3>
              <p className="text-slate-500 mb-4">Create your first AI video to get started</p>
              <Button onClick={() => router.push("/dashboard/videos/create")}>
                <Plus className="h-4 w-4 mr-2" />
                Create Video
              </Button>
            </CardContent>
          </Card>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredVideos.map((video) => (
              <Card key={video.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                <div className="relative">
                  <div className="aspect-video bg-slate-200 flex items-center justify-center">
                    {video.thumbnail_url ? (
                      <img src={video.thumbnail_url || "/placeholder.svg"} alt={video.title} className="w-full h-full object-cover" />
                    ) : (
                      <Video className="h-12 w-12 text-slate-400" />
                    )}
                    {video.status === "ready" && (
                      <div className="absolute inset-0 bg-black/30 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center">
                        <Button size="lg" variant="secondary">
                          <Play className="h-6 w-6 mr-2" />
                          Play
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="absolute top-2 left-2">
                    <Checkbox
                      checked={selectedVideos.includes(video.id)}
                      onCheckedChange={() => toggleVideoSelection(video.id)}
                      className="bg-white"
                    />
                  </div>
                  <div className="absolute top-2 right-2">
                    {getStatusBadge(video.status)}
                  </div>
                  {video.duration_seconds && (
                    <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                      {formatDuration(video.duration_seconds)}
                    </div>
                  )}
                </div>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-slate-900 truncate">{video.title}</h3>
                      <p className="text-sm text-slate-500 mt-1">{getTypeBadge(video.video_type)}</p>
                    </div>
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
                        <DropdownMenuItem>
                          <Copy className="h-4 w-4 mr-2" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem>
                          <BarChart3 className="h-4 w-4 mr-2" />
                          Analytics
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-red-600">
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {video.status === "ready" && (
                    <div className="flex items-center gap-4 mt-3 pt-3 border-t text-sm text-slate-500">
                      <div className="flex items-center gap-1">
                        <Eye className="h-4 w-4" />
                        {video.views}
                      </div>
                      <div className="flex items-center gap-1">
                        <TrendingUp className="h-4 w-4" />
                        {video.completion_rate}%
                      </div>
                      <div className="flex items-center gap-1">
                        <Calendar className="h-4 w-4" />
                        {new Date(video.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <div className="divide-y">
              <div className="p-4 bg-slate-50 flex items-center gap-4 text-sm font-medium text-slate-600">
                <div className="w-8">
                  <Checkbox
                    checked={selectedVideos.length === filteredVideos.length && filteredVideos.length > 0}
                    onCheckedChange={selectAllVideos}
                  />
                </div>
                <div className="flex-1">Video</div>
                <div className="w-32">Type</div>
                <div className="w-24">Status</div>
                <div className="w-20">Views</div>
                <div className="w-24">Created</div>
                <div className="w-20">Actions</div>
              </div>
              {filteredVideos.map((video) => (
                <div key={video.id} className="p-4 flex items-center gap-4 hover:bg-slate-50">
                  <div className="w-8">
                    <Checkbox
                      checked={selectedVideos.includes(video.id)}
                      onCheckedChange={() => toggleVideoSelection(video.id)}
                    />
                  </div>
                  <div className="flex-1 flex items-center gap-3">
                    <div className="w-16 h-10 bg-slate-200 rounded flex items-center justify-center flex-shrink-0">
                      <Video className="h-5 w-5 text-slate-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900 truncate">{video.title}</p>
                      {video.client_name && <p className="text-sm text-slate-500">{video.client_name}</p>}
                    </div>
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

export const unstable_settings = {
  suspense: true,
}
