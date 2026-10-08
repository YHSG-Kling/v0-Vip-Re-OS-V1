"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TrendingUp, TrendingDown, ExternalLink, Heart, Loader2, Wand2, Copy } from "lucide-react"
import { getCompetitorPostInspiration } from "@/app/actions/marketing-intelligence"
import type { TrendingKeyword, CompetitorPost } from "@/app/actions/marketing-intelligence"

/**
 * MARKET TRENDS — the "popular keyword + competitor signal" surface that used
 * to live at /dashboard/marketing/intelligence. It now renders inside the
 * SEO / GEO section (Trends tab): trending search topics to write content
 * against, plus competitor posts that are working — the raw material for
 * ranking higher and winning organic traffic.
 *
 * Data is fetched by the SEO page from getTrendingKeywords /
 * getCompetitorHighPerformers (keyword_intelligence + competitor_content),
 * which the background scrapers populate.
 *
 * "Repurpose this concept" (the per-post button) is the one interaction here:
 * it calls getCompetitorPostInspiration for the SIGNAL behind a winning post —
 * topics, keywords, hook type, emotional tone — and composes the brief the
 * agent hands to their own AI writer. It deliberately does NOT return the
 * competitor's caption: the point is to rebuild the idea in the agent's brand
 * voice, not to copy someone's copy.
 */
interface Inspiration {
  topics: string[]
  keywords: string[]
  hookType: string | null
  emotionalTone: string | null
  inspirationPrompt: string
}

export function MarketTrendsPanel({
  keywords,
  competitors,
}: {
  keywords: TrendingKeyword[]
  competitors: CompetitorPost[]
}) {
  const [openPostId, setOpenPostId] = useState<string | null>(null)
  const [inspiration, setInspiration] = useState<Inspiration | null>(null)
  const [inspirationError, setInspirationError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isPending, startTransition] = useTransition()

  function loadInspiration(postId: string) {
    if (openPostId === postId) {
      setOpenPostId(null)
      return
    }
    setOpenPostId(postId)
    setInspiration(null)
    setInspirationError(null)
    setCopied(false)
    startTransition(async () => {
      const r = await getCompetitorPostInspiration(postId)
      // null covers BOTH "not yours / not found" and a refused read. Say we
      // could not build it rather than rendering an empty brief that looks
      // like the post had no signal in it.
      if (!r) {
        setInspirationError("Could not load the signal for this post.")
        return
      }
      setInspiration(r)
    })
  }

  return (
    <div className="space-y-6">
      {/* Trending keywords */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Trending Keywords
          </CardTitle>
          <CardDescription>Ranked by search volume — use these as content topics.</CardDescription>
        </CardHeader>
        <CardContent>
          {keywords.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No trending keywords captured yet. The keyword-intelligence scrapers populate this as they run.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {keywords.map((k) => (
                <div key={k.keyword} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{k.keyword}</span>
                    {k.trendChangePct != null && (
                      <span
                        className={`text-xs flex items-center gap-0.5 ${k.trendChangePct >= 0 ? "text-emerald-600" : "text-red-600"}`}
                      >
                        {k.trendChangePct >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {Math.abs(k.trendChangePct)}%
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                    {k.searchVolume != null && <span>{k.searchVolume.toLocaleString()} searches</span>}
                    {k.intentCategory && (
                      <Badge variant="secondary" className="text-[10px]">
                        {k.intentCategory}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Competitor high-performers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Heart className="h-4 w-4" />
            Competitor High-Performers
          </CardTitle>
          <CardDescription>Posts driving engagement in your market — draw inspiration, don't copy.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {competitors.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No competitor posts captured yet. Social-listening scrapers populate this as they run.
            </p>
          ) : (
            competitors.map((p) => (
              <div key={p.id} className="p-3 rounded-lg border space-y-3">
                <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{p.competitorName || "Competitor"}</span>
                    <Badge variant="outline" className="text-xs">
                      {p.platform}
                    </Badge>
                    {p.hookType && (
                      <Badge variant="secondary" className="text-xs">
                        {p.hookType}
                      </Badge>
                    )}
                  </div>
                  {p.caption && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{p.caption}</p>}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                    {p.likesCount != null && (
                      <span className="flex items-center gap-0.5">
                        <Heart className="h-3 w-3" />
                        {p.likesCount.toLocaleString()}
                      </span>
                    )}
                    {p.engagementRate != null && <span>{p.engagementRate}% eng.</span>}
                    {p.detectedTopics?.slice(0, 3).map((t) => (
                      <span key={t}>#{t}</span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1"
                    onClick={() => loadInspiration(p.id)}
                    disabled={isPending && openPostId === p.id}
                  >
                    {isPending && openPostId === p.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Wand2 className="h-3 w-3" />
                    )}
                    Repurpose
                  </Button>
                  {p.contentUrl && (
                    <a
                      href={p.contentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                </div>
                </div>

                {openPostId === p.id && (
                  <div className="rounded-md border bg-muted/40 p-3 space-y-2">
                    {isPending && !inspiration && !inspirationError && (
                      <p className="text-xs text-muted-foreground">Reading the signal…</p>
                    )}
                    {inspirationError && <p className="text-xs text-destructive">{inspirationError}</p>}
                    {inspiration && (
                      <>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          {inspiration.hookType && (
                            <Badge variant="secondary" className="text-[10px]">
                              {inspiration.hookType} hook
                            </Badge>
                          )}
                          {inspiration.emotionalTone && (
                            <Badge variant="outline" className="text-[10px]">
                              {inspiration.emotionalTone}
                            </Badge>
                          )}
                          {inspiration.topics.map((t) => (
                            <Badge key={t} variant="outline" className="text-[10px]">
                              #{t}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs leading-relaxed whitespace-pre-wrap">
                          {inspiration.inspirationPrompt}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs gap-1"
                          onClick={() => {
                            void navigator.clipboard
                              ?.writeText(inspiration.inspirationPrompt)
                              .then(() => setCopied(true))
                              .catch(() => setCopied(false))
                          }}
                        >
                          <Copy className="h-3 w-3" />
                          {copied ? "Copied" : "Copy brief"}
                        </Button>
                        <p className="text-[11px] text-muted-foreground">
                          Paste this into the AI writer in Marketing Studio or the blog editor — it rebuilds the
                          concept in your brand voice. Never copy the original post.
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
