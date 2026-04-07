"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Mail,
  MoreVertical,
  Calendar,
  DollarSign,
  Users,
  Send,
  Trash2,
  ExternalLink,
  RefreshCw,
  Check,
  Printer,
  Loader2,
} from "lucide-react"
import { toast } from "sonner"
import { formatDistanceToNow } from "date-fns"
import type { Campaign } from "../mail-dashboard"
import { deleteMailCampaign, sendCampaign, updateMailCampaign } from "@/app/actions/direct-mail"
import { submitToPrintFulfillment, validateMailingList } from "@/app/actions/ai-direct-mail"

import { createClient } from "@/lib/supabase/client"

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
  const [printSubmittingId, setPrintSubmittingId] = useState<string | null>(null)
  const [printConfirmCampaign, setPrintConfirmCampaign] = useState<Campaign | null>(null)
  const [validationSummary, setValidationSummary] = useState<{ valid: number; invalid: number; total: number } | null>(null)
  const [agentId, setAgentId] = useState("")

  // Load agent ID from session for submitToPrintFulfillment
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setAgentId(user.id)
    })
  }, [])

  async function handleSendCampaign(campaign: Campaign) {
    setSendingId(campaign.id)
    try {
      const result = await sendCampaign({
        campaignId: campaign.id,
        actorUserId: campaign.agent_id || agentId,
        brokerageId: campaign.brokerage_id,
      })
      if (result.success) {
        toast.success(`Campaign sent — ${result.piecesMailed} pieces mailed`)
        onRefresh()
      } else {
        toast.error(result.error ?? "Failed to send campaign")
      }
    } catch {
      toast.error("Send failed")
    } finally {
      setSendingId(null)
    }
  }

  async function handleApproveCampaign(campaign: Campaign) {
    try {
      const result = await updateMailCampaign(campaign.id, { status: "approved" })
      if (result.success) {
        toast.success("Campaign approved")
        onRefresh()
      } else {
        toast.error(result.error ?? "Approval failed")
      }
    } catch {
      toast.error("Approval failed")
    }
  }

  async function handleDeleteCampaign() {
    if (!confirmDeleteId) return
    setDeletingId(confirmDeleteId)
    try {
      const result = await deleteMailCampaign(confirmDeleteId)
      if (result.success) {
        toast.success("Campaign deleted")
        onRefresh()
      } else {
        toast.error(result.error ?? "Delete failed")
      }
    } catch {
      toast.error("Delete failed")
    } finally {
      setDeletingId(null)
      setConfirmDeleteId(null)
    }
  }

  // Open confirm dialog and pre-validate the mailing list
  async function handlePrintConfirm(campaign: Campaign) {
    setPrintConfirmCampaign(campaign)
    setValidationSummary(null)

    // Fetch recipients to validate
    try {
      const supabase = createClient()
      const { data: recipients } = await supabase
        .from("direct_mail_recipients")
        .select("first_name, last_name, address_line1, address_line2, city, state, zip")
        .eq("campaign_id", campaign.id)

      if (recipients && recipients.length > 0) {
        const addresses = recipients.map((r: any) => ({
          name: `${r.first_name} ${r.last_name}`,
          address1: r.address_line1,
          address2: r.address_line2 ?? undefined,
          city: r.city,
          state: r.state,
          zip: r.zip,
        }))
        const valResult = await validateMailingList({
          agentId: campaign.agent_id || agentId,
          campaignId: campaign.id,
          addresses,
        })
        if (valResult.success && valResult.validation) {
          setValidationSummary({
            valid: valResult.validation.valid,
            invalid: valResult.validation.invalid,
            total: valResult.validation.total,
          })
          if (valResult.validation.invalid > 0) {
            toast.warning(
              `Mailing list has ${valResult.validation.invalid} bad address${valResult.validation.invalid !== 1 ? "es" : ""} — review before submitting`
            )
          }
        }
      } else {
        setValidationSummary({ valid: 0, invalid: 0, total: 0 })
      }
    } catch {
      // Non-blocking — proceed with confirm dialog anyway
    }
  }

  async function handleSubmitToPrint() {
    if (!printConfirmCampaign) return
    const campaign = printConfirmCampaign
    setPrintSubmittingId(campaign.id)
    setPrintConfirmCampaign(null)
    try {
      const result = await submitToPrintFulfillment({
        campaignId: campaign.id,
        agentId: campaign.agent_id || agentId,
        brokerageId: campaign.brokerage_id,
      })
      if (result.success && result.fulfillment) {
        const { fulfillment } = result
        toast.success(
          `Submitted to print — Order #${fulfillment.orderId} · ${fulfillment.quantity} pieces · Est. delivery ${new Date(fulfillment.estimatedDelivery).toLocaleDateString()}`
        )
        onRefresh()
      } else {
        toast.error(result.error ?? "Print submission failed")
      }
    } catch {
      toast.error("Print submission failed")
    } finally {
      setPrintSubmittingId(null)
      setValidationSummary(null)
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
                      <>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            handlePrintConfirm(campaign)
                          }}
                          disabled={printSubmittingId === campaign.id}
                        >
                          {printSubmittingId === campaign.id ? (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          ) : (
                            <Printer className="h-4 w-4 mr-2" />
                          )}
                          Send to Print
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleSendCampaign(campaign)}
                          disabled={sendingId === campaign.id}
                        >
                          <Send className="h-4 w-4 mr-2" />
                          {sendingId === campaign.id ? "Sending..." : "Send via Lob"}
                        </DropdownMenuItem>
                      </>
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

              {/* Send to Print quick button for approved campaigns */}
              {campaign.status === "approved" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={(e) => {
                    e.stopPropagation()
                    handlePrintConfirm(campaign)
                  }}
                  disabled={printSubmittingId === campaign.id}
                >
                  {printSubmittingId === campaign.id ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Printer className="h-4 w-4 mr-2" />
                  )}
                  Send to Print
                </Button>
              )}

              <p className="text-xs text-muted-foreground mt-3">
                Created {formatDistanceToNow(new Date(campaign.created_at))} ago
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Print Fulfillment Confirmation Dialog */}
      <AlertDialog
        open={!!printConfirmCampaign}
        onOpenChange={(o) => {
          if (!o) {
            setPrintConfirmCampaign(null)
            setValidationSummary(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit to Print Fulfillment?</AlertDialogTitle>
            <AlertDialogDescription>
              This will submit <strong>{printConfirmCampaign?.campaign_name}</strong> to print fulfillment.
              {printConfirmCampaign?.per_piece_cost && printConfirmCampaign?.quantity && (
                <>
                  {" "}Estimated cost:{" "}
                  <strong>
                    ${(printConfirmCampaign.per_piece_cost * printConfirmCampaign.quantity).toFixed(2)}
                  </strong>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {validationSummary !== null && (
            <div className="rounded-lg border bg-muted/50 px-4 py-3 text-sm space-y-1">
              <p className="font-medium">Mailing List Validation</p>
              <div className="flex gap-4 text-xs text-muted-foreground">
                <span className="text-green-600 font-medium">{validationSummary.valid} valid</span>
                {validationSummary.invalid > 0 && (
                  <span className="text-destructive font-medium">{validationSummary.invalid} invalid</span>
                )}
                <span>{validationSummary.total} total</span>
              </div>
              {validationSummary.invalid > 0 && (
                <p className="text-xs text-destructive">
                  {validationSummary.invalid} address{validationSummary.invalid !== 1 ? "es" : ""} will be skipped.
                </p>
              )}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSubmitToPrint}>
              Confirm &amp; Submit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
