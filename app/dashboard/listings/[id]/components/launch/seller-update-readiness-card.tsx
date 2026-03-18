"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, XCircle, Mail, Loader2, Sparkles, Send } from "lucide-react"
import { generateSellerUpdateDraft } from "@/app/actions/seller-updates"

interface SellerUpdateReadinessCardProps {
  listingId: string
  agentId: string
  hasPendingDraft: boolean
  lastSentAt?: string
}

export function SellerUpdateReadinessCard({
  listingId,
  agentId,
  hasPendingDraft,
  lastSentAt,
}: SellerUpdateReadinessCardProps) {
  const [isPending, startTransition] = useTransition()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleGenerateDraft = () => {
    startTransition(async () => {
      try {
        const result = await generateSellerUpdateDraft({ listingId, agentId })
        if ('draft' in result && result.draft) {
          setDraft(result.draft)
          setError(null)
        } else if ('error' in result) {
          setError(result.error as string)
        }
      } catch {
        setError("Failed to generate draft")
      }
    })
  }

  const isReady = hasPendingDraft || !!draft

  return (
    <Card className={isReady ? "border-green-200 bg-green-50/30" : "border-muted"}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-indigo-600" />
            Seller Launch Update
          </span>
          <Badge variant={isReady ? "default" : "secondary"} className="text-xs">
            {isReady ? "Draft Ready" : "Not Generated"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {isReady ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              AI Launch Update
            </span>
            <span className={isReady ? "text-green-700 font-medium" : "text-muted-foreground"}>
              {isReady ? "Ready to Review" : "Not Generated"}
            </span>
          </div>

          {lastSentAt && (
            <div className="flex items-center justify-between text-xs">
              <span>Last Sent</span>
              <span className="text-muted-foreground">
                {new Date(lastSentAt).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>

        {draft && (
          <div className="p-2 bg-muted/50 rounded text-xs max-h-24 overflow-y-auto">
            {draft.slice(0, 200)}...
          </div>
        )}

        {error && (
          <p className="text-xs text-red-600">{error}</p>
        )}

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 text-xs"
            onClick={handleGenerateDraft}
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            )}
            {draft ? "Regenerate" : "Generate Draft"}
          </Button>
          {draft && (
            <Button size="sm" className="text-xs">
              <Send className="h-3.5 w-3.5 mr-1.5" />
              Review & Send
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
