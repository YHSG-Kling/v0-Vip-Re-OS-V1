"use client"

/**
 * BrollPicker — three card grids for picking intro / outro / b-roll clips
 * from the brokerage's stock video library (video_assets table). Lets a
 * non-technical agent assemble a polished, branded explainer in seconds
 * by just clicking cards. The poll cron does the actual stitching.
 *
 * UX goals (the whole product pitch):
 *   - Zero editing knowledge required.
 *   - "Let AI pick for me" auto-selects sensible defaults per video type.
 *   - "Skip" is one click — no bookends is a valid, common choice.
 *   - Preview on hover with the silent video poster, full audio on click.
 *   - Currently-selected clip gets a prominent ring + checkmark.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Check, Sparkles, X, Play, Film, ArrowRight, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

export interface BrollSelection {
  introVideoUrl:  string | null
  outroVideoUrl:  string | null
  bRollUrls:      string[]
}

interface StockClip {
  id:               string
  title:            string
  video_url:        string
  thumbnail_url:    string | null
  category:         string | null
  duration_seconds: number | null
  tags:             string[] | null
}

interface Props {
  brokerageId: string
  /** Auto-pick defaults appropriate to the agent's chosen video type */
  videoType?:  string | null
  value:       BrollSelection
  onChange:    (next: BrollSelection) => void
}

// Categories the brokerage uploads to. Surfaced in tabs.
const CATEGORIES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "intro",    label: "Intro" },
  { key: "outro",    label: "Outro" },
  { key: "b_roll",   label: "B-roll" },
]

/**
 * The kernel default "AI pick" rules per video type — picks an intro +
 * outro that fit the content. Keys match the existing video_type values
 * in ai_video_projects. Real selection logic lives client-side so the
 * agent can override before submission.
 */
const AI_DEFAULTS_BY_TYPE: Record<string, { introTag?: string; outroTag?: string }> = {
  listing_promo:      { introTag: "drone", outroTag: "logo_sting" },
  neighborhood_tour:  { introTag: "neighborhood", outroTag: "logo_sting" },
  market_update:      { introTag: "data", outroTag: "logo_sting" },
  agent_introduction: { introTag: "headshot_sting", outroTag: "logo_sting" },
  thank_you:          { outroTag: "logo_sting" },
  buyer_guide:        { introTag: "education", outroTag: "logo_sting" },
}

