"use client"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/app/components/ui/tabs"
import { Settings, Radio } from "lucide-react"
import { TemplatesTab } from "./templates-tab"
import { DistributionChannelsTab } from "./distribution-channels-tab"

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

interface SetupTabProps {
  templates: Template[]
  channels: DistributionChannel[]
  loading: boolean
  isAdmin: boolean
  onTemplatesUpdate: () => void
  onChannelsUpdate: () => void
}

/**
 * Combined Setup tab — templates + distribution channels are rare/setup config,
 * not daily use, so the plan calls for them to live behind one nav entry.
 */
export function SetupTab({
  templates,
  channels,
  loading,
  isAdmin,
  onTemplatesUpdate,
  onChannelsUpdate,
}: SetupTabProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">Setup &amp; Configuration</h3>
        <p className="text-sm text-muted-foreground">
          Manage reusable templates and the channels where your show is distributed.
        </p>
      </div>
      <Tabs defaultValue="templates" className="space-y-4">
        <TabsList>
          <TabsTrigger value="templates" className="gap-2">
            <Settings className="h-4 w-4" />
            Templates
          </TabsTrigger>
          <TabsTrigger value="distribution" className="gap-2">
            <Radio className="h-4 w-4" />
            Distribution Channels
          </TabsTrigger>
        </TabsList>

        <TabsContent value="templates" className="mt-0">
          <TemplatesTab templates={templates} loading={loading} onUpdate={onTemplatesUpdate} />
        </TabsContent>

        <TabsContent value="distribution" className="mt-0">
          <DistributionChannelsTab
            channels={channels}
            loading={loading}
            onUpdate={onChannelsUpdate}
            isAdmin={isAdmin}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
