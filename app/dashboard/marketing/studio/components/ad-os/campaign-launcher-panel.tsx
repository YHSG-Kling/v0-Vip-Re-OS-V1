"use client"

// ============================================================
// Campaign Launcher Panel
// Creates listing campaigns with an inline Pre-Launch check
// gate before the final Launch button.
// ============================================================

import { useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, Rocket, TrendingUp, CheckCircle, AlertTriangle, XCircle } from "lucide-react"
import { launchListingCampaign } from "./ad-os-actions"
import { runPrelaunchCheck } from "./ad-os-actions"

interface Listing {
  id: string
  address: string
  city: string
  zip?: string
  list_price?: number
}

interface Props {
  listings: Listing[]
  agentId: string
  brokerageId?: string
  onCampaignCreated: () => void
}

type Stage = "form" | "predicting" | "predicted" | "launching" | "done"

/** Discriminates which tab/mode the campaign launcher is operating in. */
export type CampaignMode = "listing" | "brand" | "recruitment" | "event" | "seasonal"

const CAMPAIGN_TYPES = [
  { value: "listing", label: "Listing Campaign" },
  { value: "brand", label: "Brand Awareness" },
  { value: "seasonal", label: "Seasonal" },
  { value: "event", label: "Event" },
  { value: "recruitment", label: "Recruitment" },
]

