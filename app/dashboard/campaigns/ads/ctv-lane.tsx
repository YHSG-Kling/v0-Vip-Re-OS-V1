"use client"

// app/dashboard/campaigns/ads/ctv-lane.tsx
// STREAMING TV lane of the Ads Manager — stage a Vibe.co CTV campaign from a
// completed, TV-eligible video and render the honest LAUNCH PACKAGE (creative
// link, targeting, budget, real launch checklist, vibe.co deep link).
//
// Honesty contract: staging writes a REAL ad_campaigns draft; nothing here
// talks to Vibe. "Try auto-dispatch" surfaces the connector slot's honest
// refusal (not connected / API contract pending). draft → live happens ONLY
// via the human "Mark as launched" confirmation.

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tv, ExternalLink, Loader2, CheckCircle, Clock, Film, Send, Rocket } from "lucide-react"
import { toast } from "sonner"
import {
  stageCtvCampaignAction,
  markCtvCampaignLaunchedAction,
  dispatchCtvCampaignAction,
} from "@/app/actions/ctv-ads"
import type { CtvLaunchPackage } from "@/lib/ads/ctv-campaign"

export interface CtvEligibleVideo {
  id: string
  title: string | null
  video_url: string | null
  duration_seconds: number | null
  format: string | null
  thumbnail_url: string | null
  listing_id: string | null
  created_at: string
}

export interface CtvCampaignRow {
  id: string
  campaign_name: string
  status: string
  daily_budget: number | null
  targeting_config: Record<string, unknown> | null
  created_at: string
}

