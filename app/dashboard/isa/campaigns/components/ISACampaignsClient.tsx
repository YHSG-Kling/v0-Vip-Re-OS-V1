"use client"

import { useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"
import { AuthorityBanner } from "./AuthorityBanner"
import { CampaignStatsBar } from "./CampaignStatsBar"
import { CampaignCard } from "./CampaignCard"
import { CreateCampaignModal } from "./CreateCampaignModal"
import { listISACampaigns, type ISACampaignRow, type ISACampaignStats } from "@/app/actions/ai-isa"

interface Props {
  brokerageId:       string
  initialCampaigns:  ISACampaignRow[]
  initialStats:      ISACampaignStats
  videoEnabled:      boolean
  directMailEnabled: boolean
}

export function ISACampaignsClient({
  brokerageId,
  initialCampaigns,
  initialStats,
  videoEnabled,
  directMailEnabled,
}: Props) {
  const [campaigns, setCampaigns]   = useState<ISACampaignRow[]>(initialCampaigns)
  const [stats, setStats]           = useState<ISACampaignStats>(initialStats)
  const [showCreate, setShowCreate] = useState(false)
  const [activeTab, setActiveTab]   = useState<"all" | "active" | "paused" | "draft">("all")

  const refresh = useCallback(async () => {
    const result = await listISACampaigns(brokerageId)
    if (result.success) {
      setCampaigns(result.campaigns)
      setStats(result.stats)
    }
  }, [brokerageId])

  const filtered = activeTab === "all"
    ? campaigns
    : campaigns.filter(c => c.status === activeTab)

  const tabs = [
    { key: "all",    label: "All" },
    { key: "active", label: "Active" },
    { key: "paused", label: "Paused" },
    { key: "draft",  label: "Draft" },
  ] as const

  return (
    <div className="flex flex-col gap-6">
      {/* Non-dismissible authority banner */}
      <AuthorityBanner />

      {/* Stats bar */}
      <CampaignStatsBar stats={stats} />

      {/* Tab bar + create button */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex gap-1 rounded-lg border border-border bg-muted p-1">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-1.5">
          <Plus className="h-4 w-4" />
          New Campaign
        </Button>
      </div>

      {/* Campaign cards grid */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          No campaigns found.{activeTab !== "all" && " Try a different filter."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(campaign => (
            <CampaignCard
              key={campaign.id}
              campaign={campaign}
              onStatusChange={refresh}
            />
          ))}
        </div>
      )}

      <CreateCampaignModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        brokerageId={brokerageId}
        videoEnabled={videoEnabled}
        directMailEnabled={directMailEnabled}
        onCreated={refresh}
      />
    </div>
  )
}
