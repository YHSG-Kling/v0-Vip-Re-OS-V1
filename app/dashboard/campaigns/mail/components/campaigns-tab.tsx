"use client"

import { useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/app/components/ui/alert-dialog"
import {
  Mail,
  MoreVertical,
  Calendar,
  DollarSign,
  Users,
  Send,
  Trash2,
  Edit,
  ExternalLink,
  RefreshCw,
  Check,
} from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import type { Campaign } from "../mail-dashboard"
import { deleteMailCampaign, sendCampaign, updateMailCampaign } from "@/app/actions/direct-mail"

interface CampaignsTabProps {
  campaigns: Campaign[]
  loading: boolean
  onRefresh: () => void
  selectedCampaignId: string | null
  onSelectCampaign: (id: string) => void
}

const STATUS_COLORS: Record<Campaign["status"], string> = {
  planning: "bg-muted text-muted-foreground",
  approved: "bg-blue-100 text-blue-700",
  printed: "bg-amber-100 text-amber-700",
  mailed: "bg-green-100 text-green-700",
}

const STATUS_LABELS: Record<Campaign["status"], string> = {
  planning: "Planning",
  approved: "Approved",
  printed: "Printed",
  mailed: "Mailed",
}

export function CampaignsTab({
  campaigns,
  loading,
  onRefresh,
  selectedCampaignId,
  onSelectCampaign,
}: CampaignsTabProps) {
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  async function handleSendCampaign(campaign: Campaign) {
    setSendingId(campaign.id)
    try {
      const result = await sendCampaign({
        campaignId: campaign.id,
        actorUserId: campaign.agent_id || "",
        brokerageId: campaign.brokerage_id,
      })
      if (result.success) {
        onRefresh()
      } else {
        console.error("Failed to send:", result.error)
      }
    } catch (error) {
      console.error("Send error:", error)
    } finally {
      setSendingId(null)
    }
  }

  async function handleApproveCampaign(campaign: Campaign) {
    try {
      const result = await updateMailCampaign(campaign.id, { status: "approved" })
      if (result.success) {
        onRefresh()
      }
    } catch (error) {
      console.error("Approve error:", error)
    }
  }

  async function handleDeleteCampaign() {
    if (!confirmDeleteId) return
    setDeletingId(confirmDeleteId)
    try {
      const result = await deleteMailCampaign(confirmDeleteId)
      if (result.success) {
        onRefresh()
      } else {
        console.error("Failed to delete:", result.error)
      }
    } catch (error) {
      console.error("Delete error:", error)
    } finally {
      setDeletingId(null)
      setConfirmDeleteId(null)
    }
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-48 bg-muted rounded-xl animate-pulse" />
        ))}
      </div>
    )
  }

  if (campaigns.length === 0) {
    return (
      <Card className="flex flex-col items-center justify-center p-12 text-center">
        <Mail className="h-12 w-12 text-muted-foreground mb-4" />
        <CardTitle className="text-lg mb-2">No campaigns yet</CardTitle>
        <CardDescription>
          Create your first direct mail campaign to get started.
        </CardDescription>
      </Card>
    )
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted-foreground">
          {campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}
        </p>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {campaigns.map((campaign) => (
          <Card
            key={campaign.id}
            className={`cursor-pointer transition-all hover:shadow-md ${
              selectedCampaignId === campaign.id
                ? "ring-2 ring-primary"
                : "hover:ring-1 hover:ring-border"
            }`}
            onClick={() => onSelectCampaign(campaign.id)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <Badge className={STATUS_COLORS[campaign.status]}>
                  {STATUS_LABELS[campaign.status]}
                </Badge>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {campaign.status === "planning" && (
                      <DropdownMenuItem onClick={() => handleApproveCampaign(campaign)}>
                        <Check className="h-4 w-4 mr-2" />
                        Approve
                      </DropdownMenuItem>
                    )}
                    {campaign.status === "approved" && (
                      <DropdownMenuItem
                        onClick={() => handleSendCampaign(campaign)}
                        disabled={sendingId === campaign.id}
                      >
                        <Send className="h-4 w-4 mr-2" />
                        {sendingId === campaign.id ? "Sending..." : "Send Campaign"}
                      </DropdownMenuItem>
                    )}
                    {campaign.design_url && (
                      <DropdownMenuItem asChild>
                        <a href={campaign.design_url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-4 w-4 mr-2" />
                          View Design
                        </a>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    {campaign.status === "planning" && (
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => setConfirmDeleteId(campaign.id)}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <CardTitle className="text-base line-clamp-1 mt-2">
                {campaign.campaign_name}
              </CardTitle>
              <CardDescription className="line-clamp-2">
                {campaign.target_audience}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Users className="h-4 w-4" />
                  <span>{campaign.quantity.toLocaleString()} pieces</span>
                </div>
                {campaign.mailing_date && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Calendar className="h-4 w-4" />
                    <span>
                      {new Date(campaign.mailing_date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                )}
                {campaign.per_piece_cost && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <DollarSign className="h-4 w-4" />
                    <span>
                      ${(campaign.per_piece_cost * campaign.quantity).toFixed(2)}
                    </span>
                  </div>
                )}
                {campaign.pieces_mailed !== null && campaign.pieces_mailed > 0 && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Send className="h-4 w-4" />
                    <span>{campaign.pieces_mailed} mailed</span>
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Created {formatDistanceToNow(new Date(campaign.created_at))} ago
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!confirmDeleteId} onOpenChange={() => setConfirmDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the campaign
              and all associated recipients.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteCampaign}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingId ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
