"use client"

/**
 * "Draft Thank-You Note" — the UI half of draftReferralThankYou
 * (app/actions/referrals/referral-actions.ts), which replaced the deleted
 * /api/referrals/thank-you-draft route (lane N3a 2026-09-01). Sits beside the
 * "Mark Thank-You Sent" button on each pipeline card: the action returns words
 * for the physical card the agent writes and posts — nothing is sent from here.
 */

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { PenLine } from "lucide-react"
import { draftReferralThankYou } from "@/app/actions/referrals/referral-actions"

export function DraftThankYouButton({ referralId }: { referralId: string }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isPending, startTransition] = useTransition()

  const requestDraft = () => {
    setError(null)
    setCopied(false)
    startTransition(async () => {
      const result = await draftReferralThankYou(referralId)
      if (result.success && result.draft) {
        setDraft(result.draft)
        setOpen(true)
      } else {
        setError(result.error ?? "Could not draft the note.")
      }
    })
  }

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draft)
      setCopied(true)
    } catch {
      // Clipboard can be unavailable (permissions); the text stays selectable.
      setCopied(false)
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={requestDraft}
        disabled={isPending}
      >
        <PenLine className="w-3 h-3 mr-1" />
        {isPending ? "Drafting…" : "Draft Thank-You Note"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Thank-you note draft</DialogTitle>
            <DialogDescription>
              Copy this into the handwritten card — nothing is sent automatically.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={7}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button size="sm" onClick={copyDraft}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
