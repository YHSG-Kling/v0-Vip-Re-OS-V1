"use client"

import { useState, useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/app/components/ui/tabs"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent } from "@/app/components/ui/card"
import { Plus, Mic, Settings, Radio, BarChart2, TrendingUp, CheckCircle2, Loader2, Scissors, Code2 } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/app/components/ui/dialog"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Textarea } from "@/app/components/ui/textarea"
import { EpisodesTab } from "./components/episodes-tab"
import { CreateEpisodeDialog } from "./components/create-episode-dialog"
import { AnalyticsTab } from "./components/analytics-tab"
import { RepurposeTab } from "./components/repurpose-tab"
import { MyShowTab } from "./components/my-show-tab"
import { SetupTab } from "./components/setup-tab"
import { EmbedWidgetTab } from "./components/embed-widget-tab"
import {
  getPodcastEpisodes,
  getPodcastTemplates,
  getDistributionChannels,
  createPodcastTemplate,
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
  hasVoiceClone?: boolean
}

export function PodcastDashboard({
  agentId = "",
  brokerageId = "",
  initialEpisodes = [],
  totalPlays = 0,
  userType = "agent",
  hasVoiceClone = false,
}: PodcastDashboardProps) {
  const isAdmin = userType === "broker" || userType === "broker_admin" || userType === "admin" || userType === "superadmin"
  const [episodes, setEpisodes] = useState<Episode[]>(initialEpisodes)
  const [templates, setTemplates] = useState<Template[]>([])
  const [channels, setChannels] = useState<DistributionChannel[]>([])
  const [loading, setLoading] = useState(initialEpisodes.length === 0)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isCreateTemplateOpen, setIsCreateTemplateOpen] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState("")
  const [newTemplateDesc, setNewTemplateDesc] = useState("")
  const [creatingTemplate, setCreatingTemplate] = useState(false)
  const [activeTab, setActiveTab] = useState("my-show")

  // Wire `?episode=<uuid>` from voice/Copilot stage_podcast_episode tool.
  // EpisodesTab opens that episode's details sheet on mount; we just need
  // to switch the active tab so the user lands on it.
  const searchParams = useSearchParams()
  const episodeFromUrl = searchParams?.get("episode") ?? null
  const validEpisodeId =
    episodeFromUrl &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(episodeFromUrl)
      ? episodeFromUrl
      : null

  useEffect(() => {
    if (validEpisodeId) setActiveTab("episodes")
  }, [validEpisodeId])

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

  async function handleCreateTemplate() {
    if (!newTemplateName.trim()) return
    setCreatingTemplate(true)
    try {
      const result = await createPodcastTemplate({
        name: newTemplateName.trim(),
        description: newTemplateDesc.trim() || undefined,
        templateType: "standard",
      })
      if (result.success) {
        setIsCreateTemplateOpen(false)
        setNewTemplateName("")
        setNewTemplateDesc("")
        loadData()
      }
    } finally {
      setCreatingTemplate(false)
    }
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
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setActiveTab("setup")}>
            <Settings className="h-4 w-4 mr-2" />
            New Template
          </Button>
          <Button onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Episode
          </Button>
        </div>
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
              <TabsTrigger value="my-show" className="gap-2">
                <Mic className="h-4 w-4" />
                My Show
              </TabsTrigger>
              <TabsTrigger value="episodes" className="gap-2">
                <Radio className="h-4 w-4" />
                Episodes
              </TabsTrigger>
              <TabsTrigger value="analytics" className="gap-2">
                <BarChart2 className="h-4 w-4" />
                Analytics
              </TabsTrigger>
              <TabsTrigger value="repurpose" className="gap-2">
                <Scissors className="h-4 w-4" />
                Repurpose
              </TabsTrigger>
              <TabsTrigger value="setup" className="gap-2">
                <Settings className="h-4 w-4" />
                Setup
              </TabsTrigger>
              <TabsTrigger value="embed" className="gap-2">
                <Code2 className="h-4 w-4" />
                Embed Widget
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-auto p-6 bg-gray-50">
            <TabsContent value="my-show" className="mt-0 h-full">
              <MyShowTab channels={channels} hasVoiceClone={hasVoiceClone} />
            </TabsContent>

            <TabsContent value="episodes" className="mt-0 h-full">
              <EpisodesTab
                episodes={episodes}
                loading={loading}
                onRefresh={loadData}
                channels={channels}
                initialEpisodeId={validEpisodeId}
              />
            </TabsContent>

            <TabsContent value="analytics" className="mt-0 h-full">
              <AnalyticsTab />
            </TabsContent>

            <TabsContent value="repurpose" className="mt-0 h-full">
              <RepurposeTab episodes={episodes} />
            </TabsContent>

            <TabsContent value="setup" className="mt-0 h-full">
              <SetupTab
                templates={templates}
                channels={channels}
                loading={loading}
                isAdmin={isAdmin}
                onTemplatesUpdate={handleTemplateUpdated}
                onChannelsUpdate={handleChannelUpdated}
              />
            </TabsContent>

            <TabsContent value="embed" className="mt-0 h-full">
              <EmbedWidgetTab
                episodes={episodes.map((e) => ({ id: e.id, title: e.title, status: e.status, audio_url: e.audio_url }))}
                agentId={agentId}
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
        hasVoiceClone={hasVoiceClone}
      />

      {/* The "New Template" header button routes to Setup → Templates (the single,
          richer template creator) — the inline duplicate dialog that wrote an
          invalid templateType:"standard" was removed. */}
    </div>
  )
}
