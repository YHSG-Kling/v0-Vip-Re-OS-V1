"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Loader2, BarChart2, Clock, TrendingUp, Headphones } from "lucide-react"
import { getPodcastAnalytics } from "@/app/actions/podcast-generation"

interface EpisodeStat {
  id: string
  title: string
  plays: number
}

export function AnalyticsTab() {
  const [loading, setLoading] = useState(true)
  const [totalPlays, setTotalPlays] = useState(0)
  const [totalListenMinutes, setTotalListenMinutes] = useState(0)
  const [episodeStats, setEpisodeStats] = useState<EpisodeStat[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const result = await getPodcastAnalytics()
        if (cancelled) return
        if (result.success) {
          setTotalPlays(result.totalPlays ?? 0)
          setTotalListenMinutes(result.totalListenMinutes ?? 0)
          setEpisodeStats((result.episodeStats ?? []) as EpisodeStat[])
        } else {
          setError(result.error ?? "Failed to load analytics")
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
  }, [])

  const avgPlaysPerEpisode =
    episodeStats.length > 0
      ? Math.round(episodeStats.reduce((s, e) => s + e.plays, 0) / episodeStats.length)
      : 0

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
            <div className="p-2 bg-amber-100 rounded-lg shrink-0">
              <TrendingUp className="h-4 w-4 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold">
                {loading ? <Loader2 className="h-5 w-5 animate-spin text-gray-400" /> : avgPlaysPerEpisode.toLocaleString()}
              </p>
              <p className="text-xs text-gray-500">Avg Plays / Episode</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart2 className="h-4 w-4" />
            Episodes by Play Count
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {!error && loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            </div>
          )}
          {!error && !loading && episodeStats.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-8">No published episodes yet.</p>
          )}
          {!error && !loading && episodeStats.length > 0 && (
            <ul className="divide-y">
              {episodeStats.map((ep) => (
                <li key={ep.id} className="flex items-center justify-between py-3">
                  <span className="text-sm font-medium truncate">{ep.title}</span>
                  <span className="text-sm tabular-nums text-gray-600">
                    {ep.plays.toLocaleString()} {ep.plays === 1 ? "play" : "plays"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
