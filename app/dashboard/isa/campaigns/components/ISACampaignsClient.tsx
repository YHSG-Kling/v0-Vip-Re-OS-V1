"use client"

import { useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"
import { AuthorityBanner } from "./AuthorityBanner"
import { CampaignStatsBar } from "./CampaignStatsBar"
import { CampaignCard } from "./CampaignCard"
import { CreateCampaignDrawer } from "./CreateCampaignDrawer"
import { EngagementFeed } from "./EngagementFeed"
import { QualificationOutcomes } from "./QualificationOutcomes"
import { GhostRecoveryQueue } from "./GhostRecoveryQueue"
import {
  listISACampaigns,
  type ISACampaignRow,
  type ISACampaignStats,
  type EngagementFeedItem,
  type QualificationOutcome,
  type QualificationStats,
  type GhostContact,
} from "@/app/actions/ai-isa"

type MainTab = "campaigns" | "engagement" | "qualifications" | "ghost_recovery"

interface Props {
  brokerageId:        string
  initialCampaigns:   ISACampaignRow[]
  initialStats:       ISACampaignStats
  videoEnabled:       boolean
  directMailEnabled:  boolean
  initialEngagement:  EngagementFeedItem[]
  initialOutcomes:    QualificationOutcome[]
  initialQualStats:   QualificationStats
  initialChartData:   { result: string; count: number }[]
  initialGhosts:      GhostContact[]
}

const MAIN_TABS: { key: MainTab; label: string }[] = [
  { key: "campaigns",      label: "Campaigns" },
  { key: "engagement",     label: "Engagement Feed" },
  { key: "qualifications", label: "Qualification Outcomes" },
  { key: "ghost_recovery", label: "Ghost Recovery Queue" },
]

export function ISACampaignsClient({
  brokerageId,
  initialCampaigns,
  initialStats,
  videoEnabled,
  directMailEnabled,
  initialEngagement,
  initialOutcomes,
  initialQualStats,
  initialChartData,
  initialGhosts,
}: Props) {
  const [mainTab, setMainTab]       = useState<MainTab>("campaigns")
  const [campaigns, setCampaigns]   = useState<ISACampaignRow[]>(initialCampaigns)
  const [stats, setStats]           = useState<ISACampaignStats>(initialStats)
  const [showCreate, setShowCreate] = useState(false)
  const [cardFilter, setCardFilter] = useState<"all" | "active" | "paused" | "draft">("all")

  const refresh = useCallback(async () => {
    const result = await listISACampaigns(brokerageId)
    if (result.success) {
      setCampaigns(result.campaigns)
      setStats(result.stats)
    }
  }, [brokerageId])

  const filteredCampaigns = cardFilter === "all"
    ? campaigns
    : campaigns.filter(c => c.status === cardFilter)

  const cardFilterTabs = [
    { key: "all",    label: "All"    },
    { key: "active", label: "Active" },
    { key: "paused", label: "Paused" },
    { key: "draft",  label: "Draft"  },
  ] as const

  return (
    <div className="flex flex-col gap-6">
      {/* NON-DISMISSIBLE authority banner — always visible on all tabs */}
      <AuthorityBanner />

      {/* Main tab nav */}
      <div className="flex gap-0 border-b border-border overflow-x-auto">
        {MAIN_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setMainTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              mainTab === tab.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── TAB 1: CAMPAIGNS ── */}
      {mainTab === "campaigns" && (
        <>
          <CampaignStatsBar stats={stats} />

          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-1 rounded-lg border border-border bg-muted p-1">
              {cardFilterTabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setCardFilter(tab.key)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    cardFilter === tab.key
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

          {filteredCampaigns.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
              No campaigns found.{cardFilter !== "all" && " Try a different filter."}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredCampaigns.map(campaign => (
                <CampaignCard
                  key={campaign.id}
                  campaign={campaign}
                  onStatusChange={refresh}
                />
              ))}
            </div>
          )}

          <CreateCampaignDrawer
            open={showCreate}
            onClose={() => setShowCreate(false)}
            brokerageId={brokerageId}
            directMailEnabled={directMailEnabled}
            onCreated={refresh}
          />
        </>
      )}

      {/* ── TAB 2: ENGAGEMENT FEED ── */}
      {mainTab === "engagement" && (
        <EngagementFeed
          brokerageId={brokerageId}
          campaigns={campaigns}
          initialItems={initialEngagement}
        />
      )}

      {/* ── TAB 3: QUALIFICATION OUTCOMES ── */}
      {mainTab === "qualifications" && (
        <QualificationOutcomes
          outcomes={initialOutcomes}
          stats={initialQualStats}
          chartData={initialChartData}
        />
      )}

      {/* ── TAB 4: GHOST RECOVERY QUEUE ── */}
      {mainTab === "ghost_recovery" && (
        <GhostRecoveryQueue
          brokerageId={brokerageId}
          initialGhosts={initialGhosts}
        />
      )}
    </div>
  )
}
