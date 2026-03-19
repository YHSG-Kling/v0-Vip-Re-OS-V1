"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Repeat,
  Copy,
  MessageSquare,
  Mail,
  FileText,
  Video,
  Sparkles,
  Loader2,
  CheckCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import { generateText } from "@/app/actions/content-generation-engine"

type RepurposeFormat =
  | "ad_copy"
  | "social_post"
  | "reel_hook"
  | "email_copy"
  | "seller_update"
  | "direct_mail"
  | "landing_page"

interface RepurposeOutput {
  format: RepurposeFormat
  content: string
  generated: boolean
}

interface RepurposeEnginePanelProps {
  agentId: string
  listingId?: string
}

const REPURPOSE_FORMATS: Array<{
  id: RepurposeFormat
  label: string
  description: string
  icon: React.ElementType
  contentType: string
  channelIntent: string
}> = [
  {
    id: "ad_copy",
    label: "Ad Copy",
    description: "Facebook/Instagram ad text",
    icon: MessageSquare,
    contentType: "ad_creative",
    channelIntent: "social",
  },
  {
    id: "social_post",
    label: "Social Posts",
    description: "Engaging social media content",
    icon: MessageSquare,
    contentType: "social_post",
    channelIntent: "social",
  },
  {
    id: "reel_hook",
    label: "Reel Hooks",
    description: "Short-form video hooks",
    icon: Video,
    contentType: "video_script",
    channelIntent: "social",
  },
  {
    id: "email_copy",
    label: "Email Copy",
    description: "Newsletter/drip content",
    icon: Mail,
    contentType: "email",
    channelIntent: "email",
  },
  {
    id: "seller_update",
    label: "Seller Update",
    description: "Client communication snippet",
    icon: Mail,
    contentType: "email",
    channelIntent: "email",
  },
  {
    id: "direct_mail",
    label: "Direct Mail",
    description: "Postcard headline/body",
    icon: FileText,
    contentType: "ad_creative",
    channelIntent: "print",
  },
  {
    id: "landing_page",
    label: "Landing Page",
    description: "Lead capture page copy",
    icon: FileText,
    contentType: "ad_creative",
    channelIntent: "web",
  },
]

export function RepurposeEnginePanel({ agentId, listingId }: RepurposeEnginePanelProps) {
  const [sourceContent, setSourceContent] = useState("")
  const [selectedFormats, setSelectedFormats] = useState<Set<RepurposeFormat>>(new Set())
  const [outputs, setOutputs] = useState<RepurposeOutput[]>([])
  const [isGenerating, setIsGenerating] = useState(false)
  const [expandedOutput, setExpandedOutput] = useState<RepurposeFormat | null>(null)

  function toggleFormat(format: RepurposeFormat) {
    const newSelected = new Set(selectedFormats)
    if (newSelected.has(format)) {
      newSelected.delete(format)
    } else {
      newSelected.add(format)
    }
    setSelectedFormats(newSelected)
  }

  async function handleRepurpose() {
    if (!sourceContent.trim() || selectedFormats.size === 0) return

    setIsGenerating(true)
    setOutputs([])

    try {
      const results: RepurposeOutput[] = []

      for (const formatId of selectedFormats) {
        const formatConfig = REPURPOSE_FORMATS.find((f) => f.id === formatId)
        if (!formatConfig) continue

        try {
          const result = await generateText({
            agent_id: agentId,
            content_type: formatConfig.contentType as any,
            channel_intent: formatConfig.channelIntent as any,
            listing_id: listingId,
            custom_prompt: `Repurpose the following content into ${formatConfig.label} format. Keep the core message but optimize for ${formatConfig.description}.\n\nOriginal content:\n${sourceContent}`,
            tone: "professional",
            length: formatId === "reel_hook" ? "short" : "medium",
          })

          results.push({
            format: formatId,
            content: result.success && result.content?.text ? result.content.text : "Generation failed",
            generated: result.success || false,
          })
        } catch (error) {
          results.push({
            format: formatId,
            content: "Failed to generate content",
            generated: false,
          })
        }

        // Update outputs as we go
        setOutputs([...results])
      }
    } catch (error) {
      console.error("Repurpose failed:", error)
    } finally {
      setIsGenerating(false)
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Repeat className="h-5 w-5 text-violet-600" />
          Repurpose Engine
        </CardTitle>
        <CardDescription>
          Transform one piece of content into multiple formats
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Source Content */}
        <div className="space-y-2">
          <Label>Source Content</Label>
          <Textarea
            value={sourceContent}
            onChange={(e) => setSourceContent(e.target.value)}
            placeholder="Paste your listing description, blog post, or any content to repurpose..."
            className="min-h-[120px]"
          />
        </div>

        {/* Format Selection */}
        <div className="space-y-2">
          <Label>Output Formats</Label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {REPURPOSE_FORMATS.map((format) => {
              const Icon = format.icon
              const isSelected = selectedFormats.has(format.id)
              return (
                <button
                  key={format.id}
                  onClick={() => toggleFormat(format.id)}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    isSelected
                      ? "border-violet-600 bg-violet-50 dark:bg-violet-950/30"
                      : "border-border hover:border-violet-300"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Checkbox checked={isSelected} className="pointer-events-none" />
                    <Icon className={`h-4 w-4 ${isSelected ? "text-violet-600" : "text-muted-foreground"}`} />
                  </div>
                  <p className="font-medium text-xs mt-2">{format.label}</p>
                </button>
              )
            })}
          </div>
        </div>

        {/* Generate Button */}
        <Button
          onClick={handleRepurpose}
          disabled={isGenerating || !sourceContent.trim() || selectedFormats.size === 0}
          className="w-full bg-violet-600 hover:bg-violet-700"
        >
          {isGenerating ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Generating {outputs.length}/{selectedFormats.size}...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4 mr-2" />
              Repurpose Content ({selectedFormats.size} formats)
            </>
          )}
        </Button>

        {/* Generated Outputs */}
        {outputs.length > 0 && (
          <ScrollArea className="h-[300px]">
            <div className="space-y-3">
              {outputs.map((output) => {
                const formatConfig = REPURPOSE_FORMATS.find((f) => f.id === output.format)
                const Icon = formatConfig?.icon || FileText
                const isExpanded = expandedOutput === output.format

                return (
                  <div key={output.format} className="border rounded-lg overflow-hidden">
                    <button
                      onClick={() => setExpandedOutput(isExpanded ? null : output.format)}
                      className="w-full p-3 flex items-center justify-between bg-muted/30 hover:bg-muted/50"
                    >
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-violet-600" />
                        <span className="font-medium text-sm">{formatConfig?.label}</span>
                        {output.generated && (
                          <CheckCircle className="h-4 w-4 text-green-600" />
                        )}
                      </div>
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </button>
                    {isExpanded && (
                      <div className="p-3 border-t">
                        <p className="text-sm whitespace-pre-wrap">{output.content}</p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() => copyToClipboard(output.content)}
                        >
                          <Copy className="h-3 w-3 mr-1" />
                          Copy
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
