"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Mail, Video, FileText, Phone, MessageSquare, PlayCircle, PauseCircle, TestTube, Rocket, CheckCircle2 } from "lucide-react"
import { toggleCampaignStatus, sendCampaignTestTouch, launchAIISACampaign, completeISACampaign } from "@/app/actions/ai-isa"
import type { ISACampaignRow } from "@/app/actions/ai-isa"

const TYPE_BADGE: Record<string, string> = {
  fsbo:           "bg-orange-100 text-orange-800 border-orange-300",
  buyer_match:    "bg-blue-100 text-blue-800 border-blue-300",
  divorce:        "bg-red-100 text-red-800 border-red-300",
  foreclosure:    "bg-purple-100 text-purple-800 border-purple-300",
  ghost_recovery: "bg-yellow-100 text-yellow-800 border-yellow-300",
  social_intent:  "bg-pink-100 text-pink-800 border-pink-300",
  search_intent:  "bg-teal-100 text-teal-800 border-teal-300",
}

const CHANNEL_ICON: Record<string, React.ReactNode> = {
  email:        <Mail className="h-4 w-4 text-blue-500" />,
  video:        <Video className="h-4 w-4 text-purple-500" />,
  direct_mail:  <FileText className="h-4 w-4 text-green-600" />,
  phone:        <Phone className="h-4 w-4 text-gray-500" />,
  sms:          <MessageSquare className="h-4 w-4 text-teal-500" />,
}

interface Props {
  campaign: ISACampaignRow
  onStatusChange: () => void
}