export function CampaignLauncherPanel({ listings, agentId, brokerageId, onCampaignCreated }: Props) {
  const [campaignName, setCampaignName] = useState("")
  const [campaignType, setCampaignType] = useState<"listing" | "brand" | "recruitment" | "event" | "seasonal">("listing")
  const [budgetTotal, setBudgetTotal] = useState<number>(500)
  const [selectedListingId, setSelectedListingId] = useState<string>("")
  const [previewContent, setPreviewContent] = useState("")
  const [platform, setPlatform] = useState("facebook")
  const [stage, setStage] = useState<Stage>("form")
  const [prediction, setPrediction] = useState<{
    predicted_score: number
    rationale: string
    confidence: string
    recommended_publish_window: { day: string; hour: number }
  } | null>(null)
  const [readinessStatus, setReadinessStatus] = useState<"ready" | "blocked" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [complianceBlockers, setComplianceBlockers] = useState<string[]>([])
  const [complianceWarnings, setComplianceWarnings] = useState<string[]>([])

  const selectedListing = listings.find((l) => l.id === selectedListingId)

  async function handlePredict() {
    if (!campaignName.trim()) return
    setStage("predicting")
    setError(null)

    const content =
      previewContent.trim() ||
      `New campaign: ${campaignName}${selectedListing ? ` for ${selectedListing.address}, ${selectedListing.city}` : ""}`

    const res = await runPrelaunchCheck({
      contentText: content,
      contentType: "ad_creative",
      platform,
    })

    if (!res.success) {
      setError(res.error ?? "Prediction failed")
      setStage("form")
      return
    }

    setPrediction(res.prediction ?? null)
    setReadinessStatus(res.readiness?.readiness_status ?? null)
    setStage("predicted")
  }

  async function handleLaunch() {
    setStage("launching")
    setError(null)
    setComplianceBlockers([])
    setComplianceWarnings([])

    const adCopyText =
      previewContent.trim() ||
      `New campaign: ${campaignName}${selectedListing ? ` for ${selectedListing.address}, ${selectedListing.city}` : ""}`

    const res = await launchListingCampaign({
      campaignName: campaignName.trim(),
      campaignType,
      budgetTotal,
      listingId: selectedListingId || undefined,
      adCopyText,
      brokerageId: brokerageId ?? undefined,
    })

    if (!res.success) {
      if ((res as any).complianceBlocked) {
        setComplianceBlockers((res as any).blockers ?? [])
        setComplianceWarnings((res as any).warnings ?? [])
      } else {
        setError(res.error ?? "Launch failed")
      }
      setStage("predicted")
      return
    }

    setStage("done")
    onCampaignCreated()
  }

  function handleReset() {
    setCampaignName("")
    setCampaignType("listing")
    setBudgetTotal(500)
    setSelectedListingId("")
    setPreviewContent("")
    setPlatform("facebook")
    setPrediction(null)
    setReadinessStatus(null)
    setStage("form")
    setError(null)
    setComplianceBlockers([])
    setComplianceWarnings([])
  }

  if (stage === "done") {
    return (
      <Card className="border-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-violet-600" />
            Campaign Launcher
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 py-8">
          <CheckCircle className="h-12 w-12 text-green-600" />
          <p className="text-lg font-semibold">Campaign Created!</p>
          <p className="text-sm text-muted-foreground text-center">
            {campaignName} has been created and is ready for asset assignment.
          </p>
          <Button variant="outline" onClick={handleReset}>
            Launch Another
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-violet-600" />
          Campaign Launcher
        </CardTitle>
        <CardDescription>
          Create a new campaign with a performance check before launch.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Form fields */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Campaign Name</Label>
            <Input
              placeholder="Spring Listings Push"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              className="h-8 text-sm"
              disabled={stage !== "form"}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Type</Label>
              <Select
                value={campaignType}
                onValueChange={(v) => setCampaignType(v as any)}
                disabled={stage !== "form"}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAMPAIGN_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Budget ($)</Label>
              <Input
                type="number"
                min={0}
                value={budgetTotal}
                onChange={(e) => setBudgetTotal(Number(e.target.value))}
                className="h-8 text-sm"
                disabled={stage !== "form"}
              />
            </div>
          </div>

          {listings.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Linked Listing (optional)</Label>
              <Select
                value={selectedListingId}
                onValueChange={setSelectedListingId}
                disabled={stage !== "form"}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="No specific listing" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No specific listing</SelectItem>
                  {listings.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.address}, {l.city}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Primary Platform</Label>
            <Select value={platform} onValueChange={setPlatform} disabled={stage !== "form"}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["facebook", "instagram", "linkedin", "google_ads", "email"].map((p) => (
                  <SelectItem key={p} value={p} className="capitalize">
                    {p.replace("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Predict button (gate before launch) */}
        {stage === "form" && (
          <Button
            onClick={handlePredict}
            disabled={!campaignName.trim()}
            variant="outline"
            className="w-full border-violet-300 text-violet-700 hover:bg-violet-50"
          >
            <TrendingUp className="mr-2 h-4 w-4" />
            Predict Performance Before Launch
          </Button>
        )}

        {stage === "predicting" && (
          <div className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Running pre-launch check...
          </div>
        )}

        {/* Prediction results gate */}
        {(stage === "predicted" || stage === "launching") && prediction && (
          <div className="border rounded-lg p-3 bg-muted/30 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Pre-Launch Check
              </span>
              {readinessStatus === "ready" ? (
                <Badge className="bg-green-100 text-green-800 border-green-200 flex items-center gap-1 text-xs">
                  <CheckCircle className="h-3 w-3" />
                  Ready
                </Badge>
              ) : readinessStatus === "blocked" ? (
                <Badge className="bg-red-100 text-red-800 border-red-200 flex items-center gap-1 text-xs">
                  <XCircle className="h-3 w-3" />
                  Blocked
                </Badge>
              ) : (
                <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200 flex items-center gap-1 text-xs">
                  <AlertTriangle className="h-3 w-3" />
                  Review Needed
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-3">
              <div className={`text-3xl font-bold ${prediction.predicted_score >= 70 ? "text-green-600" : prediction.predicted_score >= 45 ? "text-yellow-600" : "text-red-600"}`}>
                {prediction.predicted_score}
                <span className="text-sm text-muted-foreground font-normal">/100</span>
              </div>
              <div className="flex-1 text-xs text-muted-foreground italic leading-relaxed">
                {prediction.rationale}
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Best publish time: {prediction.recommended_publish_window.day} at{" "}
              {prediction.recommended_publish_window.hour}:00 &middot; Confidence: {prediction.confidence}
            </p>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-md p-2">{error}</p>
        )}

        {complianceBlockers.length > 0 && (
          <div className="rounded border border-red-200 bg-red-50 p-3">
            <p className="text-sm font-semibold text-red-800 mb-1">Compliance issues — fix before launching</p>
            {complianceBlockers.map((b) => (
              <p key={b} className="text-xs text-red-700 flex items-start gap-1 mt-1">
                <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                {b}
              </p>
            ))}
          </div>
        )}

        {complianceWarnings.length > 0 && complianceBlockers.length === 0 && (
          <div className="rounded border border-yellow-200 bg-yellow-50 p-3">
            <p className="text-sm font-semibold text-yellow-800 mb-1">Compliance warnings — review before launching</p>
            {complianceWarnings.map((w) => (
              <p key={w} className="text-xs text-yellow-700 flex items-start gap-1 mt-1">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                {w}
              </p>
            ))}
          </div>
        )}

        {/* Launch button — only visible after prediction */}
        {stage === "predicted" && (
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={handleReset}
              className="flex-1"
            >
              Back
            </Button>
            <Button
              onClick={handleLaunch}
              className="flex-1 bg-violet-600 hover:bg-violet-700"
            >
              <Rocket className="mr-2 h-4 w-4" />
              Launch Campaign
            </Button>
          </div>
        )}

        {stage === "launching" && (
          <Button disabled className="w-full bg-violet-600">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Launching...
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
