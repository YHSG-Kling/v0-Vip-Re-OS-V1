"use client"

import { useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
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

interface Campaign {
  id: string
  name: string
  campaign_type: string | null
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

export function ISACampaignsPanel({ campaigns, brokerageId }: ISACampaignsPanelProps) {
  const router = useRouter()
  const [toggling, setToggling] = useState<string | null>(null)

  const handleToggleCampaign = async (campaignId: string, currentState: boolean) => {
    setToggling(campaignId)
    const supabase = createClient()
    
    await supabase
      .from("ai_isa_campaigns")
      .update({ is_active: !currentState })
      .eq("id", campaignId)
    
    setToggling(null)
    router.refresh()
  }

  if (campaigns.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Target className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <p className="text-muted-foreground mb-4">No active ISA campaigns</p>
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Campaign
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Active Campaigns</h3>
        <Button size="sm">
          <Plus className="h-4 w-4 mr-2" />
          New Campaign
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {campaigns.map((campaign) => (
          <Card key={campaign.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{campaign.name}</CardTitle>
                <Switch
                  checked={campaign.is_active}
                  onCheckedChange={() => handleToggleCampaign(campaign.id, campaign.is_active)}
                  disabled={toggling === campaign.id}
                />
              </div>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="outline" className="text-xs">
                  {campaign.campaign_type || "Standard"}
                </Badge>
                {campaign.is_active ? (
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
        ))}
      </div>
    </div>
  )
}
