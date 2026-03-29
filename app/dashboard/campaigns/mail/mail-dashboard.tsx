"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Plus, Mail, Users, Truck, MessageSquare } from "lucide-react"
import { CampaignsTab } from "./components/campaigns-tab"
import { RecipientsTab } from "./components/recipients-tab"
import { TrackingTab } from "./components/tracking-tab"
import { ResponsesTab } from "./components/responses-tab"
import { CreateCampaignDialog } from "./components/create-campaign-dialog"
import {
  getMailCampaigns,
  getRecipients,
  getTrackingRecords,
  getResponses,
} from "@/app/actions/direct-mail"

export interface Campaign {
  id: string
  campaign_name: string
  target_audience: string
  design_url: string | null
  quantity: number
  status: "planning" | "approved" | "printed" | "mailed"
  created_at: string
  mailing_date: string | null
  per_piece_cost: number | null
  pieces_mailed: number | null
  lob_order_id: string | null
  estimated_response_rate: number | null
  brokerage_id: string
  agent_id: string | null
}

export interface Recipient {
  id: string
  campaign_id: string
  contact_id: string | null
  first_name: string
  last_name: string
  address_line1: string
  address_line2: string | null
  city: string
  state: string
  zip: string
  delivery_status: "pending" | "mailed" | "delivered" | "returned" | "failed"
  mailed_at: string | null
  delivered_at: string | null
  lob_address_id: string | null
}

export interface TrackingRecord {
  id: string
  campaign_id: string
  batch_id: string
  provider_delivery_status: string
  mailed_at: string | null
  delivered_at: string | null
  returned_at: string | null
  tracking_payload: Record<string, unknown>
  created_at: string
}

export interface Response {
  id: string
  campaign_id: string
  recipient_id: string | null
  contact_id: string | null
  response_type: "qr_scan" | "landing_visit" | "call" | "form_submit" | "reply" | "appointment"
  response_metadata: Record<string, unknown> | null
  created_at: string
  contacts?: {
    first_name: string
    last_name: string
    email: string
    phone: string
  }
}

interface MailDashboardProps {
  brokerageId: string
}

export function MailDashboard({ brokerageId }: MailDashboardProps) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [tracking, setTracking] = useState<TrackingRecord[]>([])
  const [responses, setResponses] = useState<Response[]>([])
  const [loading, setLoading] = useState(true)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [activeTab, setActiveTab] = useState("campaigns")
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null)

  useEffect(() => {
    if (brokerageId) {
      loadCampaigns()
    } else {
      setLoading(false)
    }
  }, [brokerageId])

  useEffect(() => {
    if (selectedCampaignId) {
      loadCampaignDetails(selectedCampaignId)
    }
  }, [selectedCampaignId])

  async function loadCampaigns() {
    setLoading(true)
    try {
      const result = await getMailCampaigns(brokerageId)
      if (result.success && result.campaigns) {
        setCampaigns(result.campaigns)
        if (result.campaigns.length > 0 && !selectedCampaignId) {
          setSelectedCampaignId(result.campaigns[0].id)
        }
      }
    } catch (error) {
      console.error("Failed to load campaigns:", error)
    } finally {
      setLoading(false)
    }
  }

  async function loadCampaignDetails(campaignId: string) {
    try {
      const [recipientsResult, trackingResult, responsesResult] = await Promise.all([
        getRecipients(campaignId),
        getTrackingRecords(campaignId),
        getResponses(campaignId),
      ])

      if (recipientsResult.success) {
        setRecipients(recipientsResult.recipients || [])
      }
      if (trackingResult.success) {
        setTracking(trackingResult.tracking || [])
      }
      if (responsesResult.success) {
        setResponses(responsesResult.responses || [])
      }
    } catch (error) {
      console.error("Failed to load campaign details:", error)
    }
  }

  function handleCampaignCreated() {
    loadCampaigns()
    setIsCreateDialogOpen(false)
  }

  function handleCampaignSelect(campaignId: string) {
    setSelectedCampaignId(campaignId)
  }

  function handleRefresh() {
    loadCampaigns()
    if (selectedCampaignId) {
      loadCampaignDetails(selectedCampaignId)
    }
  }

  const selectedCampaign = campaigns.find((c) => c.id === selectedCampaignId)

  // Honest empty state — never render campaign UI with unknown scope
  if (!brokerageId) {
    return (
      <div className="flex flex-col h-full items-center justify-center p-12 text-center">
        <Mail className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">Brokerage not configured</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Your account is not linked to a brokerage. Contact your administrator or support to resolve this.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Mail className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Direct Mail</h1>
            <p className="text-sm text-muted-foreground">Manage print marketing campaigns</p>
          </div>
        </div>
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Campaign
        </Button>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
          <div className="px-6 pt-4 border-b border-border bg-card">
            <TabsList>
              <TabsTrigger value="campaigns" className="gap-2">
                <Mail className="h-4 w-4" />
                Campaigns
              </TabsTrigger>
              <TabsTrigger value="recipients" className="gap-2">
                <Users className="h-4 w-4" />
                Recipients
              </TabsTrigger>
              <TabsTrigger value="tracking" className="gap-2">
                <Truck className="h-4 w-4" />
                Tracking
              </TabsTrigger>
              <TabsTrigger value="responses" className="gap-2">
                <MessageSquare className="h-4 w-4" />
                Responses
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-auto p-6 bg-background">
            <TabsContent value="campaigns" className="mt-0 h-full">
              <CampaignsTab
                campaigns={campaigns}
                loading={loading}
                onRefresh={handleRefresh}
                selectedCampaignId={selectedCampaignId}
                onSelectCampaign={handleCampaignSelect}
              />
            </TabsContent>

            <TabsContent value="recipients" className="mt-0 h-full">
              <RecipientsTab
                recipients={recipients}
                campaigns={campaigns}
                selectedCampaignId={selectedCampaignId}
                onSelectCampaign={handleCampaignSelect}
                loading={loading}
                onRefresh={handleRefresh}
              />
            </TabsContent>

            <TabsContent value="tracking" className="mt-0 h-full">
              <TrackingTab
                tracking={tracking}
                campaigns={campaigns}
                selectedCampaignId={selectedCampaignId}
                onSelectCampaign={handleCampaignSelect}
                loading={loading}
              />
            </TabsContent>

            <TabsContent value="responses" className="mt-0 h-full">
              <ResponsesTab
                responses={responses}
                campaigns={campaigns}
                selectedCampaignId={selectedCampaignId}
                onSelectCampaign={handleCampaignSelect}
                loading={loading}
              />
            </TabsContent>
          </div>
        </Tabs>
      </div>

      {/* Create Campaign Dialog */}
      <CreateCampaignDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        onCreated={handleCampaignCreated}
      />
    </div>
  )
}
