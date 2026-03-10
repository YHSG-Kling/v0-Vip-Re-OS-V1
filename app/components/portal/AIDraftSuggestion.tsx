"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Sparkles, ChevronDown, Copy, X, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { generateAIDraft } from "@/app/actions/portal-messages"

interface AIDraftSuggestionProps {
  contactId: string
  transactionId?: string
  onUseDraft: (draft: string) => void
  isAgent: boolean
}

/**
 * AIDraftSuggestion - Collapsible panel showing AI-generated draft.
 * 
 * DRAFT-FIRST LAW:
 * - Draft is generated but NEVER auto-populated to composer
 * - Agent must click "Use This Draft" to copy to composer
 * - Agent can dismiss with "Dismiss" button
 * - Only visible to agents (isAgent = true)
 */
export function AIDraftSuggestion({
  contactId,
  transactionId,
  onUseDraft,
  isAgent,
}: AIDraftSuggestionProps) {
  const [isOpen, setIsOpen] = useState(true)
  const [isDismissed, setIsDismissed] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only show for agents
  if (!isAgent) return null

  // Load draft on mount
  useEffect(() => {
    if (isDismissed) return

    async function loadDraft() {
      setIsLoading(true)
      setError(null)
      try {
        const result = await generateAIDraft({ contactId, transactionId })
        if (result.success && result.draft) {
          setDraft(result.draft)
        } else {
          setError(result.error || "Failed to generate draft")
        }
      } catch {
        setError("Failed to generate draft")
      } finally {
        setIsLoading(false)
      }
    }

    loadDraft()
  }, [contactId, transactionId, isDismissed])

  // If dismissed, don't render
  if (isDismissed) return null

  const handleUseDraft = () => {
    if (draft) {
      onUseDraft(draft)
      setIsDismissed(true)
    }
  }

  const handleDismiss = () => {
    setIsDismissed(true)
  }

  return (
    <Card className="mx-4 mb-2 bg-muted/50 border-primary/20">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer py-3 px-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                AI Draft Suggestion
              </CardTitle>
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  isOpen && "rotate-180"
                )}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Review before sending
            </p>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 pb-4 px-4">
            {/* Loading state */}
            {isLoading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">
                  Generating draft...
                </span>
              </div>
            )}

            {/* Error state */}
            {error && !isLoading && (
              <div className="py-4 text-sm text-muted-foreground text-center">
                {error}
              </div>
            )}

            {/* Draft content */}
            {draft && !isLoading && (
              <>
                <div className="bg-background rounded-lg p-3 text-sm leading-relaxed border">
                  {draft}
                </div>

                <div className="flex items-center gap-2 mt-3">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleUseDraft}
                    className="flex-1"
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    Use This Draft
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDismiss}
                  >
                    <X className="h-4 w-4 mr-1" />
                    Dismiss
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
