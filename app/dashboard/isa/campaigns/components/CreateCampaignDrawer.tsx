"use client"

import { useEffect, useState, useTransition } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Mail, MessageSquare, FileText, Phone, Voicemail, Bell } from "lucide-react"
import { createISACampaign, updateISACampaign, type CampaignType, type ISACampaignRow } from "@/app/actions/ai-isa"
import {
  OUTREACH_CHANNELS, VIDEO_OUTREACH_CHANNELS, channelCarriesVideo,
  type CampaignChannelKey,
} from "@/lib/campaigns/channels"

const CHANNEL_ICON: Record<string, React.ReactNode> = {
  email:       <Mail className="h-4 w-4 text-blue-500" />,
  sms:         <MessageSquare className="h-4 w-4 text-green-500" />,
  phone:       <Phone className="h-4 w-4 text-gray-500" />,
  voice_drop:  <Voicemail className="h-4 w-4 text-indigo-500" />,
  in_app:      <Bell className="h-4 w-4 text-sky-500" />,
  direct_mail: <FileText className="h-4 w-4 text-orange-500" />,
}

const CHANNEL_DESCRIPTION: Record<string, string> = {
  sms:         "TCPA consent required per contact",
  phone:       "TCPA consent required — the AI places the call",
  voice_drop:  "Ringless voicemail — TCPA gated, needs an active voicedrop preset",
  in_app:      "Portal notification — no carrier, no postage, already consented",
  direct_mail: "Personalized postcard (Lob)",
}

const CAMPAIGN_TYPES: { value: CampaignType; label: string }[] = [
  { value: "fsbo", label: "FSBO" },
  { value: "buyer_match", label: "Buyer Match" },
  { value: "divorce", label: "Divorce" },
  { value: "foreclosure", label: "Foreclosure" },
  { value: "ghost_recovery", label: "Ghost Recovery" },
  { value: "social_intent", label: "Social Intent" },
  { value: "search_intent", label: "Search Intent" },
]

const DEFAULT_SCORE_THRESHOLD = 50
const DEFAULT_MAX_TOUCHES     = 5
const DEFAULT_TOUCH_INTERVAL  = 3

// Seed helpers for edit mode. The COLUMN wins; the target_segment jsonb key is
// the fallback because createISACampaign (via this drawer's create path) only
// ever wrote the jsonb spelling — see updateISACampaign's "two spellings" note.
function seedScoreThreshold(c?: ISACampaignRow | null): number {
  if (!c) return DEFAULT_SCORE_THRESHOLD
  if (typeof c.score_threshold === "number") return c.score_threshold
  const fromSeg = c.target_segment?.score_threshold
  return typeof fromSeg === "number" ? fromSeg : DEFAULT_SCORE_THRESHOLD
}
function seedTouchInterval(c?: ISACampaignRow | null): number {
  if (!c) return DEFAULT_TOUCH_INTERVAL
  if (typeof c.touch_interval_days === "number") return c.touch_interval_days
  const fromSeg = c.target_segment?.touch_interval_days
  return typeof fromSeg === "number" ? fromSeg : DEFAULT_TOUCH_INTERVAL
}
function seedChannels(c?: ISACampaignRow | null): Set<CampaignChannelKey> {
  return new Set<CampaignChannelKey>(["email", ...((c?.channels ?? []) as CampaignChannelKey[])])
}

interface Props {
  open:              boolean
  onClose:           () => void
  brokerageId:       string
  directMailEnabled: boolean
  /** Fires after a successful create OR save — the owner refreshes its list. */
  onSaved:           () => void
  /**
   * EDIT MODE. When present the drawer seeds from this row and submits through
   * updateISACampaign instead of createISACampaign. Campaign type is fixed after
   * creation; channels are frozen while the campaign is active (pause first).
   */
  campaign?:         ISACampaignRow | null
}