interface CtvLaneProps {
  vibeConnected: boolean
  eligibleVideos: CtvEligibleVideo[]
  ctvCampaigns: CtvCampaignRow[]
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export function CtvLane({ vibeConnected, eligibleVideos, ctvCampaigns }: CtvLaneProps) {
  const router = useRouter()

  const [videoId, setVideoId] = useState<string>(eligibleVideos[0]?.id ?? "")
  const [campaignName, setCampaignName] = useState("")
  const [dailyBudget, setDailyBudget] = useState("25")
  const [dmas, setDmas] = useState("")
  const [cities, setCities] = useState("")
  const [zips, setZips] = useState("")
  const [isStaging, setIsStaging] = useState(false)
  const [launchPackage, setLaunchPackage] = useState<CtvLaunchPackage | null>(null)
  const [busyCampaignId, setBusyCampaignId] = useState<string | null>(null)

  const selectedVideo = eligibleVideos.find((v) => v.id === videoId)

  const handleStage = async () => {
    const budgetCents = Math.round(parseFloat(dailyBudget) * 100)
    if (!Number.isFinite(budgetCents) || budgetCents <= 0) {
      toast.error("Enter a daily budget greater than $0")
      return
    }
    if (!videoId) {
      toast.error("Pick a TV-eligible video first")
      return
    }
    setIsStaging(true)
    setLaunchPackage(null)
    const result = await stageCtvCampaignAction({
      videoProjectId: videoId,
      listingId: selectedVideo?.listing_id ?? null,
      campaignName: campaignName.trim() || undefined,
      dailyBudgetCents: budgetCents,
      targeting: { dmas: splitList(dmas), cities: splitList(cities), zips: splitList(zips) },
    })
    setIsStaging(false)
    if (result.success && result.package) {
      setLaunchPackage(result.package)
      toast.success("Streaming-TV campaign staged as a launch package")
      router.refresh()
    } else {
      toast.error(result.error || "Staging failed")
    }
  }

  const handleMarkLaunched = async (campaignId: string) => {
    setBusyCampaignId(campaignId)
    const result = await markCtvCampaignLaunchedAction(campaignId)
    setBusyCampaignId(null)
    if (result.success) {
      toast.success(result.error ? `Marked launched (${result.error})` : "Marked as launched on Vibe")
      if (launchPackage?.campaignId === campaignId) setLaunchPackage(null)
      router.refresh()
    } else {
      toast.error(result.error || "Could not mark as launched")
    }
  }

  const handleTryDispatch = async (campaignId: string) => {
    setBusyCampaignId(campaignId)
    const result = await dispatchCtvCampaignAction(campaignId)
    setBusyCampaignId(null)
    if (result.dispatched) {
      toast.success("Launched on Vibe — your campaign is live")
      if (launchPackage?.campaignId === campaignId) setLaunchPackage(null)
      router.refresh()
    } else {
      // Real Vibe error (or not connected) — surfaced honestly; the manual
      // vibe.co + Mark-as-launched path remains available.
      toast.error(`Launch failed: ${result.reason}`)
    }
  }

  return (
    <div className="space-y-4">
      {/* Lane header + connection truth */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Tv className="h-5 w-5" />
                Streaming TV (CTV) via Vibe
              </CardTitle>
              <CardDescription>
                Push a 15s/30s landscape video to streaming-TV inventory through vibe.co. The OS
                validates the creative, stages the campaign, and hands you a complete launch
                package — launch happens on Vibe, then you confirm it here.
              </CardDescription>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Badge className={vibeConnected ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}>
                {vibeConnected ? "Vibe credential connected" : "Vibe not connected"}
              </Badge>
              <Button variant="outline" size="sm" asChild>
                <a href="https://vibe.co" target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-1" />
                  Open vibe.co
                </a>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {vibeConnected
            ? "Vibe is connected — the OS launches campaigns for you: it uploads the creative, creates the campaign + geo-targeted strategy, and publishes on Vibe. No trip to vibe.co needed."
            : "No Vibe credential is connected (Integrations → provider 'vibe'). Campaigns still stage fully as launch packages; connect Vibe to launch in one click, or launch in the Vibe dashboard and press 'Mark as launched'."}
        </CardContent>
      </Card>

      {/* Stage a new CTV campaign */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Stage a Streaming-TV Campaign</CardTitle>
          <CardDescription>
            Eligible creative: a completed video, 15–35s, with a rendered URL — 16:9 for TV.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {eligibleVideos.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <Film className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium">No TV-eligible videos yet</p>
              <p className="text-xs mt-1">
                Missing: a completed video between 15 and 35 seconds with a rendered video URL.
                Produce one in the Marketing Studio (a 16:9 landscape cut), then come back.
              </p>
              <Button variant="outline" size="sm" className="mt-3" asChild>
                <a href="/dashboard/marketing/studio">Open Marketing Studio</a>
              </Button>
            </div>
          ) : (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Creative video</Label>
                  <Select value={videoId} onValueChange={setVideoId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a video" />
                    </SelectTrigger>
                    <SelectContent>
                      {eligibleVideos.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {(v.title || "Untitled video") +
                            (v.duration_seconds != null ? ` · ${v.duration_seconds}s` : "") +
                            (v.format ? ` · ${v.format}` : "")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedVideo && selectedVideo.format !== "16:9" && (
                    <p className="text-xs text-amber-600">
                      Aspect ratio {selectedVideo.format ? `'${selectedVideo.format}'` : "not recorded"} — TV needs
                      16:9; staging will verify and refuse a known vertical/square cut.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Campaign name (optional)</Label>
                  <Input
                    placeholder="Streaming TV — 123 Main St"
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Daily budget (USD)</Label>
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={dailyBudget}
                    onChange={(e) => setDailyBudget(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>DMAs (comma-separated)</Label>
                  <Input placeholder="Sacramento-Stockton-Modesto" value={dmas} onChange={(e) => setDmas(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Cities (comma-separated)</Label>
                  <Input placeholder="Folsom, El Dorado Hills" value={cities} onChange={(e) => setCities(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>ZIP codes (comma-separated)</Label>
                  <Input placeholder="95630, 95762" value={zips} onChange={(e) => setZips(e.target.value)} />
                </div>
              </div>
              <Button onClick={handleStage} disabled={isStaging}>
                {isStaging ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Rocket className="h-4 w-4 mr-2" />}
                Stage Launch Package
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Freshly staged launch package */}
      {launchPackage && (
        <Card className="border-emerald-300">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-600" />
              Launch Package — ready for Vibe
            </CardTitle>
            <CardDescription>
              {launchPackage.targetingSummary} · {launchPackage.budgetSummary}
              {launchPackage.creativeDurationSeconds != null && ` · ${launchPackage.creativeDurationSeconds}s spot`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ol className="list-decimal list-inside space-y-1 text-sm">
              {launchPackage.checklist.map((step, i) => (
                <li key={i} className="text-muted-foreground">
                  {step}
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href={launchPackage.creativeUrl} target="_blank" rel="noopener noreferrer">
                  <Film className="h-4 w-4 mr-1" />
                  Creative video
                </a>
              </Button>
              {vibeConnected ? (
                // Connected → launch on Vibe from inside the app (upload creative,
                // create campaign + geo-targeted strategy, publish). No trip to vibe.co.
                <Button
                  size="sm"
                  className="bg-violet-600 hover:bg-violet-700"
                  onClick={() => handleTryDispatch(launchPackage.campaignId)}
                  disabled={busyCampaignId === launchPackage.campaignId}
                >
                  <Tv className="h-4 w-4 mr-1" />
                  {busyCampaignId === launchPackage.campaignId ? "Launching…" : "Launch on Vibe now"}
                </Button>
              ) : (
                // Not connected → the manual path: launch on vibe.co, confirm here.
                <>
                  <Button variant="outline" size="sm" asChild>
                    <a href={launchPackage.vibeDeepLink} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-4 w-4 mr-1" />
                      Open vibe.co
                    </a>
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => handleMarkLaunched(launchPackage.campaignId)}
                    disabled={busyCampaignId === launchPackage.campaignId}
                  >
                    <CheckCircle className="h-4 w-4 mr-1" />
                    Mark as launched
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Existing CTV campaigns */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Streaming-TV Campaigns ({ctvCampaigns.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {ctvCampaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No streaming-TV campaigns staged yet.</p>
          ) : (
            ctvCampaigns.map((c) => {
              const tc = (c.targeting_config ?? {}) as Record<string, unknown>
              const creativeUrl = typeof tc.creative_video_url === "string" ? tc.creative_video_url : null
              const geo = [
                Array.isArray(tc.dmas) && tc.dmas.length ? `DMAs: ${(tc.dmas as string[]).join(", ")}` : null,
                Array.isArray(tc.cities) && tc.cities.length ? `Cities: ${(tc.cities as string[]).join(", ")}` : null,
                Array.isArray(tc.zips) && tc.zips.length ? `ZIPs: ${(tc.zips as string[]).join(", ")}` : null,
              ]
                .filter(Boolean)
                .join(" · ")
              return (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 border rounded-lg p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{c.campaign_name}</span>
                      <Badge
                        className={
                          c.status === "live"
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-100 text-gray-600"
                        }
                      >
                        {c.status === "live" ? (
                          <CheckCircle className="h-3 w-3 mr-1" />
                        ) : (
                          <Clock className="h-3 w-3 mr-1" />
                        )}
                        {c.status === "draft" ? "draft (staged)" : c.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {geo || "No geography recorded"}
                      {c.daily_budget != null && ` · $${Number(c.daily_budget).toLocaleString()}/day`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {creativeUrl && (
                      <Button variant="outline" size="sm" asChild>
                        <a href={creativeUrl} target="_blank" rel="noopener noreferrer">
                          <Film className="h-4 w-4" />
                        </a>
                      </Button>
                    )}
                    {c.status === "draft" && (
                      <>
                        <Button
                          variant={vibeConnected ? "default" : "outline"}
                          size="sm"
                          className={vibeConnected ? "bg-violet-600 hover:bg-violet-700" : undefined}
                          onClick={() => handleTryDispatch(c.id)}
                          disabled={busyCampaignId === c.id}
                          title={vibeConnected
                            ? "Launch this campaign on Vibe from inside the app"
                            : "Connect Vibe (Integrations → 'vibe') to launch in-app; otherwise launch on vibe.co and mark launched"}
                        >
                          <Send className="h-4 w-4 mr-1" />
                          {vibeConnected ? "Launch on Vibe" : "Try auto-dispatch"}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleMarkLaunched(c.id)}
                          disabled={busyCampaignId === c.id}
                        >
                          {busyCampaignId === c.id ? (
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          ) : (
                            <CheckCircle className="h-4 w-4 mr-1" />
                          )}
                          Mark as launched
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
    </div>
  )
}
