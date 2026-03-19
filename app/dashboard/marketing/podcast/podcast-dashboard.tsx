"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/app/components/ui/tabs"
import { Button } from "@/app/components/ui/button"
import { Plus, Mic, Settings, Radio } from "lucide-react"
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

export function PodcastDashboard() {
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [channels, setChannels] = useState<DistributionChannel[]>([])
  const [loading, setLoading] = useState(true)
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