export function BrollPicker({ brokerageId, videoType, value, onChange }: Props) {
  const [clips, setClips] = useState<Record<string, StockClip[]>>({ intro: [], outro: [], b_roll: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const previewRef = useRef<HTMLVideoElement | null>(null)

  // Load the brokerage's stock library on mount
  useEffect(() => {
    let cancelled = false
    const supabase = createClient()
    ;(async () => {
      setLoading(true)
      const { data, error } = await supabase
        .from("video_assets")
        .select("id, title, video_url, thumbnail_url, category, duration_seconds, tags")
        .eq("brokerage_id", brokerageId)
        .in("category", ["intro", "outro", "b_roll"])
        .order("created_at", { ascending: false })
        .limit(120)
      if (cancelled) return
      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }
      const grouped: Record<string, StockClip[]> = { intro: [], outro: [], b_roll: [] }
      for (const c of (data ?? []) as StockClip[]) {
        const k = c.category ?? "b_roll"
        if (grouped[k]) grouped[k].push(c)
      }
      setClips(grouped)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [brokerageId])

  // ── Selection helpers ─────────────────────────────────────────────────────
  function selectIntro(url: string | null) {
    onChange({ ...value, introVideoUrl: url })
  }
  function selectOutro(url: string | null) {
    onChange({ ...value, outroVideoUrl: url })
  }
  function toggleBRoll(url: string) {
    const isPicked = value.bRollUrls.includes(url)
    onChange({
      ...value,
      bRollUrls: isPicked
        ? value.bRollUrls.filter(u => u !== url)
        : [...value.bRollUrls, url],
    })
  }

  // "AI pick for me" — choose an intro and outro that match the video type
  function aiPickDefaults() {
    const defaults = videoType ? AI_DEFAULTS_BY_TYPE[videoType] : undefined
    if (!defaults) return
    const next: BrollSelection = { ...value }
    if (defaults.introTag) {
      const match = clips.intro.find(c => (c.tags ?? []).some(t => t.toLowerCase().includes(defaults.introTag!)))
      if (match) next.introVideoUrl = match.video_url
    }
    if (defaults.outroTag) {
      const match = clips.outro.find(c => (c.tags ?? []).some(t => t.toLowerCase().includes(defaults.outroTag!)))
      if (match) next.outroVideoUrl = match.video_url
    }
    onChange(next)
  }

  const total = clips.intro.length + clips.outro.length + clips.b_roll.length
  const selectedCount =
    (value.introVideoUrl ? 1 : 0) +
    (value.outroVideoUrl ? 1 : 0) +
    value.bRollUrls.length

  // ── Empty-state copy: zero clips in the library ──────────────────────────
  if (!loading && total === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-10 text-center space-y-3">
          <Film className="h-10 w-10 text-muted-foreground mx-auto" />
          <div>
            <p className="text-sm font-medium">Your stock video library is empty.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Ask your brokerage admin to upload a few intro stings, outros, and b-roll clips to
              the Video Library. Once they're there, every agent can pick from them with one
              click — no editing required.
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <a href="/dashboard/videos/library">Open Video Library <ArrowRight className="h-3 w-3 ml-1" /></a>
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Film className="h-4 w-4 text-indigo-600" />
            Cinematic touches
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Optional — add a brokerage-approved intro, outro, or b-roll. Skip if you want
            just the talking head.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">{selectedCount} picked</Badge>
          {videoType && AI_DEFAULTS_BY_TYPE[videoType] && (
            <Button size="sm" variant="outline" onClick={aiPickDefaults}>
              <Sparkles className="h-3 w-3 mr-1" /> AI pick for me
            </Button>
          )}
        </div>
      </div>

      <Tabs defaultValue="intro">
        <TabsList>
          {CATEGORIES.map(c => (
            <TabsTrigger key={c.key} value={c.key} className="gap-1">
              {c.label}
              <span className="text-[10px] text-muted-foreground">({clips[c.key].length})</span>
            </TabsTrigger>
          ))}
        </TabsList>

        {CATEGORIES.map(c => (
          <TabsContent key={c.key} value={c.key} className="mt-3">
            {loading ? (
              <div className="py-10 flex items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Loading library…
              </div>
            ) : (
              <CategoryGrid
                category={c.key}
                clips={clips[c.key]}
                value={value}
                onPickIntro={selectIntro}
                onPickOutro={selectOutro}
                onToggleBRoll={toggleBRoll}
                previewing={previewing}
                setPreviewing={setPreviewing}
                previewRef={previewRef}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>

      {error && (
        <p className="text-xs text-destructive">Couldn't load library: {error}</p>
      )}
    </div>
  )
}

interface GridProps {
  category:      string
  clips:         StockClip[]
  value:         BrollSelection
  onPickIntro:   (url: string | null) => void
  onPickOutro:   (url: string | null) => void
  onToggleBRoll: (url: string) => void
  previewing:    string | null
  setPreviewing: (id: string | null) => void
  previewRef:    React.MutableRefObject<HTMLVideoElement | null>
}

function CategoryGrid(props: GridProps) {
  const { category, clips, value, onPickIntro, onPickOutro, onToggleBRoll, previewing, setPreviewing, previewRef } = props

  if (clips.length === 0) {
    return (
      <div className="py-10 text-center text-xs text-muted-foreground border border-dashed rounded-lg">
        No {category === "b_roll" ? "b-roll" : category} clips in the library yet.
      </div>
    )
  }

  // Helper: is this clip selected for its category?
  const isSelected = (clip: StockClip): boolean => {
    if (category === "intro")  return value.introVideoUrl === clip.video_url
    if (category === "outro")  return value.outroVideoUrl === clip.video_url
    return value.bRollUrls.includes(clip.video_url)
  }

  return (
    <>
      {/* "None" tile only for intro / outro — b-roll allows multi-select including none */}
      {category !== "b_roll" && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => category === "intro" ? onPickIntro(null) : onPickOutro(null)}
            className={cn(
              "inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-md border transition-colors",
              ((category === "intro" && !value.introVideoUrl) || (category === "outro" && !value.outroVideoUrl))
                ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                : "border-muted text-muted-foreground hover:bg-muted/40"
            )}
          >
            <X className="h-3 w-3" /> No {category}
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {clips.map(clip => {
          const selected = isSelected(clip)
          return (
            <Card
              key={clip.id}
              className={cn(
                "overflow-hidden cursor-pointer transition-all relative",
                selected ? "ring-2 ring-indigo-500" : "hover:ring-1 hover:ring-muted-foreground/30"
              )}
              onClick={() => {
                if (category === "intro")  return onPickIntro(clip.video_url)
                if (category === "outro")  return onPickOutro(clip.video_url)
                return onToggleBRoll(clip.video_url)
              }}
            >
              <div className="aspect-video bg-black relative">
                {previewing === clip.id ? (
                  <video
                    ref={previewRef}
                    src={clip.video_url}
                    autoPlay
                    muted
                    loop
                    playsInline
                    className="w-full h-full object-cover"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={clip.thumbnail_url ?? ""}
                    alt={clip.title}
                    className="w-full h-full object-cover bg-muted"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none" }}
                  />
                )}
                {selected && (
                  <div className="absolute top-2 right-2 bg-indigo-500 rounded-full p-1">
                    <Check className="h-3 w-3 text-white" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setPreviewing(previewing === clip.id ? null : clip.id)
                  }}
                  className="absolute bottom-2 left-2 bg-black/60 rounded-full p-1 hover:bg-black/80"
                  aria-label="Preview"
                >
                  <Play className="h-3 w-3 text-white" />
                </button>
              </div>
              <CardContent className="py-2 px-3">
                <p className="text-xs font-medium truncate">{clip.title}</p>
                {clip.duration_seconds != null && (
                  <p className="text-[10px] text-muted-foreground">{clip.duration_seconds}s</p>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </>
  )
}
