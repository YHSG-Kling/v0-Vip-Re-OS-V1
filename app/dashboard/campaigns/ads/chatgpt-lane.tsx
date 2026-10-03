"use client"

// app/dashboard/campaigns/ads/chatgpt-lane.tsx
// ChatGPT Ads lane (OpenAI Ads Manager — ads.openai.com). Modeled on
// ctv-lane.tsx: honest about what the OS can and cannot do.
//
// Honesty contract: OpenAI Ads Manager is self-serve with NO advertiser API.
// The OS composes and stages the campaign (a real ad_campaigns draft + a
// creative in the ONE approval queue) and hands over a launch package —
// headline, description, context hints, locations, a bulk-upload CSV and a
// checklist. A human uploads it at ads.openai.com. draft → live happens ONLY
// via the human "Mark as launched" confirmation, and performance arrives only
// by importing the Ads Manager's own report CSV.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sparkles,
  ExternalLink,
  Loader2,
  CheckCircle,
  Clock,
  Copy,
  Rocket,
  ImageIcon,
  AlertTriangle,
  Send,
} from "lucide-react"
import { toast } from "sonner"
import {
  stageChatgptCampaignAction,
  markChatgptCampaignLaunchedAction,
  importChatgptPerformanceAction,
  dispatchChatgptCampaignAction,
} from "@/app/actions/chatgpt-ads"
import type { ChatgptLaunchPackage } from "@/lib/ads/chatgpt-campaign"
import { CHATGPT_ADS_MANAGER_URL, CHATGPT_MIN_DAILY_BUDGET_USD, CHATGPT_OBJECTIVES, type ChatgptObjective } from "@/lib/integrations/ad-campaign-vocabulary"
import type { ListingAdKind } from "@/lib/ads/listing-ad-producer"
import type { ProviderPerformanceRow } from "@/lib/ads/connectors/types"

export interface ChatgptCampaignRow {
  id: string
  campaign_name: string | null
  status: string
  daily_budget: number | null
  targeting_config: Record<string, unknown> | null
  created_at: string
}

export interface ChatgptEligibleListing {
  id: string
  address: string | null
  city: string | null
  state: string | null
}

interface ChatgptLaneProps {
  /** Honest posture for the OpenAI Advertiser API credential (provider 'openai_ads'). */
  openaiAdsConnected: boolean
  listings: ChatgptEligibleListing[]
  chatgptCampaigns: ChatgptCampaignRow[]
}

const MOMENT_OPTIONS: Array<{ value: ListingAdKind; label: string }> = [
  { value: "just_listed", label: "Just Listed" },
  { value: "just_sold", label: "Just Sold" },
  { value: "price_reduction", label: "Price Reduction" },
]

function listingLabel(l: ChatgptEligibleListing): string {
  const where = [l.city, l.state].filter(Boolean).join(", ")
  return l.address ? `${l.address}${where ? ` — ${where}` : ""}` : where || l.id
}

