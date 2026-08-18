"use client"

/**
 * DESCRIPTION APPROVAL — the "Approve & Publish" half the composer doesn't cover.
 *
 * The content rail (generateListingDescription / enhancedGenerateListingDescription)
 * writes drafts into ai_generated_content with compliance_approved=false; the
 * composer beside this card only edits public_remarks directly and never sees
 * those rows. saveDescriptionToListing is the one action that closes the loop —
 * it publishes the approved text to listings.public_remarks AND flips the draft
 * row to approved (a compliance attestation) — and it had no caller. The agent
 * can edit the draft before approving; publishing marks the copy-review stale,
 * so the Fair Housing gate re-runs against what was actually published.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, FileCheck2, TriangleAlert } from "lucide-react"
import { saveDescriptionToListing } from "@/app/actions/ai-content-generation"

export interface PendingDescriptionDraft {
  id: string
  text: string
  createdAt: string | null
  complianceStatus: string | null
}

export function DescriptionApprovalCard({ listingId, draft }: {
  listingId: string
  draft: PendingDescriptionDraft
}) {
  const router = useRouter()
  const [text, setText] = useState(draft.text)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [isPending, startTransition] = useTransition()

  const approve = () => {
    setError(null)
    startTransition(async () => {
      const res = await saveDescriptionToListing({ listingId, contentId: draft.id, approvedText: text })
      if (!res.success) { setError(res.error ?? "The description was not published."); return }
      setDone(true)
      router.refresh()
    })
  }

  if (done) return null

  return (
    <Card className="mb-6 border-amber-300">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileCheck2 className="h-4 w-4 text-amber-600" />
          AI description awaiting approval
        </CardTitle>
        <CardDescription>
          Drafted by the content engine{draft.createdAt ? ` on ${new Date(draft.createdAt).toLocaleDateString()}` : ""}.
          Approving publishes it as the listing's public marketing description and records your sign-off on the draft.
          {draft.complianceStatus && draft.complianceStatus !== "approved" && (
            <Badge variant="outline" className="ml-2 text-[10px] border-amber-300 text-amber-700 capitalize">
              compliance: {draft.complianceStatus}
            </Badge>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          disabled={isPending}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
        />
        {error && (
          <p className="text-xs text-red-600 flex items-start gap-1.5">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" /><span>{error}</span>
          </p>
        )}
        <Button size="sm" onClick={approve} disabled={isPending || !text.trim()}>
          {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileCheck2 className="h-3.5 w-3.5 mr-1.5" />}
          Approve &amp; Publish
        </Button>
      </CardContent>
    </Card>
  )
}
