"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Hash, Search, Gauge } from "lucide-react"
import { toast } from "sonner"
import {
  getSEOKeywords,
  addSEOKeyword,
  calculateSEOScore,
  getHashtagPerformance,
  trackHashtagUsage,
  generateHashtags,
} from "@/app/actions/ai-content-generation"
import { HASHTAG_PLATFORMS } from "@/app/actions/ai-content-generation.utils"

export function SeoHashtagsPanel() {
  const [keywords, setKeywords] = useState<any[]>([])
  const [hashtags, setHashtags] = useState<any[]>([])
  const [keywordError, setKeywordError] = useState<string | null>(null)
  const [hashtagError, setHashtagError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // keyword form
  const [kw, setKw] = useState("")
  const [kwVolume, setKwVolume] = useState("")
  const [kwPrimary, setKwPrimary] = useState(false)

  // SEO scorer
  const [seoContent, setSeoContent] = useState("")
  const [seoTitle, setSeoTitle] = useState("")
  const [seoMeta, setSeoMeta] = useState("")
  const [seoKeyword, setSeoKeyword] = useState("")
  const [seoScore, setSeoScore] = useState<any>(null)

  // hashtag generator
  const [hashContent, setHashContent] = useState("")
  const [hashPlatform, setHashPlatform] = useState<(typeof HASHTAG_PLATFORMS)[number]>("instagram")
  const [hashLocation, setHashLocation] = useState("")
  const [generated, setGenerated] = useState<any>(null)

  // hashtag result recorder
  const [trackTag, setTrackTag] = useState("")
  const [trackEngagement, setTrackEngagement] = useState("")
  const [trackReach, setTrackReach] = useState("")

  const reload = useCallback(async () => {
    const [kwRes, htRes] = await Promise.all([getSEOKeywords(), getHashtagPerformance()])
    if (kwRes.success) {
      setKeywords(kwRes.keywords)
      setKeywordError(null)
    } else {
      setKeywords([])
      setKeywordError(kwRes.error)
    }
    if (htRes.success) {
      setHashtags(htRes.hashtags)
      setHashtagError(null)
    } else {
      setHashtags([])
      setHashtagError(htRes.error)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const handleAddKeyword = () => {
    startTransition(async () => {
      const res = await addSEOKeyword({
        keyword: kw,
        searchVolume: kwVolume ? Number(kwVolume) : undefined,
        isPrimary: kwPrimary,
      })
      if (!res.success) { toast.error(res.error); return }
      toast.success("Keyword added")
      setKw("")
      setKwVolume("")
      reload()
    })
  }

  const handleScore = () => {
    startTransition(async () => {
      const res = await calculateSEOScore({
        content: seoContent,
        title: seoTitle,
        metaDescription: seoMeta,
        primaryKeyword: seoKeyword,
      })
      if (!res.success) {
        setSeoScore(null)
        toast.error(res.error)
        return
      }
      setSeoScore(res)
    })
  }

  const handleGenerate = () => {
    startTransition(async () => {
      const res = await generateHashtags({
        content: hashContent,
        platform: hashPlatform,
        location: hashLocation || undefined,
      })
      if (!res.success) {
        setGenerated(null)
        toast.error(res.error)
        return
      }
      setGenerated(res.data)
    })
  }

  const handleTrack = () => {
    startTransition(async () => {
      const res = await trackHashtagUsage({
        hashtag: trackTag,
        platform: hashPlatform,
        engagement: Number(trackEngagement),
        reach: Number(trackReach),
      })
      if (!res.success) { toast.error(res.error); return }
      toast.success("Recorded")
      setTrackTag("")
      setTrackEngagement("")
      setTrackReach("")
      reload()
    })
  }

  return (
    <div className="space-y-4">
      {/* ── KEYWORDS ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Search className="h-4 w-4" /> My SEO keywords
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Your personal keyword list. Distinct from the brokerage-wide list on the SEO dashboard.
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Keyword</Label>
              <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="e.g. Coral Gables condos" />
            </div>
            <div className="space-y-1.5">
              <Label>Search volume</Label>
              <Input type="number" min={0} value={kwVolume} onChange={(e) => setKwVolume(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select value={kwPrimary ? "primary" : "secondary"} onValueChange={(v) => setKwPrimary(v === "primary")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="primary">Primary</SelectItem>
                  <SelectItem value="secondary">Secondary</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={handleAddKeyword} disabled={isPending || !kw.trim()}>
            {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Add keyword
          </Button>

          {keywordError ? (
            <p className="text-xs text-destructive">Could not load keywords: {keywordError}</p>
          ) : keywords.length === 0 ? (
            <p className="text-xs text-muted-foreground">No keywords tracked yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {keywords.map((k) => (
                <Badge key={k.id} variant={k.is_primary ? "default" : "outline"} className="text-[11px]">
                  {k.keyword}
                  {k.search_volume ? ` · ${k.search_volume}` : ""}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── SEO SCORE ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Gauge className="h-4 w-4" /> SEO score
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={seoTitle} onChange={(e) => setSeoTitle(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Meta description</Label>
              <Input value={seoMeta} onChange={(e) => setSeoMeta(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Primary keyword</Label>
              <Input value={seoKeyword} onChange={(e) => setSeoKeyword(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Content</Label>
            <Textarea rows={5} value={seoContent} onChange={(e) => setSeoContent(e.target.value)} />
          </div>
          <Button onClick={handleScore} disabled={isPending || !seoContent.trim() || !seoKeyword.trim()}>
            {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Score it
          </Button>

          {seoScore && (
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center gap-3">
                <p className="text-2xl font-semibold">{seoScore.score}</p>
                <div className="text-xs text-muted-foreground">
                  <p>{seoScore.wordCount} words</p>
                  <p>keyword density {seoScore.keywordDensity.toFixed(2)}%</p>
                  <p>readability {seoScore.readabilityScore.toFixed(0)}</p>
                </div>
              </div>
              {seoScore.recommendations?.length > 0 && (
                <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                  {seoScore.recommendations.map((r: string, i: number) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── HASHTAGS ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Hash className="h-4 w-4" /> Hashtags
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Platform</Label>
                <Select value={hashPlatform} onValueChange={(v) => setHashPlatform(v as typeof hashPlatform)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HASHTAG_PLATFORMS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Location</Label>
                <Input value={hashLocation} onChange={(e) => setHashLocation(e.target.value)} placeholder="Optional" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Post content</Label>
              <Textarea rows={4} value={hashContent} onChange={(e) => setHashContent(e.target.value)} />
            </div>
            <Button onClick={handleGenerate} disabled={isPending || !hashContent.trim()}>
              {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Generate hashtags
            </Button>

            {generated && (
              <div className="rounded-md border p-3 space-y-2 text-xs">
                {generated.platform_optimized_string && (
                  <p className="font-mono break-words">{generated.platform_optimized_string}</p>
                )}
                {generated.recommended_hashtags &&
                  Object.entries(generated.recommended_hashtags).map(([bucket, tags]) => (
                    <div key={bucket} className="flex flex-wrap items-center gap-1.5">
                      <span className="text-muted-foreground">{bucket.replace(/_/g, " ")}:</span>
                      {(tags as string[]).map((t) => (
                        <Badge key={t} variant="outline" className="text-[10px]">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  ))}
              </div>
            )}
          </div>

          <div className="border-t pt-4 space-y-3">
            <Label className="text-xs">Record how a hashtag actually performed</Label>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input placeholder="#hashtag" value={trackTag} onChange={(e) => setTrackTag(e.target.value)} />
              <Input
                type="number"
                min={0}
                placeholder="Engagement"
                value={trackEngagement}
                onChange={(e) => setTrackEngagement(e.target.value)}
              />
              <Input
                type="number"
                min={0}
                placeholder="Reach"
                value={trackReach}
                onChange={(e) => setTrackReach(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              onClick={handleTrack}
              disabled={isPending || !trackTag.trim() || trackEngagement === "" || trackReach === ""}
            >
              Record result
            </Button>

            {hashtagError ? (
              <p className="text-xs text-destructive">Could not load hashtag history: {hashtagError}</p>
            ) : hashtags.length === 0 ? (
              <p className="text-xs text-muted-foreground">No hashtag history yet.</p>
            ) : (
              <div className="divide-y">
                {hashtags.map((h) => (
                  <div key={h.id} className="py-2 flex items-center justify-between text-xs">
                    <span className="font-medium">{h.hashtag}</span>
                    <span className="text-muted-foreground">
                      {h.posts_count ?? 0} posts · avg engagement {Number(h.avg_engagement ?? 0).toFixed(1)} · reach{" "}
                      {h.reach ?? 0}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
