"use client"

/**
 * <TodaysFocusCard> — universal "what matters today" card.
 *
 * Reads UserTypeBrief shape; renders identically for every staff user_type.
 * Home dashboards mount this at the top with the user's brief data.
 *
 * Pattern: AI summary → top 3 priorities (severity-color-coded) → KPI metric strip.
 *
 * Vision moment: tap the play button to hear the brief read aloud in the
 * agent's cloned voice (ElevenLabs). Falls back to a professional voice if
 * no clone is set up.
 */

import Link from "next/link"
import { useRef, useState, useTransition } from "react"
import {
  Sparkles, RefreshCw, AlertCircle, AlertTriangle, ShieldAlert,
  ArrowRight, Play, Pause, Loader2, Volume2,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { UserTypeBrief, Severity } from "@/lib/intelligence/user-type-briefs"
import { generateBriefAudio } from "@/app/actions/brief-audio"

interface Props {
  brief: UserTypeBrief
  onRefresh?: () => void
  refreshing?: boolean
}

const SEVERITY_CONFIG: Record<Severity, { label: string; icon: React.ReactElement; color: string; bg: string }> = {
  critical: {
    label: "Critical",
    icon: <AlertCircle className="h-4 w-4 text-red-600" />,
    color: "text-red-700 dark:text-red-400",
    bg: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900",
  },
  high: {
    label: "High",
    icon: <AlertTriangle className="h-4 w-4 text-orange-600" />,
    color: "text-orange-700 dark:text-orange-400",
    bg: "bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-900",
  },
  medium: {
    label: "Medium",
    icon: <ShieldAlert className="h-4 w-4 text-amber-600" />,
    color: "text-amber-700 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900",
  },
  low: {
    label: "Low",
    icon: <ShieldAlert className="h-4 w-4 text-slate-500" />,
    color: "text-slate-700 dark:text-slate-400",
    bg: "bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800",
  },
}

export function TodaysFocusCard({ brief, onRefresh, refreshing }: Props) {
  const [isPending, startTransition] = useTransition()
  const busy = refreshing || isPending

  // Audio state — generate on first play, cache in component for re-plays
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioLoading, setAudioLoading] = useState(false)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)

  async function handlePlayPause() {
    setAudioError(null)

    // If already playing, pause
    if (audioPlaying && audioRef.current) {
      audioRef.current.pause()
      setAudioPlaying(false)
      return
    }

    // If audio already generated, just play
    if (audioUrl && audioRef.current) {
      audioRef.current.play().catch(() => setAudioError("Playback blocked"))
      setAudioPlaying(true)
      return
    }

    // First play: generate audio
    setAudioLoading(true)
    try {
      const result = await generateBriefAudio({ brief })
      if (result.success && result.audioDataUrl) {
        setAudioUrl(result.audioDataUrl)
        // play after audio element rerenders
        setTimeout(() => {
          audioRef.current?.play().catch(() => setAudioError("Playback blocked"))
          setAudioPlaying(true)
        }, 50)
      } else {
        setAudioError(result.error ?? "Voice unavailable")
      }
    } catch {
      setAudioError("Voice unavailable")
    } finally {
      setAudioLoading(false)
    }
  }

  if (!brief.summary && brief.priorities.length === 0 && brief.metrics.length === 0) {
    return null
  }

  return (
    <Card className="border-amber-200 dark:border-amber-900 bg-gradient-to-br from-amber-50/50 to-orange-50/30 dark:from-amber-950/20 dark:to-orange-950/10">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <div className="flex items-center justify-center h-8 w-8 rounded-full bg-amber-100 dark:bg-amber-900/40 shrink-0">
              <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <CardTitle className="text-base">Today's Focus</CardTitle>
              {brief.summary && (
                <p className="text-sm text-foreground mt-1 leading-snug">{brief.summary}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={handlePlayPause}
              disabled={audioLoading}
              title={audioPlaying ? "Pause" : "Read brief aloud"}
              aria-label={audioPlaying ? "Pause brief audio" : "Play brief audio"}
            >
              {audioLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : audioPlaying ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </Button>
            {onRefresh && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => startTransition(() => onRefresh())}
                disabled={busy}
                title="Regenerate brief"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
              </Button>
            )}
          </div>
          {/* Hidden audio element rendered when audio is generated */}
          {audioUrl && (
            <audio
              ref={audioRef}
              src={audioUrl}
              onEnded={() => setAudioPlaying(false)}
              onPause={() => setAudioPlaying(false)}
              onPlay={() => setAudioPlaying(true)}
            />
          )}
        </div>
        {audioError && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1.5 ml-10">
            {audioError}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Priorities */}
        {brief.priorities.length > 0 && (
          <div className="space-y-2">
            {brief.priorities.map((p, idx) => {
              const cfg = SEVERITY_CONFIG[p.severity]
              return (
                <div key={p.id} className={`rounded-lg border p-3 ${cfg.bg}`}>
                  <div className="flex items-start gap-2">
                    <div className="shrink-0 mt-0.5 flex items-center gap-1.5">
                      <span className={`text-xs font-bold ${cfg.color}`}>{idx + 1}</span>
                      {cfg.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">{p.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{p.body}</p>
                      {p.ctas && p.ctas.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {p.ctas.map((cta, ctaIdx) =>
                            cta.href ? (
                              <Link key={ctaIdx} href={cta.href}>
                                <Button size="sm" variant={ctaIdx === 0 ? "default" : "outline"} className="h-6 text-[11px]">
                                  {cta.label}
                                </Button>
                              </Link>
                            ) : (
                              <Button
                                key={ctaIdx}
                                size="sm"
                                variant={ctaIdx === 0 ? "default" : "outline"}
                                className="h-6 text-[11px]"
                              >
                                {cta.label}
                              </Button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Metrics strip */}
        {brief.metrics.length > 0 && (
          <div className="border-t border-amber-200/50 dark:border-amber-900/50 pt-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {brief.metrics.map((m) => {
                const inner = (
                  <div className="text-center">
                    <div className="text-lg font-semibold text-foreground">{m.value}</div>
                    <div className="text-[11px] text-muted-foreground">{m.label}</div>
                  </div>
                )
                return m.href ? (
                  <Link key={m.label} href={m.href} className="hover:bg-white/40 dark:hover:bg-black/20 rounded p-1 transition">
                    {inner}
                  </Link>
                ) : (
                  <div key={m.label}>{inner}</div>
                )
              })}
            </div>
          </div>
        )}

        {brief.cached && (
          <p className="text-[10px] text-muted-foreground text-right">
            Cached · regenerate for fresh data
          </p>
        )}
      </CardContent>
    </Card>
  )
}
