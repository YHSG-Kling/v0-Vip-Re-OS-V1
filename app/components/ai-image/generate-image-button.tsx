"use client"

/**
 * <GenerateImageButton> — drop-in for any creation surface (social posts,
 * newsletters, blog editor, ad campaigns, postcards, listing visuals).
 *
 * Usage:
 *   <GenerateImageButton
 *     purpose="social_post"
 *     defaultPrompt="A modern home with mountain views at golden hour"
 *     listingId={listing?.id}
 *     onGenerated={(url, assetId) => setHeroImage(url)}
 *   />
 *
 * Opens a dialog: prompt textarea + size/style options + Generate button.
 * On success, calls onGenerated with the permanent blob URL + asset_id.
 */

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Sparkles, Loader2, AlertCircle, RefreshCw, ImageOff } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import {
  generateMarketingImage,
} from "@/app/actions/generate-marketing-image"

type Purpose =
  | "social_post" | "ad_creative" | "blog_hero" | "newsletter_hero"
  | "postcard" | "listing_visual" | "podcast_cover" | "event_banner" | "generic"

type Size = "1024x1024" | "1792x1024" | "1024x1792"

interface Props {
  purpose: Purpose
  /** Pre-fill the prompt textarea (agent can edit) */
  defaultPrompt?: string
  /** When the image will be tied to a listing — adds property context to the prompt */
  listingId?: string
  /** Tie to an existing campaign for analytics */
  campaignId?: string
  /** Tags applied to the asset library entry */
  tags?: string[]
  /** Called after successful generation — caller usually plugs the URL into a form field */
  onGenerated: (imageUrl: string, assetId: string | undefined) => void
  /** Override the button label */
  label?: string
  /** Visual variant of the trigger button */
  variant?: "default" | "outline" | "ghost"
  /** Override default size for this purpose */
  defaultSize?: Size
  /** Optional tooltip on disabled state */
  disabled?: boolean
  /**
   * When true, the "Use name instead of logo" toggle is pre-checked.
   * Useful for surfaces that want text branding by default.
   */
  defaultNoLogo?: boolean
}

const SIZE_LABELS: Record<Size, string> = {
  "1024x1024": "Square (1:1)",
  "1792x1024": "Landscape (16:9)",
  "1024x1792": "Portrait (9:16)",
}

const DEFAULT_SIZES: Record<Purpose, Size> = {
  social_post: "1024x1024",
  ad_creative: "1024x1024",
  blog_hero: "1792x1024",
  newsletter_hero: "1792x1024",
  postcard: "1792x1024",
  listing_visual: "1792x1024",
  podcast_cover: "1024x1024",
  event_banner: "1792x1024",
  generic: "1024x1024",
}

export function GenerateImageButton(props: Props) {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState(props.defaultPrompt ?? "")
  const [size, setSize] = useState<Size>(props.defaultSize ?? DEFAULT_SIZES[props.purpose])
  const [style, setStyle] = useState<"natural" | "vivid">("natural")
  const [quality, setQuality] = useState<"standard" | "hd">("standard")
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null)
  const [generatedAssetId, setGeneratedAssetId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [noLogo, setNoLogo] = useState(props.defaultNoLogo ?? false)
  const [isPending, startTransition] = useTransition()

  function reset() {
    setPrompt(props.defaultPrompt ?? "")
    setGeneratedUrl(null)
    setGeneratedAssetId(undefined)
    setError(null)
  }

  function handleGenerate() {
    setError(null)
    if (!prompt.trim() || prompt.trim().length < 10) {
      setError("Prompt must be at least 10 characters")
      return
    }

    startTransition(async () => {
      const result = await generateMarketingImage({
        prompt: prompt.trim(),
        purpose: props.purpose,
        size,
        style,
        quality,
        listingId: props.listingId,
        campaignId: props.campaignId,
        tags: props.tags,
        noLogo,
      })
      if (result.success && result.imageUrl) {
        setGeneratedUrl(result.imageUrl)
        setGeneratedAssetId(result.assetId)
      } else {
        setError(
          result.errorCode === "no_api_key"
            ? "AI image generation isn't configured. Contact your administrator."
            : result.errorCode === "content_policy"
            ? "Prompt was blocked by the content policy. Try rephrasing."
            : result.errorCode === "rate_limit"
            ? "Rate limit hit. Wait a moment and try again."
            : result.error ?? "Generation failed"
        )
      }
    })
  }

  function handleUse() {
    if (!generatedUrl) return
    props.onGenerated(generatedUrl, generatedAssetId)
    setOpen(false)
    reset()
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={props.variant ?? "outline"}
        className="gap-1.5"
        onClick={() => { reset(); setOpen(true) }}
        disabled={props.disabled}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {props.label ?? "Generate AI Image"}
      </Button>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset() }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-purple-600" />
              Generate AI Image
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label className="text-xs">Describe the image</Label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. A modern 3-bedroom home with mountain views at golden hour, warm lighting, lifestyle photography style"
                className="mt-1 min-h-[80px]"
                disabled={isPending}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Brand color + Fair Housing compliance + no-text constraints applied automatically.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Size</Label>
                <Select value={size} onValueChange={(v) => setSize(v as Size)} disabled={isPending}>
                  <SelectTrigger className="mt-1 h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(SIZE_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Style</Label>
                <Select value={style} onValueChange={(v) => setStyle(v as any)} disabled={isPending}>
                  <SelectTrigger className="mt-1 h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="natural">Natural / photo-real</SelectItem>
                    <SelectItem value="vivid">Vivid / dramatic</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Quality</Label>
                <Select value={quality} onValueChange={(v) => setQuality(v as any)} disabled={isPending}>
                  <SelectTrigger className="mt-1 h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">Standard ($0.04)</SelectItem>
                    <SelectItem value="hd">HD ($0.08)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Logo / name toggle */}
            <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <ImageOff className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">Use name text instead of logo</span>
              </div>
              <Switch
                checked={noLogo}
                onCheckedChange={setNoLogo}
                disabled={isPending}
              />
            </div>

            {/* Result preview */}
            {generatedUrl && (
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs font-medium">Generated image</p>
                <img
                  src={generatedUrl}
                  alt="Generated"
                  className="w-full max-h-72 object-contain rounded border bg-muted"
                />
                <p className="text-[11px] text-muted-foreground">
                  Saved to your asset library. Use it now or regenerate for a different take.
                </p>
              </div>
            )}

            {error && (
              <p className="text-xs text-red-600 flex items-start gap-1">
                <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                {error}
              </p>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => { setOpen(false); reset() }}>
              Close
            </Button>
            {generatedUrl ? (
              <>
                <Button variant="outline" onClick={handleGenerate} disabled={isPending} className="gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5" />
                  Regenerate
                </Button>
                <Button onClick={handleUse} className="gap-1.5">
                  Use this image
                </Button>
              </>
            ) : (
              <Button onClick={handleGenerate} disabled={isPending || !prompt.trim()} className="gap-1.5">
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {isPending ? "Generating…" : "Generate"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
