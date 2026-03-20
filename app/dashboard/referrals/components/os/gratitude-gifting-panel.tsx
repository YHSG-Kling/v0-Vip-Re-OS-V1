"use client"

import { useState, useEffect, useTransition } from "react"
import { Gift, Sparkles, Loader2, Copy, Check, ExternalLink } from "lucide-react"
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
import { aiRecommendGift, aiGenerateThankYouNote } from "@/app/actions/ai-client-gifting"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation.tsx"
import { checkThemFirstCompliance } from "@/app/actions/ai-chat"

type Occasion = "closing" | "anniversary" | "referral" | "holiday"

interface GratitudeGiftingPanelProps {
  agentId: string
  contactId: string
  contactName: string
  occasion?: Occasion
  onComplete?: () => void
}

export function GratitudeGiftingPanel({
  agentId,
  contactId,
  contactName,
  occasion: initialOccasion = "closing",
  onComplete,
}: GratitudeGiftingPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [occasion, setOccasion] = useState<Occasion>(initialOccasion)
  const [budgetRange, setBudgetRange] = useState<string>("50-100")
  const [giftRec, setGiftRec] = useState<{
    item: string
    rationale: string
    link?: string
  } | null>(null)
  const [thankYouNote, setThankYouNote] = useState<string>("")
  const [brandVoice, setBrandVoice] = useState<any>(null)
  const [complianceOk, setComplianceOk] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    getBrandVoiceProfile(agentId).then(setBrandVoice)
  }, [agentId])

  const handleRecommendGift = () => {
    const [minStr, maxStr] = budgetRange.split("-")
    const min = parseInt(minStr, 10)
    const max = parseInt(maxStr, 10)

    startTransition(async () => {
      const result = await aiRecommendGift({
        agentId,
        contactId,
        occasion,
        budget: { min, max },
      })
      if (result.success && result.recommendation) {
        setGiftRec(result.recommendation)
      }
    })
  }

  const handleGenerateNote = () => {
    startTransition(async () => {
      const result = await aiGenerateThankYouNote({
        agentId,
        contactId,
        occasion,
        handwritten: true,
      })
      if (result.success && result.note) {
        setThankYouNote(result.note)
        // Check compliance
        const compliance = await checkThemFirstCompliance(result.note)
        setComplianceOk(compliance.isCompliant)
      }
    })
  }

  const copyNote = () => {
    navigator.clipboard.writeText(thankYouNote)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Gift className="h-5 w-5 text-rose-500" />
          Appreciation for {contactName}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Occasion & Budget */}
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground mb-1 block">Occasion</label>
            <Select value={occasion} onValueChange={(v) => setOccasion(v as Occasion)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="closing">Closing</SelectItem>
                <SelectItem value="anniversary">Anniversary</SelectItem>
                <SelectItem value="referral">Referral</SelectItem>
                <SelectItem value="holiday">Holiday</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted-foreground mb-1 block">Budget Range</label>
            <Select value={budgetRange} onValueChange={setBudgetRange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="50-100">$50 - $100</SelectItem>
                <SelectItem value="100-200">$100 - $200</SelectItem>
                <SelectItem value="200-500">$200 - $500</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Recommend Gift */}
        <div>
          <Button onClick={handleRecommendGift} disabled={isPending} variant="outline" className="w-full">
            {isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
            Recommend Gift
          </Button>
          {giftRec && (
            <div className="mt-3 p-3 rounded-lg border bg-muted/30">
              <p className="font-medium text-sm">{giftRec.item}</p>
              <p className="text-xs text-muted-foreground mt-1">{giftRec.rationale}</p>
              {giftRec.link && (
                <a
                  href={giftRec.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary mt-2 hover:underline"
                >
                  Order <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}
        </div>

        {/* Thank You Note */}
        <div>
          <Button onClick={handleGenerateNote} disabled={isPending} variant="outline" className="w-full">
            {isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
            Generate Thank You Note
          </Button>
          {thankYouNote && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {brandVoice?.name ? `Using ${brandVoice.name} voice` : "Brand voice applied"}
                </span>
                {complianceOk !== null && (
                  <Badge variant={complianceOk ? "default" : "destructive"} className="text-xs">
                    {complianceOk ? "Compliant" : "Review Needed"}
                  </Badge>
                )}
              </div>
              <Textarea
                value={thankYouNote}
                onChange={(e) => setThankYouNote(e.target.value)}
                rows={4}
                className="font-mono text-sm"
              />
              <Button size="sm" variant="outline" onClick={copyNote}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="ml-1">Copy</span>
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