export function CampaignCard({ campaign, onStatusChange }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [launchResult, setLaunchResult] = useState<{ ok: boolean; text: string } | null>(null)

  const rate = campaign.leads_targeted > 0
    ? ((campaign.conversions / campaign.leads_targeted) * 100).toFixed(1)
    : "0.0"

  async function handleToggle() {
    setLoading(true)
    await toggleCampaignStatus(campaign.id, campaign.status)
    setLoading(false)
    onStatusChange()
  }

  // Retire the campaign. This card already GREYED the badge and disabled both
  // Launch and Pause on status === "completed" (below) while nothing in the
  // tree could produce that status — the terminal state was decorative. The
  // writer is app/actions/ai-isa.ts:completeISACampaign (session-gated,
  // brokerage-pinned). One-way, hence the confirm.
  async function handleComplete() {
    if (!confirm(`Mark “${campaign.name}” completed? A completed campaign can no longer be launched or resumed.`)) return
    setCompleting(true)
    const result = await completeISACampaign(campaign.id)
    setCompleting(false)
    if (result.success) onStatusChange()
    else setLaunchResult({ ok: false, text: result.error ?? "Could not complete campaign." })
  }

  // Launch = resolve this campaign type's contact segment and ENROLL it into
  // the matching compliance-gated sequence cadence (never dials). The result
  // reports honest per-contact counts: enrolled / already in cadence /
  // consent-skipped / refused.
  async function handleLaunch() {
    setLaunching(true)
    setLaunchResult(null)
    const result = await launchAIISACampaign({
      campaignId:   campaign.id,
      campaignType: campaign.campaign_type,
    })
    if (result.success) {
      const parts = [`Enrolled ${result.enrolled ?? 0}`]
      if (result.alreadyEnrolled) parts.push(`${result.alreadyEnrolled} already in cadence`)
      if (result.skipped) {
        const reasons = Object.entries(result.skipReasons ?? {})
          .map(([r, n]) => `${n} ${r}`)
          .join(", ")
        parts.push(`${result.skipped} skipped${reasons ? ` (${reasons})` : ""}`)
      }
      if (result.errors?.length) parts.push(`${result.errors.length} refused: ${result.errors[0]}`)
      setLaunchResult({
        ok: true,
        text: `${parts.join(" · ")} — sequence “${result.sequenceName ?? result.sequenceId}”.`,
      })
      onStatusChange()
    } else {
      setLaunchResult({ ok: false, text: result.error ?? "Launch failed." })
    }
    setLaunching(false)
  }

  async function handleTestTouch() {
    setTestLoading(true)
    setTestResult(null)
    const primaryChannel = campaign.channels?.[0] as "email" | "video" | "direct_mail" | "sms" ?? "email"
    const result = await sendCampaignTestTouch({
      campaignId:         campaign.id,
      brokerageId:        campaign.brokerage_id,
      channel:            primaryChannel,
      testRecipientEmail: "test@platform.internal",
      testRecipientName:  "Test User",
    })
    setTestResult(result.success ? "Test sent." : result.error ?? "Failed")
    setTestLoading(false)
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold text-foreground leading-tight">{campaign.name}</h3>
          <span className={`inline-flex w-fit items-center rounded border px-2 py-0.5 text-xs font-medium ${TYPE_BADGE[campaign.campaign_type] ?? ""}`}>
            {campaign.campaign_type.replace("_", " ")}
          </span>
        </div>
        <span className={`text-xs font-medium px-2 py-1 rounded-full ${
          campaign.status === "active"    ? "bg-green-100 text-green-700" :
          campaign.status === "paused"    ? "bg-yellow-100 text-yellow-700" :
          campaign.status === "completed" ? "bg-gray-100 text-gray-600"  :
          "bg-slate-100 text-slate-600"
        }`}>
          {campaign.status.toUpperCase()}
        </span>
      </div>

      {/* Channel icons — clickable to open campaign settings for that channel */}
      <div className="flex items-center gap-2">
        {(campaign.channels ?? []).map((ch) => (
          <button
            key={ch}
            title={`Configure ${ch} channel`}
            className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
            onClick={() => router.push(`/dashboard/isa/campaigns/${campaign.id}?channel=${ch}`)}
          >
            {CHANNEL_ICON[ch] ?? null}
          </button>
        ))}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-lg font-bold text-foreground">{campaign.leads_targeted}</p>
          <p className="text-xs text-muted-foreground">Leads</p>
        </div>
        <div>
          <p className="text-lg font-bold text-foreground">{campaign.touches_sent}</p>
          <p className="text-xs text-muted-foreground">Touches</p>
        </div>
        <div>
          <p className="text-lg font-bold text-foreground">{rate}%</p>
          <p className="text-xs text-muted-foreground">Conv.</p>
        </div>
      </div>

      {/* Sequence preview dots */}
      <div className="flex items-center gap-1">
        {(campaign.channels ?? []).map((ch, i) => (
          <div
            key={`${ch}-${i}`}
            className="h-2 w-2 rounded-full bg-primary opacity-70"
            title={`Step ${i + 1}: ${ch}`}
          />
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          size="sm"
          className="flex-1 gap-1"
          onClick={handleLaunch}
          disabled={launching || campaign.status === "completed"}
          title="Enroll this type's matching contacts into the sequence cadence — no calls are placed"
        >
          <Rocket className="h-3.5 w-3.5" />
          {launching ? "Launching…" : campaign.status === "draft" ? "Launch campaign" : "Enroll matches"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 gap-1"
          onClick={handleToggle}
          disabled={loading || campaign.status === "completed"}
        >
          {campaign.status === "active"
            ? <><PauseCircle className="h-3.5 w-3.5" /> Pause</>
            : <><PlayCircle className="h-3.5 w-3.5" /> Resume</>
          }
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1"
          onClick={handleTestTouch}
          disabled={testLoading}
        >
          <TestTube className="h-3.5 w-3.5" /> Test
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1"
          onClick={handleComplete}
          disabled={completing || campaign.status === "completed" || campaign.status === "draft"}
          title="Retire this campaign — it can no longer be launched or resumed"
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> {completing ? "…" : "Complete"}
        </Button>
      </div>
      {launchResult && (
        <p className={launchResult.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
          {launchResult.text}
        </p>
      )}
      {testResult && (
        <p className="text-xs text-muted-foreground">{testResult}</p>
      )}
    </div>
  )
}