function copyText(text: string, label: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${label} copied`))
    .catch(() => toast.error(`Could not copy ${label.toLowerCase()}`))
}

export function ChatgptLane({ openaiAdsConnected, listings, chatgptCampaigns }: ChatgptLaneProps) {
  const router = useRouter()
  const [isStaging, startStaging] = useTransition()
  const [isBusy, startBusy] = useTransition()

  const [listingId, setListingId] = useState<string>(listings[0]?.id ?? "")
  const [kind, setKind] = useState<ListingAdKind>("just_listed")
  const [objective, setObjective] = useState<ChatgptObjective>("clicks")
  const [dailyBudget, setDailyBudget] = useState(String(CHATGPT_MIN_DAILY_BUDGET_USD))
  const [extraHints, setExtraHints] = useState("")
  const [campaignName, setCampaignName] = useState("")
  const [stageError, setStageError] = useState<string | null>(null)
  const [launchPackage, setLaunchPackage] = useState<ChatgptLaunchPackage | null>(null)

  const [busyCampaignId, setBusyCampaignId] = useState<string | null>(null)
  const [externalIdByCampaign, setExternalIdByCampaign] = useState<Record<string, string>>({})
  const [csvByCampaign, setCsvByCampaign] = useState<Record<string, string>>({})
  const [importedRowByCampaign, setImportedRowByCampaign] = useState<Record<string, ProviderPerformanceRow>>({})
  const [importErrorByCampaign, setImportErrorByCampaign] = useState<Record<string, string>>({})
  const [dispatchResultByCampaign, setDispatchResultByCampaign] = useState<
    Record<string, { dispatched: boolean; reason: string; reviewStatus?: string | null }>
  >({})

  const handleStage = () => {
    const budget = Number.parseFloat(dailyBudget)
    if (!listingId) {
      toast.error("Pick a listing first")
      return
    }
    if (!Number.isFinite(budget) || budget < CHATGPT_MIN_DAILY_BUDGET_USD) {
      toast.error(`Daily budget must be at least $${CHATGPT_MIN_DAILY_BUDGET_USD}`)
      return
    }
    setStageError(null)
    startStaging(async () => {
      const result = await stageChatgptCampaignAction({
        listingId,
        kind,
        objective,
        dailyBudgetUsd: budget,
        campaignName: campaignName.trim() || undefined,
        extraContextHints: extraHints
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      })
      if (result.success && result.package) {
        setLaunchPackage(result.package)
        toast.success("ChatGPT Ads launch package staged")
        router.refresh()
      } else {
        setStageError(result.error || "Staging failed")
        toast.error(result.error || "Staging failed")
      }
    })
  }

  const handleMarkLaunched = (campaignId: string) => {
    setBusyCampaignId(campaignId)
    startBusy(async () => {
      const result = await markChatgptCampaignLaunchedAction(
        campaignId,
        externalIdByCampaign[campaignId]?.trim() || null,
      )
      setBusyCampaignId(null)
      if (result.success) {
        toast.success(result.error ? `Marked launched (${result.error})` : "Marked as launched on ChatGPT Ads Manager")
        if (launchPackage?.campaignId === campaignId) setLaunchPackage(null)
        router.refresh()
      } else {
        toast.error(result.error || "Could not mark as launched")
      }
    })
  }

  const handleTryDispatch = (campaignId: string) => {
    setBusyCampaignId(campaignId)
    setDispatchResultByCampaign((prev) => ({ ...prev, [campaignId]: undefined as any }))
    startBusy(async () => {
      const result = await dispatchChatgptCampaignAction(campaignId)
      setBusyCampaignId(null)
      const reviewStatus = "reviewStatus" in result ? result.reviewStatus ?? null : null
      setDispatchResultByCampaign((prev) => ({
        ...prev,
        [campaignId]: { dispatched: result.dispatched, reason: result.reason, reviewStatus },
      }))
      if (result.dispatched) {
        toast.success("Active on ChatGPT Ads")
        if (launchPackage?.campaignId === campaignId) setLaunchPackage(null)
        router.refresh()
      } else {
        // Real OpenAI Ads error (or not connected) — surfaced honestly; the
        // manual ads.openai.com + Mark-as-launched path remains available.
        toast.error(`Launch failed: ${result.reason}`)
      }
    })
  }

  const handleImportPerformance = (campaignId: string) => {
    const csv = csvByCampaign[campaignId]?.trim()
    if (!csv) {
      toast.error("Paste the Ads Manager report CSV first")
      return
    }
    setBusyCampaignId(campaignId)
    setImportErrorByCampaign((prev) => ({ ...prev, [campaignId]: "" }))
    startBusy(async () => {
      const result = await importChatgptPerformanceAction(campaignId, csv)
      setBusyCampaignId(null)
      if (result.success && result.row) {
        setImportedRowByCampaign((prev) => ({ ...prev, [campaignId]: result.row! }))
        toast.success("Performance imported")
        router.refresh()
      } else {
        setImportErrorByCampaign((prev) => ({ ...prev, [campaignId]: result.error || "Import failed" }))
        toast.error(result.error || "Import failed")
      }
    })
  }

  return (
    <div className="space-y-4">
      {/* Lane header + honesty contract */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Sparkles className="h-5 w-5" />
                ChatGPT Ads
              </CardTitle>
              <CardDescription>
                {openaiAdsConnected
                  ? "OpenAI Advertiser API connected — approved campaigns launch from here (and the Ads Manager proposes launches automatically)."
                  : `No OpenAI Ads API key connected — paste the key from ads.openai.com → Settings into Settings → Integrations → Lead sources & connections (/dashboard/settings/integrations/lead-sources, "ChatGPT Ads"); until then use the package below at ${CHATGPT_ADS_MANAGER_URL} by hand.`}
              </CardDescription>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Badge className={openaiAdsConnected ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}>
                {openaiAdsConnected ? "OpenAI Ads API connected" : "No OpenAI Ads API key"}
              </Badge>
              <Button variant="outline" size="sm" asChild>
                <a href={CHATGPT_ADS_MANAGER_URL} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-1" />
                  Open Ads Manager
                </a>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {openaiAdsConnected
            ? "The OS validates the copy for Fair Housing before it is written down, stages the campaign and creative, then launches through the OpenAI Advertiser API once the creative is approved — account, geo targeting, ad group, ad, and activation, no trip to ads.openai.com needed."
            : "The OS validates the copy for Fair Housing before it is written down, stages the campaign and creative, and hands you a complete launch package with a bulk-upload CSV. Launch happens at ads.openai.com; confirm it here and import the report CSV to feed real cost-per-lead back into the Ads Manager."}
        </CardContent>
      </Card>

      {/* Stage a new ChatGPT campaign */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Stage a ChatGPT Campaign</CardTitle>
          <CardDescription>Pick a listing and a moment; the OS writes the copy and the targeting.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {listings.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <ImageIcon className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium">No active listings yet</p>
              <p className="text-xs mt-1">Stage a ChatGPT ad once you have an active listing.</p>
            </div>
          ) : (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Listing</Label>
                  <Select value={listingId} onValueChange={setListingId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a listing" />
                    </SelectTrigger>
                    <SelectContent>
                      {listings.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {listingLabel(l)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Moment</Label>
                  <Select value={kind} onValueChange={(v) => setKind(v as ListingAdKind)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MOMENT_OPTIONS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Objective</Label>
                  <Select value={objective} onValueChange={(v) => setObjective(v as ChatgptObjective)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHATGPT_OBJECTIVES.map((o) => (
                        <SelectItem key={o} value={o}>
                          {o.charAt(0).toUpperCase() + o.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Daily budget (USD, min ${CHATGPT_MIN_DAILY_BUDGET_USD})</Label>
                  <Input
                    type="number"
                    min={CHATGPT_MIN_DAILY_BUDGET_USD}
                    step="1"
                    value={dailyBudget}
                    onChange={(e) => setDailyBudget(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Campaign name (optional)</Label>
                  <Input
                    placeholder="ChatGPT — Just Listed — 123 Main St"
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Extra context hints (comma-separated, optional)</Label>
                  <Input
                    placeholder="relocating to the area, first-time buyer resources"
                    value={extraHints}
                    onChange={(e) => setExtraHints(e.target.value)}
                  />
                </div>
              </div>
              {stageError && (
                <p className="flex items-start gap-2 text-xs text-red-600">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  {stageError}
                </p>
              )}
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
              Launch Package — ready for {CHATGPT_ADS_MANAGER_URL}
            </CardTitle>
            <CardDescription>
              {launchPackage.locations.join(" · ")} · ${launchPackage.dailyBudgetUsd}/day · max CPC ${launchPackage.maxCpcUsd}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-medium text-muted-foreground">Headline</div>
                <div>{launchPackage.headline}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">Description</div>
                <div>{launchPackage.description}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">Context hints</div>
                <div>{launchPackage.contextHints.join(", ")}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">Destination URL</div>
                <div className="break-all">{launchPackage.destinationUrl}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">Image</div>
                {launchPackage.imageUrl ? (
                  <a href={launchPackage.imageUrl} target="_blank" rel="noopener noreferrer" className="break-all underline">
                    {launchPackage.imageUrl}
                  </a>
                ) : (
                  <span className="text-amber-600">No listing photo on file — add one before upload.</span>
                )}
              </div>
            </div>

            {launchPackage.warnings.length > 0 && (
              <ul className="space-y-1 text-xs text-amber-600">
                {launchPackage.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    {w}
                  </li>
                ))}
              </ul>
            )}

            <ol className="list-decimal list-inside space-y-1 text-sm">
              {launchPackage.checklist.map((step, i) => (
                <li key={i} className="text-muted-foreground">
                  {step}
                </li>
              ))}
            </ol>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyText(launchPackage.bulkUploadCsv, "Bulk-upload CSV")}
              >
                <Copy className="h-4 w-4 mr-1" />
                Copy bulk-upload CSV
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={launchPackage.adsManagerUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-1" />
                  Open Ads Manager
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
            </div>
          </CardContent>
        </Card>
      )}

      {/* Existing ChatGPT campaigns */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">ChatGPT Campaigns ({chatgptCampaigns.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {chatgptCampaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No ChatGPT campaigns staged yet.</p>
          ) : (
            chatgptCampaigns.map((c) => {
              const tc = (c.targeting_config ?? {}) as Record<string, unknown>
              const locations = Array.isArray(tc.locations) ? (tc.locations as string[]) : []
              const importedRow = importedRowByCampaign[c.id]
              const importError = importErrorByCampaign[c.id]
              return (
                <div key={c.id} className="border rounded-lg p-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{c.campaign_name || "Untitled campaign"}</span>
                        <Badge
                          className={c.status === "live" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}
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
                        {locations.length ? locations.join(" · ") : "No geography recorded"}
                        {c.daily_budget != null && ` · $${Number(c.daily_budget).toLocaleString()}/day`}
                      </p>
                    </div>
                  </div>

                  {c.status === "draft" && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {openaiAdsConnected && (
                          <Button
                            size="sm"
                            className="bg-violet-600 hover:bg-violet-700"
                            onClick={() => handleTryDispatch(c.id)}
                            disabled={busyCampaignId === c.id}
                          >
                            {busyCampaignId === c.id ? (
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : (
                              <Send className="h-4 w-4 mr-1" />
                            )}
                            Launch on ChatGPT now
                          </Button>
                        )}
                        <Input
                          placeholder="Ads Manager campaign id (optional)"
                          className="max-w-xs h-8 text-xs"
                          value={externalIdByCampaign[c.id] ?? ""}
                          onChange={(e) => setExternalIdByCampaign((prev) => ({ ...prev, [c.id]: e.target.value }))}
                        />
                        <Button size="sm" onClick={() => handleMarkLaunched(c.id)} disabled={busyCampaignId === c.id}>
                          {busyCampaignId === c.id ? (
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          ) : (
                            <CheckCircle className="h-4 w-4 mr-1" />
                          )}
                          Mark as launched
                        </Button>
                      </div>
                      {dispatchResultByCampaign[c.id] && (
                        dispatchResultByCampaign[c.id].dispatched ? (
                          <p className="flex items-start gap-2 text-xs text-emerald-600">
                            <CheckCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            Active on OpenAI Ads
                            {dispatchResultByCampaign[c.id].reviewStatus
                              ? ` — review status: ${dispatchResultByCampaign[c.id].reviewStatus}`
                              : ""}
                          </p>
                        ) : (
                          <p className="flex items-start gap-2 text-xs text-red-600">
                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            {dispatchResultByCampaign[c.id].reason}
                          </p>
                        )
                      )}
                    </div>
                  )}

                  {c.status === "live" && (
                    <div className="space-y-2">
                      <Textarea
                        placeholder="Paste the Ads Manager report CSV export here"
                        className="text-xs font-mono"
                        rows={3}
                        value={csvByCampaign[c.id] ?? ""}
                        onChange={(e) => setCsvByCampaign((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleImportPerformance(c.id)}
                          disabled={busyCampaignId === c.id}
                        >
                          {busyCampaignId === c.id ? (
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          ) : (
                            <Sparkles className="h-4 w-4 mr-1" />
                          )}
                          Import report CSV
                        </Button>
                      </div>
                      {importError && (
                        <p className="flex items-start gap-2 text-xs text-red-600">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          {importError}
                        </p>
                      )}
                      {importedRow && (
                        <p className="text-xs text-muted-foreground">
                          Spend ${importedRow.spend.toLocaleString()} · {importedRow.impressions.toLocaleString()} impressions ·{" "}
                          {importedRow.clicks.toLocaleString()} clicks · {importedRow.leads.toLocaleString()} leads · CPL{" "}
                          {importedRow.costPerLead != null ? `$${importedRow.costPerLead.toFixed(2)}` : "n/a"}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
    </div>
  )
}