export function CreateCampaignDrawer({
  open,
  onClose,
  brokerageId,
  directMailEnabled,
  onSaved,
  campaign,
}: Props) {
  const isEdit = !!campaign
  const channelsFrozen = isEdit && campaign?.status === "active"

  const [isPending, startTransition] = useTransition()
  const [name, setName]                 = useState(campaign?.name ?? "")
  const [campaignType, setCampaignType] = useState<CampaignType>(campaign?.campaign_type ?? "fsbo")
  // Email is always on; the rest are opt-in from the canonical outreach channels.
  const [selected, setSelected]         = useState<Set<CampaignChannelKey>>(() => seedChannels(campaign))
  const [scoreThreshold, setScoreThreshold] = useState(() => seedScoreThreshold(campaign))
  const [maxTouches, setMaxTouches]         = useState(campaign?.max_touches ?? DEFAULT_MAX_TOUCHES)
  const [touchInterval, setTouchInterval]   = useState(() => seedTouchInterval(campaign))
  const [error, setError]               = useState<string | null>(null)

  // Re-seed whenever a different campaign is handed in (or the drawer flips
  // back to create mode). Keyed on the id, not the row: the owner's refresh
  // replaces the row object after every save and must not clobber in-progress
  // edits.
  useEffect(() => {
    setName(campaign?.name ?? "")
    setCampaignType(campaign?.campaign_type ?? "fsbo")
    setSelected(seedChannels(campaign))
    setScoreThreshold(seedScoreThreshold(campaign))
    setMaxTouches(campaign?.max_touches ?? DEFAULT_MAX_TOUCHES)
    setTouchInterval(seedTouchInterval(campaign))
    setError(null)
  }, [campaign?.id, open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Which activation-gated channels the tenant has enabled (superadmin capability).
  // `video` is deliberately absent: it is not a destination a campaign sends to,
  // it is a payload a sequence STEP produces and hands to one of these channels.
  const activation: Record<string, boolean> = { direct_mail: directMailEnabled }
  const isLocked = (c: (typeof OUTREACH_CHANNELS)[number]) => !!c.requiresActivation && !activation[c.key]

  function toggleChannel(key: CampaignChannelKey) {
    if (key === "email") return // always on
    if (channelsFrozen) return
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function buildChannels() {
    // Only enabled, unlocked channels are sent; email is guaranteed.
    return OUTREACH_CHANNELS
      .filter((c) => c.key === "email" || (selected.has(c.key) && !isLocked(c)))
      .map((c) => c.key)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) { setError("Name is required."); return }

    startTransition(async () => {
      if (campaign) {
        const result = await updateISACampaign({
          campaignId: campaign.id,
          patch: {
            name:              name.trim(),
            // Channels are refused server-side while active; do not even send
            // them so a stale drawer cannot trip the refusal by accident.
            ...(channelsFrozen ? {} : { channels: buildChannels() }),
            maxTouches:        maxTouches,
            touchIntervalDays: touchInterval,
            scoreThreshold:    scoreThreshold,
          },
        })
        if (!result.success) {
          setError(result.error ?? "Failed to save campaign.")
          return
        }
        onSaved()
        onClose()
        return
      }

      const result = await createISACampaign({
        brokerageId,
        name:          name.trim(),
        campaignType,
        channels:      buildChannels(),
        // THE SLIDER NOW REACHES THE GOVERNOR. `max_touches` stayed in
        // target_segment (a jsonb blob nothing reads) while the touch governor
        // (lib/ai-isa/isa-outreach-logger.ts:175) selects the max_touches
        // COLUMN — so every campaign was capped at the DDL default of 5 no
        // matter where this slider sat. It rides its own field now; the blob
        // keeps the two settings that have no column of their own.
        maxTouches:    maxTouches,
        targetSegment: { score_threshold: scoreThreshold, touch_interval_days: touchInterval },
      })
      if (!result.success) {
        setError(result.error ?? "Failed to create campaign.")
        return
      }
      onSaved()
      onClose()
      // reset
      setName(""); setCampaignType("fsbo"); setSelected(new Set(["email"]))
      setScoreThreshold(DEFAULT_SCORE_THRESHOLD); setMaxTouches(DEFAULT_MAX_TOUCHES); setTouchInterval(DEFAULT_TOUCH_INTERVAL)
    })
  }

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle>{isEdit ? "Edit ISA Campaign" : "New ISA Campaign"}</SheetTitle>
          <SheetDescription>
            {isEdit
              ? "Change this campaign's settings. Status is controlled from the card."
              : "Configure your automated outreach campaign."}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="camp-name">Campaign Name</Label>
            <Input
              id="camp-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. FSBO Summer 2025"
              required
            />
          </div>

          {/* Campaign Type — fixed after creation: it is the segment resolver's dispatch key. */}
          <div className="flex flex-col gap-1.5">
            <Label>Campaign Type</Label>
            <Select value={campaignType} onValueChange={v => setCampaignType(v as CampaignType)} disabled={isEdit}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAMPAIGN_TYPES.map(t => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isEdit && (
              <p className="text-xs text-muted-foreground">Campaign type cannot be changed after creation.</p>
            )}
          </div>

          {/* Channels — data-driven from the canonical outreach-channel registry */}
          <div className="flex flex-col gap-3">
            <Label>Channels</Label>

            {/* Email — always on */}
            <div className="flex items-center gap-3 rounded-md border border-border bg-muted px-3 py-2">
              <Mail className="h-4 w-4 text-blue-500 shrink-0" />
              <span className="flex-1 text-sm font-medium text-foreground">Email</span>
              <span className="text-xs text-muted-foreground">Always on</span>
            </div>

            {OUTREACH_CHANNELS.filter((c) => c.key !== "email").map((c) => {
              const locked = isLocked(c)
              const lockReason = locked
                ? "Requires superadmin activation — contact your platform admin"
                : channelsFrozen
                  ? "Pause the campaign to change channels"
                  : undefined
              return (
                <ChannelToggle
                  key={c.key}
                  icon={CHANNEL_ICON[c.key]}
                  label={c.label}
                  description={lockReason ?? CHANNEL_DESCRIPTION[c.key] ?? ""}
                  enabled={selected.has(c.key) && !locked}
                  locked={locked || channelsFrozen}
                  lockReason={lockReason}
                  onToggle={() => !locked && toggleChannel(c.key)}
                />
              )
            })}

            {channelsFrozen && (
              <p className="text-xs text-muted-foreground">
                Channels are frozen while the campaign is active — consent screening ran against
                the launched set. Pause it from the card to change them.
              </p>
            )}

            {/* Video is a payload, not a destination — say so where the choice is
                made, so nobody goes looking for a "video channel" that should not
                exist. The reel itself is added as a step in the sequence builder,
                and it rides whichever of these channels the step targets. */}
            <p className="text-xs text-muted-foreground">
              Sending a <span className="font-medium text-foreground">video</span> is not a
              channel choice — a reel is produced by a step in the sequence and delivered
              inside {VIDEO_OUTREACH_CHANNELS.filter(channelCarriesVideo).length > 0
                ? OUTREACH_CHANNELS.filter((c) => channelCarriesVideo(c.key)).map((c) => c.label).join(", ")
                : "another channel"}.
            </p>
          </div>

          {/* Score Threshold */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>Score Threshold</Label>
              <span className="text-sm font-semibold text-foreground">{scoreThreshold}</span>
            </div>
            <Slider
              min={0} max={100} step={1}
              value={[scoreThreshold]}
              onValueChange={([v]) => setScoreThreshold(v)}
            />
            <p className="text-xs text-muted-foreground">
              Only target contacts with score &ge; {scoreThreshold}
              {isEdit && campaign?.status !== "draft" && " — applied at enrolment only; contacts already in cadence are unaffected"}
            </p>
          </div>

          {/* Max Touches */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="max-touches">Max Touches</Label>
            <Input
              id="max-touches"
              type="number"
              min={1} max={20}
              value={maxTouches}
              onChange={e => setMaxTouches(Number(e.target.value))}
            />
          </div>

          {/* Touch Interval */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="touch-interval">Touch Interval (days)</Label>
            <Input
              id="touch-interval"
              type="number"
              min={1} max={90}
              value={touchInterval}
              onChange={e => setTouchInterval(Number(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              Cadence: Max {maxTouches} touches · every {touchInterval} days
            </p>
          </div>

          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={isPending}>
              {isEdit
                ? (isPending ? "Saving…" : "Save changes")
                : (isPending ? "Creating…" : "Create Campaign")}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function ChannelToggle({
  icon, label, description, enabled, locked, lockReason, onToggle,
}: {
  icon: React.ReactNode
  label: string
  description: string
  enabled: boolean
  locked: boolean
  lockReason?: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={locked}
      title={locked ? lockReason : undefined}
      className={`flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors w-full ${
        locked
          ? enabled
            ? "border-primary bg-primary/5 opacity-60 cursor-not-allowed"
            : "border-border bg-muted opacity-60 cursor-not-allowed"
          : enabled
            ? "border-primary bg-primary/5"
            : "border-border bg-background hover:bg-muted"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      {/* Toggle indicator */}
      <span className={`h-4 w-4 shrink-0 rounded-full border-2 ${
        enabled ? "border-primary bg-primary" : "border-muted-foreground bg-transparent"
      }`} />
    </button>
  )
}
