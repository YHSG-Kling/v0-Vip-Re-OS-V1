"use client"

import { useState, useCallback } from "react"
import {
  Scissors,
  Play,
  Pause,
  Instagram,
  Youtube,
  Linkedin,
  Twitter,
  Music2,
  Facebook,
  Sparkles,
  Clock,
  Hash,
  FileText,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  generateSnippetSuggestions,
  batchCreateSnippets,
  type PlatformTarget,
  getPlatformConfig,
} from "@/app/actions/video-repurposing"

interface SnippetGeneratorProps {
  videoProjectId?: string
  sourceVideoAssetId?: string
  brokerageId: string
  videoDuration?: number
  videoTitle?: string
  userId?: string
  onSnippetsCreated?: (snippets: any[]) => void
}

const PLATFORMS: { id: PlatformTarget; icon: React.ReactNode; label: string; color: string }[] = [
  { id: "instagram_reels", icon: <Instagram className="h-4 w-4" />, label: "Reels", color: "bg-gradient-to-tr from-purple-500 to-pink-500" },
  { id: "instagram_story", icon: <Instagram className="h-4 w-4" />, label: "Stories", color: "bg-gradient-to-tr from-yellow-500 to-pink-500" },
  { id: "tiktok", icon: <Music2 className="h-4 w-4" />, label: "TikTok", color: "bg-black" },
  { id: "youtube_shorts", icon: <Youtube className="h-4 w-4" />, label: "Shorts", color: "bg-red-600" },
  { id: "facebook_reels", icon: <Facebook className="h-4 w-4" />, label: "FB Reels", color: "bg-blue-600" },
  { id: "linkedin", icon: <Linkedin className="h-4 w-4" />, label: "LinkedIn", color: "bg-blue-700" },
  { id: "twitter", icon: <Twitter className="h-4 w-4" />, label: "X/Twitter", color: "bg-sky-500" },
]

