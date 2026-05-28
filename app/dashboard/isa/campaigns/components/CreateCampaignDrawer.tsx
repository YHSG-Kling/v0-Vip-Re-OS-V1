"use client"

import { useState, useTransition } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Mail, MessageSquare, Video, FileText } from "lucide-react"
import { createISACampaign, type CampaignType } from "@/app/actions/ai-isa"

const CAMPAIGN_TYPES: { value: CampaignType; label: string }[] = [
  { value: "fsbo", label: "FSBO" },
  { value: "buyer_match", label: "Buyer Match" },
  { value: "divorce", label: "Divorce" },
  { value: "foreclosure", label: "Foreclosure" },
  { value: "ghost_recovery", label: "Ghost Recovery" },
  { value: "social_intent", label: "Social Intent" },
  { value: "search_intent", label: "Search Intent" },
]

interface Props {
  open:              boolean
  onClose:           () => void
  brokerageId:       string
  videoEnabled:      boolean
  directMailEnabled: boolean
  onCreated:         () => void
}

export function CreateCampaignDrawer({
  open,
  onClose,
  brokerageId,
  videoEnabled,
  directMailEnabled,
  onCreated,
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [name, setName]                 = useState("")
  const [campaignType, setCampaignType] = useState<CampaignType>("fsbo")
  const [emailOn, setEmailOn]           = useState(true)           // always on
  const [smsOn, setSmsOn]               = useState(false)
  const [videoOn, setVideoOn]           = useState(false)
  const [directMailOn, setDirectMailOn] = useState(false)
  const [scoreThreshold, setScoreThreshold] = useState(50)
  const [maxTouches, setMaxTouches]         = useState(5)
  const [touchInterval, setTouchInterval]   = useState(3)
  const [error, setError]               = useState<string | null>(null)

  function buildChannels() {
    const ch: string[] = ["email"]
    if (smsOn)        ch.push("sms")
    if (videoOn && videoEnabled)      ch.push("video")
    if (directMailOn && directMailEnabled) ch.push("direct_mail")
    return ch
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) { setError("Name is required."); return }

    startTransition(async () => {
      const result = await createISACampaign({
        brokerageId,
        name:          name.trim(),
        campaignType,
        channels:      buildChannels(),
        targetSegment: { score_threshold: scoreThreshold, max_touches: maxTouches, touch_interval_days: touchInterval },
      })
      if (!result.success) {
        setError(result.error ?? "Failed to create campaign.")
        return
      }
      onCreated()
      onClose()
      // reset
      setName(""); setCampaignType("fsbo"); setSmsOn(false); setVideoOn(false)
      setDirectMailOn(false); setScoreThreshold(50); setMaxTouches(5); setTouchInterval(3)
    })
  }

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle>New ISA Campaign</SheetTitle>
          <SheetDescription>Configure your automated outreach campaign.</SheetDescription>
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

          {/* Campaign Type */}
          <div className="flex flex-col gap-1.5">
            <Label>Campaign Type</Label>
            <Select value={campaignType} onValueChange={v => setCampaignType(v as CampaignType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAMPAIGN_TYPES.map(t => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Channels */}
          <div className="flex flex-col gap-3">
            <Label>Channels</Label>

            {/* Email — always on */}
            <div className="flex items-center gap-3 rounded-md border border-border bg-muted px-3 py-2">
              <Mail className="h-4 w-4 text-blue-500 shrink-0" />
              <span className="flex-1 text-sm font-medium text-foreground">Email</span>
              <span className="text-xs text-muted-foreground">Always on</span>
            </div>

            {/* SMS */}
            <ChannelToggle
              icon={<MessageSquare className="h-4 w-4 text-green-500" />}
              label="SMS"
              description="TCPA consent required per contact"
              enabled={smsOn}
              locked={false}
              onToggle={() => setSmsOn(v => !v)}
            />

            {/* Video */}
            <ChannelToggle
              icon={<Video className="h-4 w-4 text-purple-500" />}
              label="Video (HeyGen)"
              description={videoEnabled ? "Personalized AI video" : "Requires superadmin activation — contact your platform admin"}
              enabled={videoOn && videoEnabled}
              locked={!videoEnabled}
              onToggle={() => videoEnabled && setVideoOn(v => !v)}
            />

            {/* Direct Mail */}
            <ChannelToggle
              icon={<FileText className="h-4 w-4 text-orange-500" />}
              label="Direct Mail (Lob)"
              description={directMailEnabled ? "Personalized postcard" : "Requires superadmin activation — contact your platform admin"}
              enabled={directMailOn && directMailEnabled}
              locked={!directMailEnabled}
              onToggle={() => directMailEnabled && setDirectMailOn(v => !v)}
            />
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
            <p className="text-xs text-muted-foreground">Only target contacts with score &ge; {scoreThreshold}</p>
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
              {isPending ? "Creating…" : "Create Campaign"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function ChannelToggle({
  icon, label, description, enabled, locked, onToggle,
}: {
  icon: React.ReactNode
  label: string
  description: string
  enabled: boolean
  locked: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={locked}
      title={locked ? "Requires superadmin activation — contact your platform admin" : undefined}
      className={`flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors w-full ${
        locked
          ? "border-border bg-muted opacity-60 cursor-not-allowed"
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
        enabled && !locked ? "border-primary bg-primary" : "border-muted-foreground bg-transparent"
      }`} />
    </button>
  )
}
