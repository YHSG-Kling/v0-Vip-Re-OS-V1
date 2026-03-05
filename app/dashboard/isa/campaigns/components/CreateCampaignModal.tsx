"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { createISACampaign, type CampaignType } from "@/app/actions/ai-isa"

const CAMPAIGN_TYPES: { value: CampaignType; label: string }[] = [
  { value: "FSBO",           label: "FSBO" },
  { value: "BUYER_MATCH",    label: "Buyer Match" },
  { value: "DIVORCE",        label: "Divorce" },
  { value: "FORECLOSURE",    label: "Foreclosure" },
  { value: "GHOST_RECOVERY", label: "Ghost Recovery" },
]

interface Props {
  open: boolean
  onClose: () => void
  brokerageId: string
  videoEnabled: boolean
  directMailEnabled: boolean
  onCreated: () => void
}

export function CreateCampaignModal({
  open, onClose, brokerageId, videoEnabled, directMailEnabled, onCreated,
}: Props) {
  const [name, setName]             = useState("")
  const [type, setType]             = useState<CampaignType>("FSBO")
  const [channels, setChannels]     = useState<string[]>(["email"])
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState<string | null>(null)

  function toggleChannel(ch: string) {
    setChannels(prev =>
      prev.includes(ch) ? prev.filter(c => c !== ch) : [...prev, ch]
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || channels.length === 0) {
      setError("Name and at least one channel are required.")
      return
    }
    setLoading(true)
    setError(null)
    const result = await createISACampaign({ brokerageId, name, campaignType: type, channels })
    setLoading(false)
    if (!result.success) { setError(result.error ?? "Failed to create campaign"); return }
    setName(""); setChannels(["email"])
    onCreated()
    onClose()
  }

  const channelOptions = [
    { key: "email",       label: "Email",       always: true },
    { key: "sms",         label: "SMS",         always: true },
    { key: "video",       label: "Video",       always: false, enabled: videoEnabled },
    { key: "direct_mail", label: "Direct Mail", always: false, enabled: directMailEnabled },
  ]

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New ISA Campaign</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="camp-name">Campaign Name</Label>
            <Input
              id="camp-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Q2 FSBO Outreach"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="camp-type">Campaign Type</Label>
            <Select value={type} onValueChange={v => setType(v as CampaignType)}>
              <SelectTrigger id="camp-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAMPAIGN_TYPES.map(t => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Channels</Label>
            <div className="flex flex-wrap gap-2">
              {channelOptions.map(({ key, label, always, enabled }) => {
                const isAvailable = always || enabled
                const selected = channels.includes(key)
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={!isAvailable}
                    onClick={() => isAvailable && toggleChannel(key)}
                    title={!isAvailable ? "Requires superadmin activation — contact your platform admin" : undefined}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors
                      ${!isAvailable
                        ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
                        : selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background text-foreground hover:bg-muted"
                      }`}
                  >
                    {label}
                    {!isAvailable && " 🔒"}
                  </button>
                )
              })}
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? "Creating…" : "Create Campaign"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
