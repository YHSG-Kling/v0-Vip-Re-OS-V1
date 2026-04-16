"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/use-toast"
import {
  Play,
  Pause,
  Users,
  Phone,
  Clock,
  Plus,
  Target
} from "lucide-react"
import { useRouter } from "next/navigation"
import { toggleCampaignStatus } from "@/app/actions/ai-isa"
import { CreateCampaignDrawer } from "@/app/dashboard/isa/campaigns/components/CreateCampaignDrawer"

interface Campaign {
  id: string
  name: string
  campaign_type: string | null
  status: string
  is_active: boolean
  leads_targeted: number | null
  touches_sent: number | null
  conversions: number | null
  touch_interval_days: number | null
  max_touches: number | null
  created_at: string
}

interface ISACampaignsPanelProps {
  campaigns: Campaign[]
  brokerageId: string
}

export function ISACampaignsPanel({ campaigns: initialCampaigns, brokerageId }: ISACampaignsPanelProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [toggling, setToggling] = useState<string | null>(null)
  const [showCreateDrawer, setShowCreateDrawer] = useState(false)
  const { toast } = useToast()

  async function handleToggleCampaign(campaignId: string, currentStatus: string) {
    const result = await toggleCampaignStatus(campaignId, currentStatus as any)
    if ((result as any).success) {
      toast({ title: "Campaign updated" })
      router.refresh()
    } else {
      toast({ title: "Failed to update campaign", description: (result as any).error ?? "Please try again.", variant: "destructive" })
    }
  }

  if (initialCampaigns.length === 0) {
    return (
      <>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Target className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground mb-4">No active ISA campaigns</p>
            <Button onClick={() => setShowCreateDrawer(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Campaign
            </Button>
          </CardContent>
        </Card>
        <CreateCampaignDrawer
          open={showCreateDrawer}
          onClose={() => setShowCreateDrawer(false)}
          brokerageId={brokerageId}
          videoEnabled={false}
          directMailEnabled={false}
          onCreated={() => { setShowCreateDrawer(false); router.refresh() }}
        />
      </>
    )
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium">Active Campaigns</h3>
          <Button size="sm" onClick={() => setShowCreateDrawer(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Campaign
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {initialCampaigns.map((campaign) => {
            const isActive = campaign.status === "active"
            return (
              <Card key={campaign.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{campaign.name}</CardTitle>
                    <Switch
                      checked={isActive}
                      onCheckedChange={() => handleToggleCampaign(campaign.id, campaign.status)}
                      disabled={toggling === campaign.id || isPending}
                    />
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="outline" className="text-xs">
                      {campaign.campaign_type || "Standard"}
                    </Badge>
                    {isActive ? (
                      <Badge className="bg-green-500/10 text-green-600 border-green-200 text-xs">
                        <Play className="h-3 w-3 mr-1" />
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">
                        <Pause className="h-3 w-3 mr-1" />
                        Paused
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                        <Users className="h-3.5 w-3.5" />
                        <span className="text-xs">Queued</span>
                      </div>
                      <p className="text-lg font-semibold">{campaign.leads_targeted || 0}</p>
                    </div>
                    <div>
                      <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                        <Phone className="h-3.5 w-3.5" />
                        <span className="text-xs">Calls Made</span>
                      </div>
                      <p className="text-lg font-semibold">{campaign.touches_sent || 0}</p>
                    </div>
                    <div>
                      <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                        <Target className="h-3.5 w-3.5" />
                        <span className="text-xs">Conversions</span>
                      </div>
                      <p className="text-lg font-semibold">{campaign.conversions || 0}</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-4 pt-4 border-t text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      Every {campaign.touch_interval_days || 1} day(s)
                    </span>
                    <span>Max {campaign.max_touches || 5} touches</span>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
      <CreateCampaignDrawer
        open={showCreateDrawer}
        onClose={() => setShowCreateDrawer(false)}
        brokerageId={brokerageId}
        videoEnabled={false}
        directMailEnabled={false}
        onCreated={() => { setShowCreateDrawer(false); router.refresh() }}
      />
    </>
  )
}
