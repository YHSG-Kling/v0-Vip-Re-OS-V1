"use client"

import { useState } from "react"
import { Zap, Heart, Star, Gift, PlusCircle, GitBranch, Award } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ReferralAiDraftingPanel } from "./referral-ai-drafting-panel"
import { GratitudeGiftingPanel } from "./gratitude-gifting-panel"
import Link from "next/link"

interface AdvocacyActionStackProps {
  agentId: string
  defaultContactId?: string
  defaultContactName?: string
  onOpenCreate: () => void
  onOpenPipeline: () => void
  onOpenReputationFull?: () => void
}

export function AdvocacyActionStack({
  agentId,
  defaultContactId = "",
  defaultContactName = "Client",
  onOpenCreate,
  onOpenPipeline,
  onOpenReputationFull,
}: AdvocacyActionStackProps) {
  const [referralDraftOpen, setReferralDraftOpen] = useState(false)
  const [thankYouOpen, setThankYouOpen] = useState(false)

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-500" />
            Quick Actions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            {/* Ask for Referral */}
            <Button
              variant="outline"
              className="h-auto py-4 flex flex-col items-center gap-2"
              onClick={() => setReferralDraftOpen(true)}
            >
              <Heart className="h-5 w-5 text-rose-500" />
              <span className="text-sm">Ask for Referral</span>
            </Button>

            {/* Request Review */}
            <Link href="#review-section" className="block">
              <Button
                variant="outline"
                className="w-full h-auto py-4 flex flex-col items-center gap-2"
              >
                <Star className="h-5 w-5 text-amber-500" />
                <span className="text-sm">Request Review</span>
              </Button>
            </Link>

            {/* Send Thank You */}
            <Button
              variant="outline"
              className="h-auto py-4 flex flex-col items-center gap-2"
              onClick={() => setThankYouOpen(true)}
            >
              <Gift className="h-5 w-5 text-violet-500" />
              <span className="text-sm">Send Thank You</span>
            </Button>

            {/* Create Referral */}
            <Button
              variant="outline"
              className="h-auto py-4 flex flex-col items-center gap-2"
              onClick={onOpenCreate}
            >
              <PlusCircle className="h-5 w-5 text-emerald-500" />
              <span className="text-sm">Create Referral</span>
            </Button>

            {/* Open Pipeline */}
            <Button
              variant="outline"
              className="h-auto py-4 flex flex-col items-center gap-2"
              onClick={onOpenPipeline}
            >
              <GitBranch className="h-5 w-5 text-blue-500" />
              <span className="text-sm">Open Pipeline</span>
            </Button>

            {/* Full Reputation */}
            <Link href="/dashboard/reputation" className="block">
              <Button
                variant="outline"
                className="w-full h-auto py-4 flex flex-col items-center gap-2"
              >
                <Award className="h-5 w-5 text-amber-500" />
                <span className="text-sm">Full Reputation</span>
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Referral Drafting Dialog */}
      <Dialog open={referralDraftOpen} onOpenChange={setReferralDraftOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Draft Referral Ask</DialogTitle>
          </DialogHeader>
          <ReferralAiDraftingPanel
            agentId={agentId}
            contactId={defaultContactId}
            contactName={defaultContactName}
            onDraftComplete={() => setReferralDraftOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Thank You Dialog */}
      <Dialog open={thankYouOpen} onOpenChange={setThankYouOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Send Appreciation</DialogTitle>
          </DialogHeader>
          <GratitudeGiftingPanel
            agentId={agentId}
            contactId={defaultContactId}
            contactName={defaultContactName}
            onComplete={() => setThankYouOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
