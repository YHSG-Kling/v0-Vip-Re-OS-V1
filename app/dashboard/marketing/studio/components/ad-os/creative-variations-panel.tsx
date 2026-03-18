"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Layers,
  Copy,
  RefreshCw,
  Sparkles,
  Loader2,
  Type,
  Target,
  MousePointer,
} from "lucide-react"
import { generateText } from "@/app/actions/content-generation-engine"

type VariationType = "headline" | "hook" | "audience" | "cta"

interface Variation {
  id: string
  text: string
  type: VariationType
}

interface CreativeVariationsPanelProps {
  agentId: string
  listingId?: string
}

const VARIATION_TYPES: Array<{
  id: VariationType
  label: string
  description: string
  icon: React.ElementType
  prompt: string
}> = [
  {
    id: "headline",
    label: "Headlines",
    description: "Attention-grabbing headlines",
    icon: Type,
    prompt: "Generate 5 different headline variations for this content. Each should take a different angle - urgency, curiosity, benefit-focused, emotional, or direct. Format as a numbered list.",
  },
  {
    id: "hook",
    label: "Hooks",
    description: "Opening hooks for videos/posts",
    icon: Sparkles,
    prompt: "Generate 5 different hook variations to open a video or social post about this content. Each should grab attention in the first 3 seconds. Format as a numbered list.",
  },
  {
    id: "audience",
    label: "Audience Angles",
    description: "Different target audience approaches",
    icon: Target,
    prompt: "Generate 5 different messaging angles targeting different audiences: first-time buyers, investors, downsizers, upsizers, and relocators. Format as a numbered list with the audience type.",
  },
  {
    id: "cta",
    label: "CTAs",
    description: "Call-to-action variations",
    icon: MousePointer,
    prompt: "Generate 5 different call-to-action variations. Include soft CTAs, urgency CTAs, curiosity CTAs, value CTAs, and direct CTAs. Format as a numbered list.",
  },
]

export function CreativeVariationsPanel({ agentId, listingId }: CreativeVariationsPanelProps) {
  const [sourceContent, setSourceContent] = useState("")
  const [activeTab, setActiveTab] = useState<VariationType>("headline")
  const [variations, setVariations] = useState<Record<VariationType, Variation[]>>({
    headline: [],
    hook: [],
    audience: [],
    cta: [],
  })
  const [isGenerating, setIsGenerating] = useState(false)
  const [generatingType, setGeneratingType] = useState<VariationType | null>(null)

  async function generateVariations(type: VariationType) {
    if (!sourceContent.trim()) return

    const typeConfig = VARIATION_TYPES.find((t) => t.id === type)
    if (!typeConfig) return

    setIsGenerating(true)
    setGeneratingType(type)

    try {
      const result = await generateText({
        agent_id: agentId,
        content_type: "ad_creative",
        channel_intent: "social",
        listing_id: listingId,
        custom_prompt: `${typeConfig.prompt}\n\nSource content:\n${sourceContent}`,
        tone: "professional",
        length: "medium",
      })

      if (result.success && result.content?.text) {
        // Parse the numbered list into individual variations
        const lines = result.content.text
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => line.replace(/^\d+\.\s*/, "").trim())
          .filter((line) => line.length > 0)

        const newVariations: Variation[] = lines.map((text, i) => ({
          id: `${type}-${i}`,
          text,
          type,
        }))

        setVariations((prev) => ({
          ...prev,
          [type]: newVariations,
        }))
      }
    } catch (error) {
      console.error("Failed to generate variations:", error)
    } finally {
      setIsGenerating(false)
      setGeneratingType(null)
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
  }

  const currentVariations = variations[activeTab]
  const activeTypeConfig = VARIATION_TYPES.find((t) => t.id === activeTab)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-violet-600" />
          Creative Variations
        </CardTitle>
        <CardDescription>
          Generate multiple variations for A/B testing
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Source Content */}
        <div className="space-y-2">
          <Label>Source Content or Topic</Label>
          <Textarea
            value={sourceContent}
            onChange={(e) => setSourceContent(e.target.value)}
            placeholder="Enter your listing details, campaign topic, or base content..."
            className="min-h-[80px]"
          />
        </div>

        {/* Variation Type Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as VariationType)}>
          <TabsList className="grid w-full grid-cols-4">
            {VARIATION_TYPES.map((type) => {
              const Icon = type.icon
              const hasVariations = variations[type.id].length > 0
              return (
                <TabsTrigger key={type.id} value={type.id} className="relative">
                  <Icon className="h-4 w-4 mr-1" />
                  <span className="hidden sm:inline">{type.label}</span>
                  {hasVariations && (
                    <Badge
                      variant="secondary"
                      className="absolute -top-1 -right-1 h-4 w-4 p-0 text-[10px] flex items-center justify-center"
                    >
                      {variations[type.id].length}
                    </Badge>
                  )}
                </TabsTrigger>
              )
            })}
          </TabsList>

          {VARIATION_TYPES.map((type) => (
            <TabsContent key={type.id} value={type.id} className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{type.label}</p>
                  <p className="text-xs text-muted-foreground">{type.description}</p>
                </div>
                <Button
                  size="sm"
                  onClick={() => generateVariations(type.id)}
                  disabled={isGenerating || !sourceContent.trim()}
                  className="bg-violet-600 hover:bg-violet-700"
                >
                  {isGenerating && generatingType === type.id ? (
                    <>
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      Generating...
                    </>
                  ) : variations[type.id].length > 0 ? (
                    <>
                      <RefreshCw className="h-3 w-3 mr-1" />
                      Regenerate
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3 w-3 mr-1" />
                      Generate
                    </>
                  )}
                </Button>
              </div>

              {/* Variations List */}
              {variations[type.id].length > 0 ? (
                <ScrollArea className="h-[200px]">
                  <div className="space-y-2">
                    {variations[type.id].map((variation, index) => (
                      <div
                        key={variation.id}
                        className="p-3 rounded-lg border bg-muted/30 hover:bg-muted/50 transition-colors group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <Badge variant="outline" className="mb-2 text-xs">
                              Variation {index + 1}
                            </Badge>
                            <p className="text-sm">{variation.text}</p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => copyToClipboard(variation.text)}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-lg">
                  <activeTypeConfig.icon className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">
                    {sourceContent.trim()
                      ? `Click Generate to create ${type.label.toLowerCase()}`
                      : "Enter source content above to generate variations"}
                  </p>
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}
