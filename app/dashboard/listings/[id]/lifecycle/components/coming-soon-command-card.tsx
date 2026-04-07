"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Loader2, Sparkles, Radio, CheckCircle, Clock, ArrowRight } from "lucide-react"
import { prepareComingSoonAssets, activateComingSoon } from "@/app/actions/seller-listing/execution-engine"
import { createListingPosts } from "@/app/actions/social-media-automation"
import { prepareListingEmailCampaign } from "@/app/actions/email-campaign-automation"
import { generateComingSoonContent } from "@/app/actions/coming-soon-content"
import Link from "next/link"

interface ComingSoonCommandCardProps {
  listingId: string
  userId: string
  brokerageId: string
  role: "agent" | "team_lead" | "admin" | "broker"
  currentStage: string
  listingAddress: string
  listingStatus: string
  mediaApproved: boolean
  transactionId?: string | null
}

type Phase = "prep" | "active" | "complete"

function computePhase(stage: string): Phase {
  if (stage === "COMING_SOON_ACTIVE") return "active"
  if (stage === "ACTIVE" || stage === "UNDER_CONTRACT" || stage === "SOLD") return "complete"
  return "prep"
}

const PLATFORMS = [
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "linkedin", label: "LinkedIn" },
] as const

export function ComingSoonCommandCard({
  listingId,
  userId,
  brokerageId,
  role,
  currentStage,
  listingAddress,
  listingStatus,
  mediaApproved,
  transactionId,
}: ComingSoonCommandCardProps) {
  const phase = computePhase(currentStage)

  const [isPreparing, startPreparing] = useTransition()
  const [isActivating, startActivating] = useTransition()
  const [isGenerating, startGenerating] = useTransition()
  const [isSendingEmail, startSendingEmail] = useTransition()

  const [daysUntilLaunch, setDaysUntilLaunch] = useState(7)
  const [socialPost, setSocialPost] = useState("")
  const [emailBody, setEmailBody] = useState("")
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(["facebook", "instagram"])
  const [toastMessage, setToastMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)
  const [currentPhase, setCurrentPhase] = useState<Phase>(phase)

  const launchDate = new Date()
  launchDate.setDate(launchDate.getDate() + daysUntilLaunch)
  const launchDateStr = launchDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

  const resolvedRole: "agent" | "team_lead" =
    role === "admin" || role === "broker" ? "team_lead" : role

  function showToast(type: "success" | "error", text: string) {
    setToastMessage({ type, text })
    setTimeout(() => setToastMessage(null), 5000)
  }

  function togglePlatform(id: string) {
    setSelectedPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    )
  }

  function handlePrepare() {
    startPreparing(async () => {
      const result = await prepareComingSoonAssets({ listingId, userId, brokerageId })
      if (result.success) {
        showToast("success", "Assets prepared! Review and activate when ready.")
        setCurrentPhase("prep")
      } else {
        showToast("error", result.error ?? "Failed to prepare assets.")
      }
    })
  }

  function handleGenerateContent() {
    startGenerating(async () => {
      const result = await generateComingSoonContent({
        agentId: userId,
        listingAddress,
        daysUntilLaunch,
        launchDateStr,
      })
      if (result.success) {
        setSocialPost(result.socialPost ?? "")
        setEmailBody(result.emailBody ?? "")
        showToast("success", "AI content generated — review and edit before activating.")
      } else {
        showToast("error", "AI generation failed. Enter content manually.")
      }
    })
  }

  function handleActivate() {
    startActivating(async () => {
      const result = await activateComingSoon({ listingId, userId, brokerageId, role: resolvedRole })

      if (!result.success) {
        showToast("error", result.error ?? "Activation failed.")
        return
      }

      // Fire marketing in parallel — non-blocking failures
      const marketing: Promise<any>[] = []

      if (selectedPlatforms.length > 0) {
        marketing.push(
          createListingPosts({ propertyId: listingId, agentId: userId, brokerageId, platforms: selectedPlatforms })
            .catch(() => null)
        )
      }

      if (transactionId) {
        marketing.push(
          prepareListingEmailCampaign({ transactionId, campaignType: "coming_soon" })
            .catch(() => null)
        )
      }

      await Promise.allSettled(marketing)

      showToast("success", "Coming Soon is LIVE! Marketing is being distributed.")
      setCurrentPhase("active")
    })
  }

  function handleEmailCampaign() {
    if (!transactionId) return
    startSendingEmail(async () => {
      const result = await prepareListingEmailCampaign({ transactionId, campaignType: "coming_soon" })
      if (result.success) {
        showToast("success", "Email campaign sent to matching buyers.")
      } else {
        showToast("error", "Email campaign failed.")
      }
    })
  }

  // ─── Phase: COMPLETE ─────────────────────────────────────────────────────────
  if (currentPhase === "complete") {
    return (
      <Card className="border border-border">
        <CardContent className="p-5 flex items-center gap-3">
          <CheckCircle className="h-5 w-5 text-emerald-600 shrink-0" />
          <div className="flex-1">
            <p className="font-medium text-sm">Listing went active</p>
            <p className="text-xs text-muted-foreground">{listingAddress}</p>
          </div>
          <Link href={`/dashboard/listings/${listingId}`}>
            <Button variant="outline" size="sm" className="gap-1">
              View Active Listing <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Toast */}
      {toastMessage && (
        <div
          className={`rounded-lg px-4 py-3 text-sm font-medium ${
            toastMessage.type === "success"
              ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {toastMessage.text}
        </div>
      )}

      {/* Header Card */}
      <div className="rounded-xl bg-gradient-to-r from-indigo-600 to-purple-700 text-white p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-lg font-bold leading-tight">Coming Soon Launch</h2>
            <p className="text-sm text-white/85">{listingAddress}</p>
            <div className="mt-2">
              {currentPhase === "prep" && currentStage === "COMING_SOON_PREP" ? (
                <Badge className="bg-amber-400/20 text-amber-200 border border-amber-300/30 text-xs">
                  Preparing Assets
                </Badge>
              ) : currentPhase === "active" ? (
                <Badge className="bg-emerald-400/20 text-emerald-200 border border-emerald-300/30 text-xs flex items-center gap-1 w-fit">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-300 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                  </span>
                  Coming Soon — Live
                </Badge>
              ) : (
                <Badge className="bg-white/10 text-white/70 border border-white/20 text-xs">
                  Not Started
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Phase: NOT STARTED */}
      {currentPhase === "prep" && currentStage !== "COMING_SOON_PREP" && (
        <Card>
          <CardContent className="p-5 space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Build anticipation before going active</p>
              <p className="text-sm text-muted-foreground">
                AI will create social content, buyer emails, and marketing materials automatically.
              </p>
            </div>

            <div className="flex items-center gap-2">
              {mediaApproved ? (
                <span className="text-sm text-emerald-700 flex items-center gap-1.5">
                  <CheckCircle className="h-4 w-4" />
                  Media approved — ready to prepare
                </span>
              ) : (
                <span className="text-sm text-amber-700 flex items-center gap-1.5">
                  <Clock className="h-4 w-4" />
                  Media must be approved first
                </span>
              )}
            </div>

            <Button
              onClick={handlePrepare}
              disabled={!mediaApproved || isPreparing}
              className="w-full"
            >
              {isPreparing ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" />Preparing...</>
              ) : (
                "Prepare Coming Soon Assets"
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Phase: PREP (COMING_SOON_PREP) */}
      {currentPhase === "prep" && currentStage === "COMING_SOON_PREP" && (
        <div className="space-y-4">
          {/* AI Content Generator */}
          <Card>
            <CardHeader className="pb-2">
              <p className="font-medium text-sm">AI Content Generator</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-sm">Days until MLS launch</Label>
                  <span className="text-sm font-medium text-primary">
                    {daysUntilLaunch} days — Going live {launchDateStr}
                  </span>
                </div>
                <Slider
                  value={[daysUntilLaunch]}
                  onValueChange={([v]) => setDaysUntilLaunch(v)}
                  min={3}
                  max={21}
                  step={1}
                />
              </div>

              <Button
                variant="outline"
                onClick={handleGenerateContent}
                disabled={isGenerating}
                className="w-full gap-2"
              >
                {isGenerating ? (
                  <><Loader2 className="h-4 w-4 animate-spin" />Generating...</>
                ) : (
                  <><Sparkles className="h-4 w-4" />Generate AI Coming Soon Content</>
                )}
              </Button>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Social post (edit before publishing)</Label>
                <Textarea
                  rows={3}
                  value={socialPost}
                  onChange={(e) => setSocialPost(e.target.value)}
                  placeholder="Social post content will appear here after generation..."
                  className="resize-none text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Email teaser (edit before sending)</Label>
                <Textarea
                  rows={4}
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  placeholder="Email teaser will appear here after generation..."
                  className="resize-none text-sm"
                />
              </div>
            </CardContent>
          </Card>

          {/* Platform Selection */}
          <Card>
            <CardHeader className="pb-2">
              <p className="font-medium text-sm">Send Coming Soon Marketing</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="email-channel"
                  checked={!!transactionId}
                  disabled
                />
                <Label htmlFor="email-channel" className="text-sm">
                  Email — Matching buyers in your pipeline
                  {!transactionId && (
                    <span className="text-xs text-muted-foreground ml-1">(requires transaction)</span>
                  )}
                </Label>
              </div>

              {PLATFORMS.map(({ id, label }) => (
                <div key={id} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={selectedPlatforms.includes(id)}
                    onCheckedChange={() => togglePlatform(id)}
                  />
                  <Label htmlFor={id} className="text-sm">{label}</Label>
                </div>
              ))}

              <p className="text-xs text-muted-foreground">
                Will reach {selectedPlatforms.length + (transactionId ? 1 : 0)} channel
                {selectedPlatforms.length + (transactionId ? 1 : 0) !== 1 ? "s" : ""}
              </p>
            </CardContent>
          </Card>

          {/* Activate Button */}
          <Card>
            <CardContent className="p-5">
              <Button
                size="lg"
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
                onClick={handleActivate}
                disabled={isActivating}
              >
                {isActivating ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Activating...</>
                ) : (
                  "Activate Coming Soon"
                )}
              </Button>
              <p className="text-xs text-muted-foreground text-center mt-2">
                Marketing will distribute immediately on activation
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Phase: ACTIVE */}
      {currentPhase === "active" && (
        <div className="space-y-4">
          {/* Live Status */}
          <Card className="border-emerald-200 bg-emerald-50">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center gap-3">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
                </span>
                <p className="font-medium text-emerald-900">Coming Soon is LIVE</p>
              </div>
              <div className="flex items-center gap-2 text-sm text-emerald-800">
                <Clock className="h-4 w-4" />
                <span>Launched and distributing to buyer pipeline</span>
              </div>
              <div className="flex gap-2 flex-wrap">
                {transactionId && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleEmailCampaign}
                    disabled={isSendingEmail}
                    className="border-emerald-300 text-emerald-800 hover:bg-emerald-100"
                  >
                    {isSendingEmail ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <Radio className="h-3 w-3 mr-1" />
                    )}
                    Email Matching Buyers
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="border-emerald-300 text-emerald-800 hover:bg-emerald-100"
                  onClick={() =>
                    createListingPosts({
                      propertyId: listingId,
                      agentId: userId,
                      brokerageId,
                      platforms: ["facebook", "instagram"],
                    }).catch(() => null)
                  }
                >
                  <Radio className="h-3 w-3 mr-1" />
                  Share on Social
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