export function SnippetGenerator({
  videoProjectId,
  sourceVideoAssetId,
  brokerageId,
  videoDuration = 90,
  videoTitle = "Video",
  userId,
  onSnippetsCreated,
}: SnippetGeneratorProps) {
  const [selectedPlatforms, setSelectedPlatforms] = useState<PlatformTarget[]>(["instagram_reels", "tiktok"])
  const [isGenerating, setIsGenerating] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [suggestions, setSuggestions] = useState<Array<{
    platform: PlatformTarget
    title: string
    startSeconds: number
    endSeconds: number
    captionText: string
    hashtags: string[]
    rationale: string
  }>>([])
  const [editedSuggestions, setEditedSuggestions] = useState<Record<PlatformTarget, {
    title: string
    startSeconds: number
    endSeconds: number
    captionText: string
    hashtags: string[]
    selected: boolean
  }>>({} as any)
  const [expandedPlatforms, setExpandedPlatforms] = useState<Set<PlatformTarget>>(new Set())

  const togglePlatform = (platform: PlatformTarget) => {
    setSelectedPlatforms(prev =>
      prev.includes(platform)
        ? prev.filter(p => p !== platform)
        : [...prev, platform]
    )
  }

  const handleGenerateSuggestions = async () => {
    if (selectedPlatforms.length === 0) return

    setIsGenerating(true)
    try {
      const results = await generateSnippetSuggestions({
        videoProjectId,
        sourceVideoAssetId,
        brokerageId,
        platforms: selectedPlatforms,
      })
      
      setSuggestions(results)
      
      // Initialize edited suggestions
      const edited: Record<PlatformTarget, any> = {} as any
      results.forEach(s => {
        edited[s.platform] = {
          ...s,
          selected: true,
        }
      })
      setEditedSuggestions(edited)
      
      // Expand all platforms
      setExpandedPlatforms(new Set(results.map(s => s.platform)))
    } catch (error) {
      console.error("[v0] Failed to generate suggestions:", error)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCreateSnippets = async () => {
    const snippetsToCreate = Object.entries(editedSuggestions)
      .filter(([_, value]) => value.selected)
      .map(([platform, value]) => ({
        platform: platform as PlatformTarget,
        title: value.title,
        startSeconds: value.startSeconds,
        endSeconds: value.endSeconds,
        captionText: value.captionText,
        hashtags: value.hashtags,
      }))

    if (snippetsToCreate.length === 0) return

    setIsCreating(true)
    try {
      const created = await batchCreateSnippets({
        brokerageId,
        videoProjectId,
        sourceVideoAssetId,
        snippets: snippetsToCreate,
        createdBy: userId,
      })
      
      onSnippetsCreated?.(created)
      setSuggestions([])
      setEditedSuggestions({} as any)
    } catch (error) {
      console.error("[v0] Failed to create snippets:", error)
    } finally {
      setIsCreating(false)
    }
  }

  const updateSuggestion = (platform: PlatformTarget, updates: Partial<typeof editedSuggestions[PlatformTarget]>) => {
    setEditedSuggestions(prev => ({
      ...prev,
      [platform]: {
        ...prev[platform],
        ...updates,
      },
    }))
  }

  const toggleExpanded = (platform: PlatformTarget) => {
    setExpandedPlatforms(prev => {
      const next = new Set(prev)
      if (next.has(platform)) {
        next.delete(platform)
      } else {
        next.add(platform)
      }
      return next
    })
  }

  const selectedCount = Object.values(editedSuggestions).filter(s => s.selected).length

  return (
    <Card className="border-2">
      <CardHeader className="bg-muted/30">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Scissors className="h-5 w-5 text-primary" />
              Snippet Generator
            </CardTitle>
            <CardDescription>
              Create platform-optimized clips from "{videoTitle}"
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-base px-3 py-1">
            <Clock className="h-4 w-4 mr-1" />
            {videoDuration}s
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-6 space-y-6">
        {/* Platform Selection */}
        <div className="space-y-3">
          <Label className="text-sm font-medium">Select Target Platforms</Label>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map(platform => (
              <Button
                key={platform.id}
                variant={selectedPlatforms.includes(platform.id) ? "default" : "outline"}
                size="sm"
                onClick={() => togglePlatform(platform.id)}
                className={`gap-2 ${selectedPlatforms.includes(platform.id) ? platform.color + " text-white border-0" : ""}`}
              >
                {platform.icon}
                {platform.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Selected: {selectedPlatforms.length} platforms
          </p>
        </div>

        {/* Generate Button */}
        {suggestions.length === 0 && (
          <Button
            onClick={handleGenerateSuggestions}
            disabled={selectedPlatforms.length === 0 || isGenerating}
            className="w-full gap-2"
            size="lg"
          >
            {isGenerating ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Analyzing Video & Generating Suggestions...
              </>
            ) : (
              <>
                <Sparkles className="h-5 w-5" />
                Generate AI Snippet Suggestions
              </>
            )}
          </Button>
        )}

        {/* Suggestions Editor */}
        {suggestions.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">AI Suggestions</h3>
              <Badge variant="secondary">
                {selectedCount} of {suggestions.length} selected
              </Badge>
            </div>

            <div className="space-y-3">
              {suggestions.map(suggestion => {
                const edited = editedSuggestions[suggestion.platform]
                const config = getPlatformConfig(suggestion.platform)
                const platformInfo = PLATFORMS.find(p => p.id === suggestion.platform)
                const isExpanded = expandedPlatforms.has(suggestion.platform)
                const duration = edited?.endSeconds - edited?.startSeconds

                return (
                  <Collapsible
                    key={suggestion.platform}
                    open={isExpanded}
                    onOpenChange={() => toggleExpanded(suggestion.platform)}
                  >
                    <Card className={`border-2 transition-all ${edited?.selected ? "border-primary/50" : "border-muted opacity-60"}`}>
                      <CollapsibleTrigger asChild>
                        <div className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/30 transition-colors">
                          <div className="flex items-center gap-3">
                            <Checkbox
                              checked={edited?.selected}
                              onCheckedChange={(checked) => {
                                updateSuggestion(suggestion.platform, { selected: !!checked })
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <div className={`p-2 rounded-lg ${platformInfo?.color} text-white`}>
                              {platformInfo?.icon}
                            </div>
                            <div>
                              <p className="font-medium">{config.displayName}</p>
                              <p className="text-sm text-muted-foreground">
                                {duration}s clip · {edited?.hashtags?.length || 0} hashtags
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {duration > config.maxDuration ? (
                              <Badge variant="destructive" className="gap-1">
                                <AlertCircle className="h-3 w-3" />
                                Too long
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="gap-1 text-green-600 border-green-600">
                                <CheckCircle2 className="h-3 w-3" />
                                Valid
                              </Badge>
                            )}
                            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </div>
                        </div>
                      </CollapsibleTrigger>
                      
                      <CollapsibleContent>
                        <CardContent className="pt-0 pb-4 space-y-4 border-t">
                          {/* AI Rationale */}
                          <div className="bg-muted/50 p-3 rounded-lg text-sm mt-4">
                            <p className="text-muted-foreground">
                              <Sparkles className="h-4 w-4 inline mr-1 text-primary" />
                              <strong>AI Insight:</strong> {suggestion.rationale}
                            </p>
                          </div>

                          {/* Title */}
                          <div className="space-y-2">
                            <Label>Snippet Title</Label>
                            <Input
                              value={edited?.title || ""}
                              onChange={(e) => updateSuggestion(suggestion.platform, { title: e.target.value })}
                              placeholder="Enter snippet title"
                            />
                          </div>

                          {/* Time Range */}
                          <div className="space-y-3">
                            <Label>Time Range ({duration}s / max {config.maxDuration}s)</Label>
                            <div className="grid grid-cols-2 gap-4">
                              <div className="space-y-1">
                                <span className="text-xs text-muted-foreground">Start</span>
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="number"
                                    min={0}
                                    max={videoDuration}
                                    value={edited?.startSeconds || 0}
                                    onChange={(e) => updateSuggestion(suggestion.platform, { startSeconds: parseInt(e.target.value) || 0 })}
                                    className="w-20"
                                  />
                                  <span className="text-sm text-muted-foreground">seconds</span>
                                </div>
                              </div>
                              <div className="space-y-1">
                                <span className="text-xs text-muted-foreground">End</span>
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="number"
                                    min={0}
                                    max={videoDuration}
                                    value={edited?.endSeconds || 0}
                                    onChange={(e) => updateSuggestion(suggestion.platform, { endSeconds: parseInt(e.target.value) || 0 })}
                                    className="w-20"
                                  />
                                  <span className="text-sm text-muted-foreground">seconds</span>
                                </div>
                              </div>
                            </div>
                            <Slider
                              value={[edited?.startSeconds || 0, edited?.endSeconds || 30]}
                              onValueChange={([start, end]) => updateSuggestion(suggestion.platform, { startSeconds: start, endSeconds: end })}
                              max={videoDuration}
                              step={1}
                              className="mt-2"
                            />
                          </div>

                          {/* Caption */}
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <Label className="flex items-center gap-1">
                                <FileText className="h-4 w-4" />
                                Caption
                              </Label>
                              <span className="text-xs text-muted-foreground">
                                {edited?.captionText?.length || 0} / {config.maxCaptionLength}
                              </span>
                            </div>
                            <Textarea
                              value={edited?.captionText || ""}
                              onChange={(e) => updateSuggestion(suggestion.platform, { captionText: e.target.value.substring(0, config.maxCaptionLength) })}
                              placeholder="Enter caption..."
                              rows={3}
                            />
                          </div>

                          {/* Hashtags */}
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <Label className="flex items-center gap-1">
                                <Hash className="h-4 w-4" />
                                Hashtags
                              </Label>
                              <span className="text-xs text-muted-foreground">
                                {edited?.hashtags?.length || 0} / {config.hashtagLimit}
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {edited?.hashtags?.map((tag, i) => (
                                <Badge
                                  key={i}
                                  variant="secondary"
                                  className="cursor-pointer hover:bg-destructive hover:text-destructive-foreground"
                                  onClick={() => {
                                    const newTags = [...(edited?.hashtags || [])]
                                    newTags.splice(i, 1)
                                    updateSuggestion(suggestion.platform, { hashtags: newTags })
                                  }}
                                >
                                  #{tag} ×
                                </Badge>
                              ))}
                              <Input
                                placeholder="Add hashtag"
                                className="w-32 h-6 text-xs"
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && e.currentTarget.value) {
                                    const newTag = e.currentTarget.value.replace(/^#/, "")
                                    if (newTag && (edited?.hashtags?.length || 0) < config.hashtagLimit) {
                                      updateSuggestion(suggestion.platform, {
                                        hashtags: [...(edited?.hashtags || []), newTag]
                                      })
                                      e.currentTarget.value = ""
                                    }
                                    e.preventDefault()
                                  }
                                }}
                              />
                            </div>
                          </div>
                        </CardContent>
                      </CollapsibleContent>
                    </Card>
                  </Collapsible>
                )
              })}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-4">
              <Button
                variant="outline"
                onClick={() => {
                  setSuggestions([])
                  setEditedSuggestions({} as any)
                }}
                className="flex-1"
              >
                Start Over
              </Button>
              <Button
                onClick={handleCreateSnippets}
                disabled={selectedCount === 0 || isCreating}
                className="flex-1 gap-2"
              >
                {isCreating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Create {selectedCount} Snippet{selectedCount !== 1 ? "s" : ""}
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
