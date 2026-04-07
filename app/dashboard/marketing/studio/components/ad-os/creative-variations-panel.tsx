"use client"

// ============================================================
// Creative Variations Panel
// Generates 3 ad copy variations using brand voice.
// ============================================================

import { useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Loader2, Sparkles, Copy, CheckCheck } from "lucide-react"
import { generateMarketingInsight } from "./ad-os-actions"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"

interface Props {
  agentId: string
}

interface Variation {
  label: string
  headline: string
  body: string
  cta: string
  copied: boolean
}

export function CreativeVariationsPanel({ agentId }: Props) {
  const [headline, setHeadline] = useState("")
  const [notes, setNotes] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)
  const [variations, setVariations] = useState<Variation[]>([])
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate() {
    if (!headline.trim() || !agentId) return
    setIsGenerating(true)
    setVariations([])
    setError(null)

    try {
      const brandVoice = await getBrandVoiceProfile(agentId)
      const tone = (brandVoice as any)?.tone ?? "professional yet approachable"
      const style = (brandVoice as any)?.style ?? "conversational"

      const prompt = `Generate 3 distinct ad copy variations for a real estate listing.

HEADLINE IDEA: ${headline.trim()}
${notes.trim() ? `ADDITIONAL NOTES: ${notes.trim()}` : ""}
BRAND TONE: ${tone}
BRAND STYLE: ${style}

For each variation, try a different angle: emotional, data-driven, and lifestyle-focused.

Return ONLY valid JSON:
[
  {"label":"Emotional","headline":"...","body":"...","cta":"..."},
  {"label":"Data-Driven","headline":"...","body":"...","cta":"..."},
  {"label":"Lifestyle","headline":"...","body":"...","cta":"..."}
]`

      const res = await generateMarketingInsight(prompt)
      if (!res.success || !res.text) {
        setError(res.error ?? "Generation failed")
        return
      }

      const jsonMatch = res.text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        setError("Failed to parse AI response")
        return
      }

      const parsed: Array<{ label: string; headline: string; body: string; cta: string }> =
        JSON.parse(jsonMatch[0])
      setVariations(parsed.map((v) => ({ ...v, copied: false })))
    } catch {
      setError("Unexpected error — please try again")
    } finally {
      setIsGenerating(false)
    }
  }

  function handleCopy(idx: number) {
    const v = variations[idx]
    navigator.clipboard.writeText(`${v.headline}\n\n${v.body}\n\n${v.cta}`)
    setVariations((prev) => prev.map((x, i) => (i === idx ? { ...x, copied: true } : x)))
    setTimeout(
      () => setVariations((prev) => prev.map((x, i) => (i === idx ? { ...x, copied: false } : x))),
      2000
    )
  }

  return (
    <Card className="border-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-violet-600" />
          Creative Variations
        </CardTitle>
        <CardDescription>
          Generate 3 distinct ad copy angles in your brand voice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Core Headline / Theme</Label>
          <Input
            placeholder="e.g. Stunning 4BR with rooftop views in Nashville"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Additional Context (optional)</Label>
          <Textarea
            placeholder="Price point, target buyer, key features..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="min-h-[60px] text-sm resize-none"
          />
        </div>

        <Button
          onClick={handleGenerate}
          disabled={isGenerating || !headline.trim() || !agentId}
          className="w-full bg-violet-600 hover:bg-violet-700"
        >
          {isGenerating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              Generate 3 Variations
            </>
          )}
        </Button>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-md p-2">{error}</p>
        )}

        {variations.length > 0 && (
          <div className="border-t pt-4 space-y-3">
            {variations.map((v, idx) => (
              <div key={v.label} className="rounded-lg border p-3 bg-muted/20 space-y-2">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-xs">
                    {v.label}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => handleCopy(idx)}
                  >
                    {v.copied ? (
                      <>
                        <CheckCheck className="mr-1 h-3 w-3 text-green-600" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="mr-1 h-3 w-3" />
                        Copy
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-sm font-semibold leading-snug">{v.headline}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">{v.body}</p>
                <p className="text-xs font-medium text-violet-700">{v.cta}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
