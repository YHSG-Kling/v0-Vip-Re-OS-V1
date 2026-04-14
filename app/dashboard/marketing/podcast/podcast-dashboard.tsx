"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/app/components/ui/tabs"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent } from "@/app/components/ui/card"
import { Plus, Mic, Settings, Radio, BarChart2, TrendingUp, CheckCircle2, Loader2 } from "lucide-react"
import { EpisodesTab } from "./components/episodes-tab"
import { TemplatesTab } from "./components/templates-tab"
import { DistributionChannelsTab } from "./components/distribution-channels-tab"
import { CreateEpisodeDialog } from "./components/create-episode-dialog"
import {
  getPodcastEpisodes,
  getPodcastTemplates,
  getDistributionChannels,
} from "@/app/actions/podcast-generation"

interface Episode {
  id: string
  title: string
  description: string
  status: "draft" | "generating" | "completed" | "published" | "failed"
  duration_seconds: number | null
  publish_channels: string[]
  created_at: string
  audio_url: string | null
  category: string
}

interface Template {
  id: string
  name: string
  template_type: string
  host_name: string
  show_name: string
  use_count: number
  is_active: boolean
  description: string
}

interface DistributionChannel {
  id: string
  channel_name: string
  is_enabled: boolean
  external_show_id: string | null
  distribution_config: Record<string, any>
}

interface PodcastDashboardProps {
  agentId?: string
  brokerageId?: string
  initialEpisodes?: Episode[]
  totalPlays?: number
  userType?: string
}

export function PodcastDashboard({
  agentId = "",
  brokerageId = "",
  initialEpisodes = [],
  totalPlays = 0,
  userType = "agent",
}: PodcastDashboardProps) {
  const isAdmin = userType === "broker" || userType === "broker_admin" || userType === "admin" || userType === "superadmin"
  const [episodes, setEpisodes] = useState<Episode[]>(initialEpisodes)
  const [templates, setTemplates] = useState<Template[]>([])
  const [channels, setChannels] = useState<DistributionChannel[]>([])
  const [loading, setLoading] = useState(initialEpisodes.length === 0)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [activeTab, setActiveTab] = useState("episodes")

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [episodesResult, templatesResult, channelsResult] = await Promise.all([
        getPodcastEpisodes(),
        getPodcastTemplates(),
        getDistributionChannels(),
      ])

      if (episodesResult.success) {
        setEpisodes(episodesResult.episodes || [])
      }
      if (templatesResult.success) {
        setTemplates(templatesResult.templates || [])
      }
      if (channelsResult.success) {
        setChannels(channelsResult.channels || [])
      }
    } catch (error) {
      console.error("Failed to load podcast data:", error)
    } finally {
      setLoading(false)
    }
  }

  // Derive analytics from real episode data
  const totalEpisodes = episodes.length
  const publishedCount = episodes.filter((e) => e.status === "published").length
  const generatingCount = episodes.filter((e) => e.status === "generating").length
  const topEpisode = episodes.find((e) => e.status === "published") ?? null

  function handleEpisodeCreated() {
    loadData()
    setIsCreateDialogOpen(false)
  }

  function handleTemplateUpdated() {
    loadData()
  }

  function handleChannelUpdated() {
    loadData()
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Mic className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Podcast Studio</h1>
            <p className="text-sm text-gray-500">Create and distribute AI-powered podcasts</p>
          </div>
        </div>
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Episode
        </Button>
      </header>

      {/* Analytics Strip */}
      <div className="px-6 py-4 border-b border-gray-200 bg-white">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="border-0 shadow-none bg-gray-50">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-lg shrink-0">
                <Radio className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-gray-900">
                  {loading ? <Loader2 className="h-5 w-5 animate-spin text-gray-400" /> : totalEpisodes}
                </p>
                <p className="text-xs text-gray-500">Total Episodes</p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-none bg-gray-50">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg shrink-0">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-gray-900">
                  {loading ? <Loader2 className="h-5 w-5 animate-spin text-gray-400" /> : publishedCount}
                </p>
                <p className="text-xs text-gray-500">Published</p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-none bg-gray-50">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg shrink-0">
                <BarChart2 className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-gray-900">
                  {totalPlays.toLocaleString()}
                </p>
                <p className="text-xs text-gray-500">Total Plays</p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-none bg-gray-50">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 bg-amber-100 rounded-lg shrink-0">
                <TrendingUp className="h-4 w-4 text-amber-600" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">
                  {loading
                    ? "—"
                    : topEpisode
                      ? topEpisode.title
                      : "No episodes yet"}
                </p>
                <p className="text-xs text-gray-500">Top Episode</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
          <div className="px-6 pt-4 border-b border-gray-200 bg-white">
            <TabsList>
              <TabsTrigger value="episodes" className="gap-2">
                <Radio className="h-4 w-4" />
                Episodes
              </TabsTrigger>
              <TabsTrigger value="templates" className="gap-2">
                <Settings className="h-4 w-4" />
                Templates
              </TabsTrigger>
              <TabsTrigger value="distribution" className="gap-2">
                <Mic className="h-4 w-4" />
                Distribution Channels
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-auto p-6 bg-gray-50">
            <TabsContent value="episodes" className="mt-0 h-full">
              <EpisodesTab
                episodes={episodes}
                loading={loading}
                onRefresh={loadData}
                channels={channels}
              />
            </TabsContent>

            <TabsContent value="templates" className="mt-0 h-full">
              <TemplatesTab
                templates={templates}
                loading={loading}
                onUpdate={handleTemplateUpdated}
              />
            </TabsContent>

            <TabsContent value="distribution" className="mt-0 h-full">
              <DistributionChannelsTab
                channels={channels}
                loading={loading}
                onUpdate={handleChannelUpdated}
                isAdmin={isAdmin}
              />
            </TabsContent>
          </div>
        </Tabs>
      </div>

      {/* Create Episode Dialog */}
      <CreateEpisodeDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        templates={templates}
        channels={channels}
        onCreated={handleEpisodeCreated}
      />
    </div>
  )
}
