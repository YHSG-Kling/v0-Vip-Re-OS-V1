"use client"

import { useState, useTransition } from "react"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Users, ShieldCheck, Send } from "lucide-react"
import {
  createNeighborNotificationCampaign,
  grantSellerPermission,
  launchNeighborNotification,
} from "@/app/actions/neighbor-notifications"

interface Props {
  listingId: string
  brokerageId: string
  agentUserId: string
  /** Seller contact for the audit trail on grantSellerPermission. */
  sellerContactId: string | null
}

type Phase = "idle" | "identified" | "approved" | "sent"

const STATUS_LABEL: Record<Phase, string> = {
  idle: "Not started",
  identified: "Awaiting seller permission",
  approved: "Permission granted — ready to launch",
  sent: "Sent to direct mail pipeline",
}

const STATUS_VARIANT: Record<Phase, "secondary" | "outline" | "default"> = {
  idle: "outline",
  identified: "secondary",
  approved: "secondary",
  sent: "default",
}

/**
 * "Notify Neighbors" card — surfaces the 3-step GOVERNED neighbor-farming flow.
 * Every send routes through launchNeighborNotification, which pushes recipients
 * into the existing direct_mail_campaigns + direct_mail_recipients pipeline
 * (Lob pre-flight + compliance). This card never sends directly.
 */
export function NeighborNotificationCard({
  listingId,
  brokerageId,
  agentUserId,
  sellerContactId,
}: Props) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [phase, setPhase] = useState<Phase>("idle")
  const [campaignId, setCampaignId] = useState<string | null>(null)
  const [identified, setIdentified] = useState<number | null>(null)
  const [sent, setSent] = useState<number | null>(null)

  function handleIdentify() {
    startTransition(async () => {
      const res = await createNeighborNotificationCampaign({
        listingId,
        brokerageId,
        agentUserId,
      })
      if (!res.success || !res.campaignId) {
        toast({
          title: "Could not identify neighbors",
          description: res.error ?? "An error occurred.",
          variant: "destructive",
        })
        return
      }
      setCampaignId(res.campaignId)
      setIdentified(res.identified ?? 0)
      setPhase("identified")
      toast({
        title: "Neighbors identified",
        description: `${res.identified ?? 0} candidate${(res.identified ?? 0) === 1 ? "" : "s"} ready for seller approval.`,
      })
    })
  }

  function handleGrantPermission() {
    if (!campaignId) return
    if (!sellerContactId) {
      toast({
        title: "No seller on file",
        description: "Add a seller contact to this listing before recording permission.",
        variant: "destructive",
      })
      return
    }
    startTransition(async () => {
      const res = await grantSellerPermission({
        campaignId,
        sellerContactId,
        brokerageId,
      })
      if (!res.success) {
        toast({
          title: "Could not record permission",
          description: res.error ?? "An error occurred.",
          variant: "destructive",
        })
        return
      }
      setPhase("approved")
      toast({
        title: "Seller permission recorded",
        description: "You can now launch the neighbor notification.",
      })
    })
  }

  function handleLaunch() {
    if (!campaignId) return
    startTransition(async () => {
      const res = await launchNeighborNotification({ campaignId, brokerageId })
      if (!res.success) {
        toast({
          title: "Launch failed",
          description: res.error ?? "An error occurred.",
          variant: "destructive",
        })
        return
      }
      // "staged", not "sent": the rows are written but no dispatcher has
      // released them to Lob yet, so saying sent would repeat the lie the
      // action itself used to tell.
      const staged = res.staged ?? 0
      setSent(staged)
      setPhase("sent")
      toast({
        title: "Neighbor postcards staged",
        description: `${staged} recipient${staged === 1 ? "" : "s"} staged for mailing. Nothing is printed until the mail run is approved and released.`,
      })
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-blue-500" />
              Notify Neighbors
            </CardTitle>
            <CardDescription className="mt-1">
              Tell nearby owners this home just listed — they often know a buyer.
              Sends route through your governed direct mail pipeline.
            </CardDescription>
          </div>
          <Badge variant={STATUS_VARIANT[phase]}>{STATUS_LABEL[phase]}</Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {identified != null && (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{identified}</span>{" "}
            neighbor{identified === 1 ? "" : "s"} identified
            {sent != null && (
              <>
                {" · "}
                <span className="font-medium text-foreground">{sent}</span> queued
                for mailing
              </>
            )}
          </p>
        )}

        {/* Step 1 */}
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={handleIdentify}
          disabled={isPending || phase !== "idle"}
        >
          {isPending && phase === "idle" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Users className="h-3.5 w-3.5" />
          )}
          1. Identify neighbor candidates
        </Button>

        {/* Step 2 — gated on identification */}
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={handleGrantPermission}
          disabled={isPending || phase !== "identified"}
        >
          {isPending && phase === "identified" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          2. Record seller permission
        </Button>

        {/* Step 3 — gated on seller permission; cannot launch before approval */}
        <Button
          size="sm"
          className="w-full justify-start gap-2"
          onClick={handleLaunch}
          disabled={isPending || phase !== "approved"}
        >
          {isPending && phase === "approved" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          3. Launch via direct mail pipeline
        </Button>

        {phase === "sent" && (
          <p className="text-xs text-muted-foreground">
            Recipients are now in the governed direct mail pipeline (Lob pre-flight
            + compliance). Track delivery from Direct Mail campaigns.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
