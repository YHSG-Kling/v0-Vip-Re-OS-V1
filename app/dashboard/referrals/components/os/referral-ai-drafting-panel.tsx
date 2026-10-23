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
  /**
   * A contacts.id — and ONLY a contacts.id. The composition used to pass
   * `selectedContactId || agentId`; an agents.id is a different id space, so
   * both AI actions below looked it up in `contacts`, found nothing, and
   * returned "Contact not found" that this panel never showed. Callers must
   * resolve a real contact before mounting this panel.
   */
  contactId: string
  contactName: string
  onDraftComplete?: (draft: string) => void
}

/**
 * The shape checkThemFirstCompliance actually returns (ai-chat.ts →
 * analyzeThemFirstLanguage). This panel used to store the result as
 * `{ isCompliant, issues }`, a shape that function has never produced, so
 * `isCompliant` was permanently undefined: the badge said "Review Needed" on
 * every single draft, however good, and the issues list could never render.
 * gratitude-gifting-panel.tsx reads the same call correctly (score >= 50).
 */
interface ThemFirstResult {
  score: number
  themFirstCount: number
  agentFirstCount: number
  feedback: string
}

/** What aiOptimizeReferralAsk returns. It was awaited and then discarded — a
 *  full GPT-4o call, billed on every click, whose entire output was dropped. */
interface ReferralStrategy {
  readinessScore: number
  bestChannel: string
  bestTiming: string
  askScript: string
  incentiveRecommendation?: { type: string; value: string; reason: string }
  objectionHandling?: Array<{ objection: string; response: string }>
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
  const [complianceResult, setComplianceResult] = useState<ThemFirstResult | null>(null)
  const [strategy, setStrategy] = useState<ReferralStrategy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    getBrandVoiceProfile(agentId).then(setBrandVoice)
  }, [agentId])

  const handleGenerateDraft = () => {
    setError(null)
    startTransition(async () => {
      // Both calls now carry what the agent typed. "Additional context" and
      // "Relationship type" were collected into state and sent nowhere, so the
      // two inputs on this card could not change a single word of the output.
      const askInput = {
        agentId,
        contactId,
        additionalContext: context,
        relationshipType,
      }

      const optimizeResult = await aiOptimizeReferralAsk(askInput)
      const optimized = (optimizeResult as any).data as ReferralStrategy | undefined
      setStrategy(optimizeResult.success && optimized ? optimized : null)

      const touchpointResult = await aiGenerateTouchpoint({
        ...askInput,
        touchpointType: "referral_ask",
      })
      const message: string | undefined = (touchpointResult as any).data?.message

      // The strategy call already produced a usable ask script, so a failed
      // touchpoint no longer has to mean an empty box.
      const text = (touchpointResult.success && message) || optimized?.askScript || ""

      if (!text) {
        // A refusal used to leave the panel exactly as it was — no draft, no
        // message — which reads as "nothing happened" rather than "it failed".
        setError(
          (touchpointResult as any).error ??
            (optimizeResult as any).error ??
            "Could not draft a referral ask",
        )
        return
      }

      setDraft(text)
      const compliance = (await checkThemFirstCompliance(text)) as ThemFirstResult
      setComplianceResult(compliance)
    })
  }

  // Same threshold the gifting panel uses, so the two badges cannot disagree.
  const isCompliant = complianceResult ? complianceResult.score >= 50 : null

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

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {/* Ask strategy — the output of aiOptimizeReferralAsk */}
        {strategy && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div>
                <p className="text-muted-foreground">Readiness</p>
                <p className="font-semibold">{strategy.readinessScore}/100</p>
              </div>
              <div>
                <p className="text-muted-foreground">Best channel</p>
                <p className="font-semibold capitalize">
                  {String(strategy.bestChannel).replace(/_/g, " ")}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Best timing</p>
                <p className="font-semibold">{strategy.bestTiming}</p>
              </div>
            </div>
            {strategy.incentiveRecommendation && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {strategy.incentiveRecommendation.type} ({strategy.incentiveRecommendation.value})
                </span>{" "}
                — {strategy.incentiveRecommendation.reason}
              </p>
            )}
            {strategy.objectionHandling && strategy.objectionHandling.length > 0 && (
              <div className="text-xs space-y-1">
                <p className="font-medium">If they hesitate</p>
                <ul className="list-disc list-inside text-muted-foreground">
                  {strategy.objectionHandling.slice(0, 3).map((o, i) => (
                    <li key={i}>
                      <span className="text-foreground">{o.objection}</span> — {o.response}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Draft Display */}
        {draft && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {brandVoice?.name ? `Using ${brandVoice.name} voice` : "Brand voice applied"}
              </span>
              {isCompliant !== null && (
                <Badge
                  variant={isCompliant ? "default" : "destructive"}
                  className="flex items-center gap-1"
                >
                  {isCompliant ? (
                    <CheckCircle className="h-3 w-3" />
                  ) : (
                    <AlertCircle className="h-3 w-3" />
                  )}
                  {isCompliant ? "Compliant" : "Review Needed"}
                </Badge>
              )}
            </div>

            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="font-mono text-sm"
            />

            {complianceResult && isCompliant === false && (
              <div className="p-2 rounded bg-destructive/10 text-destructive text-xs">
                <p className="font-medium">Them-first score {complianceResult.score}/100</p>
                <p>{complianceResult.feedback}</p>
                <p className="mt-1">
                  {complianceResult.themFirstCount} them-first phrase
                  {complianceResult.themFirstCount === 1 ? "" : "s"} vs{" "}
                  {complianceResult.agentFirstCount} agent-first
                </p>
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
