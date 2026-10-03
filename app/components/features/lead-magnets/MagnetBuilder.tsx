"use client"

import { useState, useTransition } from "react"
import { createLeadMagnetAction, publishLeadMagnetAction, saveMagnetLandingContentAction } from "@/app/actions/lead-magnets-actions"
import { generateLeadMagnetCopyAction } from "@/app/actions/marketing/lead-magnet-copy"
import type { CreateLeadMagnetInput } from "@/lib/kernel/lead-magnets"
import type { LandingContent } from "@/lib/marketing/lead-magnet-copy"
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
import { Bell, CheckCircle2, Loader2, Sparkles } from "lucide-react"

interface Props {
  brokerageId: string
  // No agentId prop: createLeadMagnetAction resolves agents.id server-side from
  // the session. The prop was never read, and every caller was passing the auth
  // user id — the wrong id class for lead_capture_forms.agent_id.
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

export function MagnetBuilder({ brokerageId, onCreated }: Props) {
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
  // notifyByEmail: email the agent (in addition to the in-app alert) on each submission.
  const [notifyByEmail, setNotifyByEmail] = useState(false)

  // AI landing copy — built from real buyer/seller demand topics + the GEO FAQ/JSON-LD.
  const [area, setArea] = useState("")
  const [brand, setBrand] = useState("")
  const [landing, setLanding] = useState<LandingContent | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)

  function toggleChannel(channel: string) {
    setChannels((prev) =>
      prev.includes(channel) ? prev.filter((c) => c !== channel) : [...prev, channel]
    )
  }

  function handleGenerateCopy() {
    setError(null)
    setIsGenerating(true)
    ;(async () => {
      try {
        const res = await generateLeadMagnetCopyAction({ magnetType, area: area.trim() || null, brand: brand.trim() || null })
        if (!res.success || !res.landing) { setError(res.error ?? "Could not generate copy"); return }
        const lc: LandingContent = {
          headline:   res.landing.headline,
          subhead:    res.landing.subhead,
          cta:        res.landing.cta,
          bullets:    res.landing.bullets,
          topics:     res.topics ?? [],
          faq:        res.faq ?? [],
          faqJsonLd:  res.faqJsonLd ?? null,
          fromTopics: !!res.landing.fromTopics,
          generatedAt: new Date().toISOString(),
        }
        setLanding(lc)
        // Seed the editable fields from the AI draft (the agent can still tweak before saving).
        if (!title.trim()) setTitle(lc.headline)
        setDescription(lc.subhead)
      } catch (err: any) {
        setError(err?.message ?? "Could not generate copy")
      } finally {
        setIsGenerating(false)
      }
    })()
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
        tcpa_text: tcpaText.trim() || undefined,
        notify_on_submission: notifyByEmail,
      })

      if (!result.success || !result.magnetId) {
        setError(result.error ?? "Failed to create lead magnet")
        return
      }

      // Persist the AI landing copy + GEO FAQ/JSON-LD so the public page can render it.
      if (landing) {
        const saved = await saveMagnetLandingContentAction(result.magnetId, landing)
        if (!saved.success) { setError(saved.error ?? "Created, but failed to save AI landing copy"); return }
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
          <Select value={magnetType} onValueChange={(v) => { setMagnetType(v as any); setLanding(null) }}>
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

        {/* AI copy — built from what buyers/sellers are actually asking, with a GEO FAQ for AI-search visibility */}
        <div className="space-y-3 rounded-lg border border-dashed p-4 bg-muted/20">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium">Let AI write this page</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Grounded in real buyer/seller questions for your area, plus an FAQ that gets the page cited by
            AI search (ChatGPT, Perplexity, Google AI Overviews) — not just indexed.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ai-area" className="text-xs">Area / market <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="ai-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Austin, TX" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-brand" className="text-xs">Brand <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="ai-brand" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. The Kling Group" />
            </div>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={handleGenerateCopy} disabled={isGenerating}>
            {isGenerating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
            {landing ? "Regenerate copy" : "Generate copy"}
          </Button>

          {landing && (
            <div className="space-y-3 pt-1">
              <div className="flex items-center gap-2 text-xs text-green-700">
                <CheckCircle2 className="h-4 w-4" />
                <span>{landing.fromTopics ? "Built from live demand topics" : "Built from a safe baseline (live topics unavailable)"}</span>
              </div>
              {landing.bullets.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                  {landing.bullets.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              )}
              {landing.topics.length > 0 && (
                <p className="text-xs text-muted-foreground"><span className="font-medium">Topics:</span> {landing.topics.slice(0, 6).join(" · ")}</p>
              )}
              {landing.faq.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium">FAQ for AI visibility ({landing.faq.length})</p>
                  <ul className="space-y-1">
                    {landing.faq.slice(0, 3).map((f, i) => (
                      <li key={i} className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{f.question}</span> — {f.answer}</li>
                    ))}
                  </ul>
                  {landing.faqJsonLd && <p className="text-[11px] text-green-700">✓ schema.org FAQPage markup will be embedded on the published page</p>}
                </div>
              )}
            </div>
          )}
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

        {/* Email notification preference — emails the agent on each submission */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Email notifications</p>
              <p className="text-xs text-muted-foreground">Email you on every submission (in-app alerts are always sent)</p>
            </div>
          </div>
          <Switch
            checked={notifyByEmail}
            onCheckedChange={setNotifyByEmail}
            aria-label="Email me on every submission"
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
