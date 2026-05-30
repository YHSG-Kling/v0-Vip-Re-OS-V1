"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
import {
  Loader2,
  BarChart2,
  Clock,
  TrendingUp,
  Headphones,
  Users,
  CheckCircle2,
  ExternalLink,
} from "lucide-react"
import { getPodcastAdvancedAnalytics } from "@/app/actions/podcast-generation"

interface DailyTrendPoint {
  date: string
  plays: number
}

interface PerEpisode {
  id: string
  title: string
  plays: number
  audioUrl: string | null
  publishedChannels: string[]
  platformLinks: Record<string, string | null>
}

interface ChannelBreakdown {
  channel: string
  plays: number
  minutes: number
}

const TREND_OPTIONS: Array<{ value: 30 | 60 | 90; label: string }> = [
  { value: 30, label: "Last 30 days" },
  { value: 60, label: "Last 60 days" },
  { value: 90, label: "Last 90 days" },
]

export function AnalyticsTab() {
  const [loading, setLoading] = useState(true)
  const [trendDays, setTrendDays] = useState<30 | 60 | 90>(30)
  const [error, setError] = useState<string | null>(null)

  const [totalPlays, setTotalPlays] = useState(0)
  const [totalListenMinutes, setTotalListenMinutes] = useState(0)
  const [avgCompletionRate, setAvgCompletionRate] = useState(0)
  const [subscribersLast30, setSubscribersLast30] = useState(0)
  const [subscriberGrowthPct, setSubscriberGrowthPct] = useState<number | null>(null)
  const [channelBreakdown, setChannelBreakdown] = useState<ChannelBreakdown[]>([])
  const [dailyTrend, setDailyTrend] = useState<DailyTrendPoint[]>([])
  const [perEpisode, setPerEpisode] = useState<PerEpisode[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await getPodcastAdvancedAnalytics({ trendDays })
        if (cancelled) return
        if (res.success) {
          setTotalPlays(res.totalPlays ?? 0)
          setTotalListenMinutes(res.totalListenMinutes ?? 0)
          setAvgCompletionRate(res.avgCompletionRate ?? 0)
          setSubscribersLast30(res.subscribersLast30 ?? 0)
          setSubscriberGrowthPct(res.subscriberGrowthPct ?? null)
          setChannelBreakdown((res.channelBreakdown ?? []) as ChannelBreakdown[])
          setDailyTrend((res.dailyTrend ?? []) as DailyTrendPoint[])
          setPerEpisode((res.perEpisode ?? []) as PerEpisode[])
        } else {
          setError(res.error ?? "Failed to load analytics")
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? "Failed to load analytics")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [trendDays])

  const maxTrend = Math.max(1, ...dailyTrend.map((d) => d.plays))
  const maxChannel = Math.max(1, ...channelBreakdown.map((c) => c.plays))

  return (
    <div className="space-y-6">
      {/* Top stats — 4 across */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg shrink-0">
              <Headphones className="h-4 w-4 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold">
                {loading ? <Loader2 className="h-5 w-5 animate-spin text-gray-400" /> : totalPlays.toLocaleString()}
              </p>
              <p className="text-xs text-gray-500">Total Plays</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-emerald-100 rounded-lg shrink-0">
              <Clock className="h-4 w-4 text-emerald-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold">
                {loading ? <Loader2 className="h-5 w-5 animate-spin text-gray-400" /> : totalListenMinutes.toLocaleString()}
              </p>
              <p className="text-xs text-gray-500">Total Listen Minutes</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-purple-100 rounded-lg shrink-0">
              <CheckCircle2 className="h-4 w-4 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold">
                {loading ? <Loader2 className="h-5 w-5 animate-spin text-gray-400" /> : `${avgCompletionRate}%`}
              </p>
              <p className="text-xs text-gray-500">Avg Completion Rate</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-amber-100 rounded-lg shrink-0">
              <Users className="h-4 w-4 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold">
                {loading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                ) : (
                  subscribersLast30.toLocaleString()
                )}
              </p>
              <p className="text-xs text-gray-500">
                New Subscribers (30d)
                {subscriberGrowthPct != null && (
                  <span className={`ml-1 ${subscriberGrowthPct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {subscriberGrowthPct >= 0 ? "+" : ""}
                    {subscriberGrowthPct}%
                  </span>
                )}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Daily trend chart */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Plays Trend
          </CardTitle>
          <Select value={String(trendDays)} onValueChange={(v) => setTrendDays(Number(v) as 30 | 60 | 90)}>
            <SelectTrigger className="w-[170px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TREND_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {!error && loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            </div>
          )}
          {!error && !loading && dailyTrend.length > 0 && (
            <div className="h-32 flex items-end gap-0.5">
              {dailyTrend.map((d, i) => (
                <div key={i} className="flex-1 flex flex-col items-center justify-end" title={`${d.date}: ${d.plays} plays`}>
                  <div
                    className="w-full bg-primary/70 rounded-t"
                    style={{ height: `${(d.plays / maxTrend) * 100}%`, minHeight: d.plays > 0 ? 2 : 0 }}
                  />
                </div>
              ))}
            </div>
          )}
          {!error && !loading && dailyTrend.length > 0 && (
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>{dailyTrend[0]?.date}</span>
              <span>{dailyTrend[dailyTrend.length - 1]?.date}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-channel breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart2 className="h-4 w-4" />
            Per-Channel Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!error && !loading && channelBreakdown.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-6">No play events recorded yet.</p>
          )}
          {!error && !loading && channelBreakdown.length > 0 && (
            <ul className="space-y-2.5">
              {channelBreakdown.map((c) => (
                <li key={c.channel} className="flex items-center gap-3">
                  <span className="text-sm font-medium capitalize w-24 shrink-0">{c.channel}</span>
                  <div className="flex-1 h-2 bg-muted rounded">
                    <div
                      className="h-2 bg-primary rounded"
                      style={{ width: `${(c.plays / maxChannel) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-600 tabular-nums w-24 text-right shrink-0">
                    {c.plays.toLocaleString()} plays · {c.minutes.toLocaleString()}m
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Per-episode table with platform deep links */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Episodes</CardTitle>
        </CardHeader>
        <CardContent>
          {!error && !loading && perEpisode.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-6">No published episodes yet.</p>
          )}
          {!error && !loading && perEpisode.length > 0 && (
            <ul className="divide-y">
              {perEpisode.map((ep) => (
                <li key={ep.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{ep.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {ep.plays.toLocaleString()} {ep.plays === 1 ? "play" : "plays"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {Object.entries(ep.platformLinks).map(([platform, url]) =>
                      url ? (
                        <Button asChild key={platform} size="sm" variant="outline" className="h-7 text-xs gap-1">
                          <a href={url} target="_blank" rel="noopener noreferrer">
                            {platform}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </Button>
                      ) : null,
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
