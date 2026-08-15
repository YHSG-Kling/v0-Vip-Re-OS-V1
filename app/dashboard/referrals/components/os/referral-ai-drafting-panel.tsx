"use client"

import { useState, useEffect, useTransition } from "react"
import { Sparkles, Loader2, Copy, Check, CheckCircle, AlertCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { aiOptimizeReferralAsk, aiGenerateTouchpoint } from "@/app/actions/ai-sphere-management"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"
import { checkThemFirstCompliance } from "@/app/actions/ai-chat"

interface ReferralAiDraftingPanelProps {
  agentId: string
  contactId: string
  contactName: string
  onDraftComplete?: (draft: string) => void
}

export function ReferralAiDraftingPanel({
  agentId,
  contactId,
  contactName,
  onDraftComplete,
}: ReferralAiDraftingPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [context, setContext] = useState<string>("")
  const [relationshipType, setRelationshipType] = useState<string>("lifetime-customer")
  const [draft, setDraft] = useState<string>("")
  const [brandVoice, setBrandVoice] = useState<any>(null)
  const [complianceResult, setComplianceResult] = useState<{
    isCompliant: boolean
    issues?: string[]
  } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    getBrandVoiceProfile(agentId).then(setBrandVoice)
  }, [agentId])

  const handleGenerateDraft = () => {
    startTransition(async () => {
      // First optimize the ask
      const optimizeResult = await aiOptimizeReferralAsk({
        agentId,
        contactId,
      })

      // Then generate the touchpoint
      const touchpointResult = await aiGenerateTouchpoint({
        agentId,
        contactId,
        touchpointType: "referral_ask",
      })

      if (touchpointResult.success && (touchpointResult as any).data?.message) {
        setDraft((touchpointResult as any).data?.message ?? "")

        // Check compliance
        const compliance = await checkThemFirstCompliance((touchpointResult as any).data?.message ?? "")
        setComplianceResult(compliance)
      }
    })
  }

  const copyToClipboard = () => {
    navigator.clipboard.writeText(draft)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleUse = () => {
    if (onDraftComplete) {
      onDraftComplete(draft)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-violet-500" />
          AI Referral Ask Drafter
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Context */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            Why would {contactName} refer you?
          </label>
          <Textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="e.g., We had a great experience working together on their home purchase..."
            rows={3}
          />
        </div>

        {/* Relationship Type */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Relationship Type</label>
          <Select value={relationshipType} onValueChange={setRelationshipType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="friend">Friend</SelectItem>
              <SelectItem value="family">Family</SelectItem>
              <SelectItem value="lifetime-customer">Lifetime Customer</SelectItem>
              <SelectItem value="colleague">Colleague</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Generate Button */}
        <Button onClick={handleGenerateDraft} disabled={isPending} className="w-full">
          {isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4 mr-2" />
          )}
          Generate Referral Ask
        </Button>

        {/* Draft Display */}
        {draft && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {brandVoice?.name ? `Using ${brandVoice.name} voice` : "Brand voice applied"}
              </span>
              {complianceResult && (
                <Badge
                  variant={complianceResult.isCompliant ? "default" : "destructive"}
                  className="flex items-center gap-1"
                >
                  {complianceResult.isCompliant ? (
                    <CheckCircle className="h-3 w-3" />
                  ) : (
                    <AlertCircle className="h-3 w-3" />
                  )}
                  {complianceResult.isCompliant ? "Compliant" : "Review Needed"}
                </Badge>
              )}
            </div>

            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="font-mono text-sm"
            />

            {complianceResult && !complianceResult.isCompliant && complianceResult.issues && (
              <div className="p-2 rounded bg-destructive/10 text-destructive text-xs">
                <p className="font-medium">Issues found:</p>
                <ul className="list-disc list-inside">
                  {complianceResult.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={copyToClipboard}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="ml-1">Copy</span>
              </Button>
              <Button size="sm" onClick={handleUse}>
                Use This
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
