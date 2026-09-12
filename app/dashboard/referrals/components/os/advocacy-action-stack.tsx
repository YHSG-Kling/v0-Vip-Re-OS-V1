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
  /**
   * A real contacts.id. This defaulted to "" and the composition never passed
   * anything, so both dialogs below opened against an empty id: every action
   * inside them fails isValidUUID("") upstream and returns without a word, so
   * the agent watched a dialog do nothing twice. Both controls are now disabled,
   * and say why, until a contact is actually selected.
   */
  defaultContactId?: string
  defaultContactName?: string
  onOpenCreate: () => void
  onOpenPipeline: () => void
  /**
   * Was destructured and never used while the button beneath it hard-linked to
   * /dashboard/reputation. Now it drives the button when supplied; the link is
   * the fallback so the control never loses its destination.
   */
  onOpenReputationFull?: () => void
  /**
   * "Request Review" was `<Link href="#review-section">` and no element with
   * that id existed anywhere in the repo, so the button scrolled nowhere. The
   * composition passes a handler that reveals the real ReviewRequestPanel.
   */
  onRequestReview?: () => void
}

export function AdvocacyActionStack({
  agentId,
  defaultContactId = "",
  defaultContactName = "",
  onOpenCreate,
  onOpenPipeline,
  onOpenReputationFull,
  onRequestReview,
}: AdvocacyActionStackProps) {
  const [referralDraftOpen, setReferralDraftOpen] = useState(false)
  const [thankYouOpen, setThankYouOpen] = useState(false)

  const hasContact = defaultContactId.trim().length > 0
  const contactName = defaultContactName.trim() || "this client"
  const noContactHint = "Select a client above first — these both act on one person."

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
              disabled={!hasContact}
              title={hasContact ? `Draft a referral ask for ${contactName}` : noContactHint}
            >
              <Heart className="h-5 w-5 text-rose-500" />
              <span className="text-sm">Ask for Referral</span>
            </Button>

            {/* Request Review */}
            <Button
              variant="outline"
              className="w-full h-auto py-4 flex flex-col items-center gap-2"
              onClick={onRequestReview}
              disabled={!onRequestReview}
              title={onRequestReview ? "Jump to review requests" : "Review requests are not on this screen"}
            >
              <Star className="h-5 w-5 text-amber-500" />
              <span className="text-sm">Request Review</span>
            </Button>

            {/* Send Thank You */}
            <Button
              variant="outline"
              className="h-auto py-4 flex flex-col items-center gap-2"
              onClick={() => setThankYouOpen(true)}
              disabled={!hasContact}
              title={hasContact ? `Send appreciation to ${contactName}` : noContactHint}
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
            {onOpenReputationFull ? (
              <Button
                variant="outline"
                className="w-full h-auto py-4 flex flex-col items-center gap-2"
                onClick={onOpenReputationFull}
              >
                <Award className="h-5 w-5 text-amber-500" />
                <span className="text-sm">Full Reputation</span>
              </Button>
            ) : (
              <Link href="/dashboard/reputation" className="block">
                <Button
                  variant="outline"
                  className="w-full h-auto py-4 flex flex-col items-center gap-2"
                >
                  <Award className="h-5 w-5 text-amber-500" />
                  <span className="text-sm">Full Reputation</span>
                </Button>
              </Link>
            )}
          </div>

          {!hasContact && (
            <p className="mt-3 text-xs text-muted-foreground">{noContactHint}</p>
          )}
        </CardContent>
      </Card>

      {/* Referral Drafting Dialog — only mounted with a real contact, because the
          AI actions inside it look the id up in `contacts`. */}
      {hasContact && (
        <Dialog open={referralDraftOpen} onOpenChange={setReferralDraftOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Draft Referral Ask</DialogTitle>
            </DialogHeader>
            <ReferralAiDraftingPanel
              agentId={agentId}
              contactId={defaultContactId}
              contactName={contactName}
              onDraftComplete={() => setReferralDraftOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Thank You Dialog */}
      {hasContact && (
        <Dialog open={thankYouOpen} onOpenChange={setThankYouOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Send Appreciation</DialogTitle>
            </DialogHeader>
            <GratitudeGiftingPanel
              agentId={agentId}
              contactId={defaultContactId}
              contactName={contactName}
              onComplete={() => setThankYouOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
