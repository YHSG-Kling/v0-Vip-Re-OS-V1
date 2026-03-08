"use client"

import { useState } from "react"
import {
  Scissors,
  Instagram,
  Youtube,
  Facebook,
  Linkedin,
  Twitter,
  Music2,
  Loader2,
  Sparkles,
  CheckCircle2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  generateSnippetSuggestions,
  batchCreateSnippets,
  type PlatformTarget,
} from "@/app/actions/video-repurposing"

interface QuickRepurposeButtonProps {
  videoProjectId?: string
  sourceVideoAssetId?: string
  brokerageId: string
  videoTitle?: string
  userId?: string
  variant?: "default" | "outline" | "secondary" | "ghost"
  size?: "default" | "sm" | "lg" | "icon"
  className?: string
}

const PLATFORMS: { id: PlatformTarget; icon: React.ReactNode; label: string; shortLabel: string }[] = [
  { id: "instagram_reels", icon: <Instagram className="h-4 w-4" />, label: "Instagram Reels", shortLabel: "Reels" },
  { id: "instagram_story", icon: <Instagram className="h-4 w-4" />, label: "Instagram Stories", shortLabel: "Stories" },
  { id: "tiktok", icon: <Music2 className="h-4 w-4" />, label: "TikTok", shortLabel: "TikTok" },
  { id: "youtube_shorts", icon: <Youtube className="h-4 w-4" />, label: "YouTube Shorts", shortLabel: "Shorts" },
  { id: "facebook_reels", icon: <Facebook className="h-4 w-4" />, label: "Facebook Reels", shortLabel: "FB Reels" },
  { id: "linkedin", icon: <Linkedin className="h-4 w-4" />, label: "LinkedIn Video", shortLabel: "LinkedIn" },
  { id: "twitter", icon: <Twitter className="h-4 w-4" />, label: "Twitter/X Video", shortLabel: "X/Twitter" },
]

export function QuickRepurposeButton({
  videoProjectId,
  sourceVideoAssetId,
  brokerageId,
  videoTitle = "Video",
  userId,
  variant = "outline",
  size = "default",
  className,
}: QuickRepurposeButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedPlatforms, setSelectedPlatforms] = useState<PlatformTarget[]>(["instagram_reels", "tiktok", "youtube_shorts"])
  const [isGenerating, setIsGenerating] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [suggestions, setSuggestions] = useState<any[]>([])
  const [step, setStep] = useState<"select" | "review" | "done">("select")

  const togglePlatform = (platform: PlatformTarget) => {
    setSelectedPlatforms(prev =>
      prev.includes(platform)
        ? prev.filter(p => p !== platform)
        : [...prev, platform]
    )
  }

  const handleGenerate = async () => {
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
      setStep("review")
    } catch (error) {
      console.error("[v0] Failed to generate suggestions:", error)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCreate = async () => {
    if (suggestions.length === 0) return

    setIsCreating(true)
    try {
      await batchCreateSnippets({
        brokerageId,
        videoProjectId,
        sourceVideoAssetId,
        snippets: suggestions.map(s => ({
          platform: s.platform,
          title: s.title,
          startSeconds: s.startSeconds,
          endSeconds: s.endSeconds,
          captionText: s.captionText,
          hashtags: s.hashtags,
        })),
        createdBy: userId,
      })
      setStep("done")
    } catch (error) {
      console.error("[v0] Failed to create snippets:", error)
    } finally {
      setIsCreating(false)
    }
  }

  const resetAndClose = () => {
    setDialogOpen(false)
    setTimeout(() => {
      setStep("select")
      setSuggestions([])
      setSelectedPlatforms(["instagram_reels", "tiktok", "youtube_shorts"])
    }, 200)
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => setDialogOpen(true)}
      >
        <Scissors className="h-4 w-4 mr-2" />
        Quick Repurpose
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          {step === "select" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-primary" />
                  Quick Repurpose
                </DialogTitle>
                <DialogDescription>
                  Select platforms to create optimized snippets from "{videoTitle}"
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="grid grid-cols-2 gap-3">
                  {PLATFORMS.map(platform => (
                    <Label
                      key={platform.id}
                      className={`flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                        selectedPlatforms.includes(platform.id)
                          ? "border-primary bg-primary/5"
                          : "border-muted hover:border-muted-foreground/50"
                      }`}
                    >
                      <Checkbox
                        checked={selectedPlatforms.includes(platform.id)}
                        onCheckedChange={() => togglePlatform(platform.id)}
                      />
                      {platform.icon}
                      <span className="text-sm font-medium">{platform.shortLabel}</span>
                    </Label>
                  ))}
                </div>

                <p className="text-sm text-muted-foreground text-center">
                  {selectedPlatforms.length} platform{selectedPlatforms.length !== 1 ? "s" : ""} selected
                </p>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={resetAndClose}>
                  Cancel
                </Button>
                <Button
                  onClick={handleGenerate}
                  disabled={selectedPlatforms.length === 0 || isGenerating}
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4 mr-2" />
                      Generate Snippets
                    </>
                  )}
                </Button>
              </DialogFooter>
            </>
          )}

          {step === "review" && (
            <>
              <DialogHeader>
                <DialogTitle>Review AI Suggestions</DialogTitle>
                <DialogDescription>
                  {suggestions.length} snippets ready to create
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 py-4 max-h-[300px] overflow-y-auto">
                {suggestions.map((suggestion, i) => {
                  const platform = PLATFORMS.find(p => p.id === suggestion.platform)
                  return (
                    <div key={i} className="p-3 bg-muted/50 rounded-lg space-y-2">
                      <div className="flex items-center gap-2">
                        {platform?.icon}
                        <span className="font-medium text-sm">{platform?.label}</span>
                        <Badge variant="outline" className="ml-auto text-xs">
                          {suggestion.endSeconds - suggestion.startSeconds}s
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {suggestion.captionText}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {suggestion.hashtags?.slice(0, 3).map((tag: string, j: number) => (
                          <Badge key={j} variant="secondary" className="text-xs">
                            #{tag}
                          </Badge>
                        ))}
                        {suggestion.hashtags?.length > 3 && (
                          <Badge variant="secondary" className="text-xs">
                            +{suggestion.hashtags.length - 3}
                          </Badge>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setStep("select")}>
                  Back
                </Button>
                <Button onClick={handleCreate} disabled={isCreating}>
                  {isCreating ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Create {suggestions.length} Snippets
                    </>
                  )}
                </Button>
              </DialogFooter>
            </>
          )}

          {step === "done" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-green-600">
                  <CheckCircle2 className="h-5 w-5" />
                  Snippets Created!
                </DialogTitle>
                <DialogDescription>
                  {suggestions.length} snippets have been created and are pending review
                </DialogDescription>
              </DialogHeader>

              <div className="py-8 text-center">
                <div className="bg-green-500/10 rounded-full p-4 w-fit mx-auto mb-4">
                  <CheckCircle2 className="h-12 w-12 text-green-500" />
                </div>
                <p className="text-muted-foreground">
                  Your snippets are ready for review in the Snippets Library
                </p>
              </div>

              <DialogFooter className="sm:justify-center">
                <Button onClick={resetAndClose}>
                  Done
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
