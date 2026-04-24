"use client"

import { useState, useTransition } from "react"
import { createLeadMagnetAction, publishLeadMagnetAction } from "@/app/actions/lead-magnets-actions"
import type { CreateLeadMagnetInput } from "@/lib/kernel/lead-magnets"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Bell, CheckCircle2, Loader2 } from "lucide-react"

interface Props {
  brokerageId: string
  agentId: string
  onCreated?: (magnetId: string, slug: string) => void
}

const MAGNET_TYPES: Array<{ value: CreateLeadMagnetInput["magnetType"]; label: string; description: string }> = [
  { value: "home_valuation",  label: "Home Valuation",   description: "Capture seller leads by offering a free home value estimate" },
  { value: "buyer_guide",     label: "Buyer Guide",      description: "Attract first-time buyers with an educational resource" },
  { value: "seller_guide",    label: "Seller Guide",     description: "Engage motivated sellers with a step-by-step selling guide" },
  { value: "market_report",   label: "Market Report",    description: "Share local market data in exchange for contact info" },
  { value: "listing_alert",   label: "Listing Alert",    description: "Notify buyers when matching homes come on the market" },
  { value: "open_house",      label: "Open House",       description: "Collect visitor info at open house events" },
  { value: "generic_form",    label: "Generic Form",     description: "Custom lead capture form for any purpose" },
]

const PUBLISH_CHANNELS = [
  { id: "qr_code",      label: "QR Code" },
  { id: "landing_page", label: "Landing Page" },
  { id: "email",        label: "Email Link" },
  { id: "social",       label: "Social Media" },
] as const

export function MagnetBuilder({ brokerageId, agentId, onCreated }: Props) {
  const [step, setStep] = useState<"configure" | "publish" | "done">("configure")
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [createdMagnet, setCreatedMagnet] = useState<{ magnetId: string; slug: string } | null>(null)

  // Form state
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [magnetType, setMagnetType] = useState<CreateLeadMagnetInput["magnetType"]>("home_valuation")
  const [tcpaText, setTcpaText] = useState(
    "By submitting this form, you consent to receive communications. You may opt out at any time."
  )
  const [thankYouMessage, setThankYouMessage] = useState("Thank you! We will be in touch shortly.")
  const [channels, setChannels] = useState<string[]>(["qr_code", "landing_page"])
  const [notifyByEmail, setNotifyByEmail] = useState(true)

  function toggleChannel(channel: string) {
    setChannels((prev) =>
      prev.includes(channel) ? prev.filter((c) => c !== channel) : [...prev, channel]
    )
  }

  function handleCreate() {
    if (!title.trim()) { setError("Title is required"); return }
    setError(null)

    startTransition(async () => {
      const result = await createLeadMagnetAction({
        name: title.trim(),
        magnet_type: magnetType,
        description: description.trim(),
        thank_you_message: thankYouMessage.trim(),
        tcpa_text: tcpaText.trim(),
        notify_on_submission: notifyByEmail,
      })

      if (!result.success || !result.magnetId) {
        setError(result.error ?? "Failed to create lead magnet")
        return
      }

      setCreatedMagnet({ magnetId: result.magnetId, slug: title.trim().toLowerCase().replace(/\s+/g, "-") })
      setStep("publish")
    })
  }

  function handlePublish() {
    if (!createdMagnet) return
    setError(null)

    startTransition(async () => {
      const result = await publishLeadMagnetAction(createdMagnet.magnetId)

      if (!result.success) {
        setError(result.error ?? "Failed to publish")
        return
      }

      setStep("done")
      onCreated?.(createdMagnet.magnetId, createdMagnet.slug)
    })
  }

  if (step === "done") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-16">
          <CheckCircle2 className="h-12 w-12 text-green-600" />
          <div className="text-center">
            <p className="font-semibold text-lg">Lead magnet published</p>
            <p className="text-sm text-muted-foreground mt-1">
              Your lead magnet is live at <span className="font-mono">/lm/{createdMagnet?.slug}</span>
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (step === "publish") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Publish Channels</CardTitle>
          <CardDescription>Choose how you want to distribute this lead magnet</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 gap-3">
            {PUBLISH_CHANNELS.map((ch) => (
              <label
                key={ch.id}
                className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/30 transition-colors"
              >
                <Checkbox
                  checked={channels.includes(ch.id)}
                  onCheckedChange={() => toggleChannel(ch.id)}
                />
                <span className="text-sm font-medium">{ch.label}</span>
              </label>
            ))}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setStep("configure")} disabled={isPending}>
              Back
            </Button>
            <Button onClick={handlePublish} disabled={isPending || channels.length === 0} className="flex-1">
              {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Publish Lead Magnet
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Lead Magnet</CardTitle>
        <CardDescription>Build a lead capture form that converts visitors into contacts</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Type */}
        <div className="space-y-2">
          <Label>Magnet Type</Label>
          <Select value={magnetType} onValueChange={(v) => setMagnetType(v as any)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MAGNET_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  <div>
                    <p className="font-medium">{t.label}</p>
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Title */}
        <div className="space-y-2">
          <Label htmlFor="magnet-title">Title</Label>
          <Input
            id="magnet-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Find Out What Your Home Is Worth"
          />
        </div>

        {/* Description */}
        <div className="space-y-2">
          <Label htmlFor="magnet-desc">Description</Label>
          <Textarea
            id="magnet-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description shown to visitors"
            rows={2}
          />
        </div>

        {/* Thank you message */}
        <div className="space-y-2">
          <Label htmlFor="ty-msg">Thank You Message</Label>
          <Input
            id="ty-msg"
            value={thankYouMessage}
            onChange={(e) => setThankYouMessage(e.target.value)}
          />
        </div>

        {/* TCPA */}
        <div className="space-y-2">
          <Label htmlFor="tcpa-text">TCPA Disclosure Text</Label>
          <Textarea
            id="tcpa-text"
            value={tcpaText}
            onChange={(e) => setTcpaText(e.target.value)}
            rows={3}
          />
        </div>

        {/* Email notification preference */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Email notifications</p>
              <p className="text-xs text-muted-foreground">Receive an email when a lead submits this form</p>
            </div>
          </div>
          <Switch
            checked={notifyByEmail}
            onCheckedChange={setNotifyByEmail}
            aria-label="Notify me by email on lead submission"
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button onClick={handleCreate} disabled={isPending} className="w-full">
          {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Continue to Publish
        </Button>
      </CardContent>
    </Card>
  )
}
