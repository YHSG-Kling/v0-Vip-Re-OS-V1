"use client"

import { useState, useTransition } from "react"
import { createLeadMagnetAction, publishLeadMagnetAction, draftLeadMagnetWithAiAction, startBookProjectAction } from "@/app/actions/lead-magnets-actions"
import { generateLeadMagnetCopyAction } from "@/app/actions/marketing/lead-magnet-copy"
import type { CreateLeadMagnetInput } from "@/lib/kernel/lead-magnets"
import type { LandingContent } from "@/lib/marketing/lead-magnet-copy"
// Wave 142: the ONE roster of "who fills this form" (merged from the retired admin Forms Manager).
import { FORM_DECLARABLE_CONTACT_TYPES } from "@/lib/lead-magnets/form-contact-types"
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
import { Bell, BookOpen, CheckCircle2, Loader2, Plus, Sparkles, Trash2, Wand2 } from "lucide-react"

type MagnetType = CreateLeadMagnetInput["magnetType"]
type PublishChannel = "qr_code" | "email" | "landing_page" | "social"

interface Props {
  brokerageId: string
  // No agentId prop: createLeadMagnetAction resolves agents.id server-side from
  // the session. The prop was never read, and every caller was passing the auth
  // user id — the wrong id class for lead_capture_forms.agent_id.
  onCreated?: (magnetId: string, slug: string) => void
  /** Wave 141: the AI wrote a REAL draft record — open it for preview / edit / approval. */
  onDrafted?: (magnetId: string, slug: string) => void
  /** Wave 141: a suggestion the human picked ("Draft this with AI") pre-fills the concept + type. */
  initialConcept?: string
  initialMagnetType?: MagnetType
}

const MAGNET_TYPES: Array<{ value: MagnetType; label: string; description: string }> = [
  { value: "home_valuation",  label: "Home Valuation",   description: "Capture seller leads by offering a free home value estimate" },
  { value: "buyer_guide",     label: "Buyer Guide",      description: "Attract first-time buyers with an educational resource" },
  { value: "seller_guide",    label: "Seller Guide",     description: "Engage motivated sellers with a step-by-step selling guide" },
  { value: "market_report",   label: "Market Report",    description: "Share local market data in exchange for contact info" },
  { value: "listing_alert",   label: "Listing Alert",    description: "Notify buyers when matching homes come on the market" },
  { value: "open_house",      label: "Open House",       description: "Collect visitor info at open house events" },
  { value: "generic_form",    label: "Custom Form",      description: "Your own capture form — add the questions you need" },
]

const PUBLISH_CHANNELS: ReadonlyArray<{ id: PublishChannel; label: string }> = [
  { id: "qr_code",      label: "QR Code" },
  { id: "landing_page", label: "Landing Page" },
  { id: "email",        label: "Email Link" },
  { id: "social",       label: "Social Media" },
]

const FIELD_TYPES = [
  { value: "text", label: "Short answer" },
  { value: "textarea", label: "Long answer" },
  { value: "number", label: "Number" },
  { value: "select", label: "Choice" },
  { value: "checkbox", label: "Checkbox" },
]

interface ExtraField { label: string; type: string; required: boolean; options: string }

export function MagnetBuilder({ brokerageId, onCreated, onDrafted, initialConcept, initialMagnetType }: Props) {
  const [step, setStep] = useState<"configure" | "publish" | "done">("configure")
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [createdMagnet, setCreatedMagnet] = useState<{ magnetId: string; slug: string } | null>(null)

  // Form state
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [magnetType, setMagnetType] = useState<MagnetType>(initialMagnetType ?? "home_valuation")
  const [tcpaText, setTcpaText] = useState(
    "By submitting this form, you consent to receive communications. You may opt out at any time."
  )
  const [thankYouMessage, setThankYouMessage] = useState("Thank you! We will be in touch shortly.")
  const [channels, setChannels] = useState<PublishChannel[]>(["qr_code", "landing_page"])
  // notifyByEmail: email the agent (in addition to the in-app alert) on each submission.
  const [notifyByEmail, setNotifyByEmail] = useState(false)
  // Wave 141: the tenant's OWN questions, added on top of the type's canonical fields.
  const [extraFields, setExtraFields] = useState<ExtraField[]>([])

  // AI landing copy — built from real buyer/seller demand topics + the GEO FAQ/JSON-LD.
  const [area, setArea] = useState("")
  const [brand, setBrand] = useState("")
  const [landing, setLanding] = useState<LandingContent | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)

  // Wave 141: AI CREATES THE ACTUAL DRAFT — concept in, a real draft record out.
  const [concept, setConcept] = useState(initialConcept ?? "")
  const [isDrafting, setIsDrafting] = useState(false)
  const [draftNote, setDraftNote] = useState<string | null>(null)
  // Wave 142: WHO FILLS a custom form (merged from the retired admin Forms Manager) — "" = unspecified.
  const [defaultContactType, setDefaultContactType] = useState("")
  // Wave 142: THE BOOK — a whole AI-written, fact-checked, fair-housing-reviewed book as the deliverable.
  const [bookAudience, setBookAudience] = useState<"buyer" | "seller">("seller")
  const [isStartingBook, setIsStartingBook] = useState(false)

  function handleWriteBook() {
    setError(null)
    setDraftNote(null)
    if (concept.trim().length < 12) { setError("Describe the book in a sentence or two first."); return }
    setIsStartingBook(true)
    ;(async () => {
      try {
        const res = await startBookProjectAction({ concept: concept.trim(), audience: bookAudience, area: area.trim() || null, brand: brand.trim() || null })
        if (!res.success) { setError(res.error ?? "The book project was not created"); return }
        setDraftNote(`Book project started — the writer is researching, outlining and drafting "${res.title}". Follow it on the review tab.`)
        onDrafted?.(res.magnetId, res.slug)
      } catch (err: any) {
        setError(err?.message ?? "The book project was not created")
      } finally {
        setIsStartingBook(false)
      }
    })()
  }

  function toggleChannel(channel: PublishChannel) {
    setChannels((prev) =>
      prev.includes(channel) ? prev.filter((c) => c !== channel) : [...prev, channel]
    )
  }

  function handleDraftWithAi() {
    setError(null)
    setDraftNote(null)
    if (concept.trim().length < 8) { setError("Describe the lead magnet in a sentence or two first."); return }
    setIsDrafting(true)
    ;(async () => {
      try {
        const res = await draftLeadMagnetWithAiAction({ concept: concept.trim(), magnet_type: magnetType, area: area.trim() || null, brand: brand.trim() || null })
        if (!res.success) { setError(res.error ?? "The draft was not created"); return }
        setDraftNote(res.fromAi ? "Draft created — review, edit and publish it." : `Draft created from the safe baseline (${res.fallbackReason ?? "AI copy unavailable"}) — review, edit and publish it.`)
        onDrafted?.(res.magnetId, res.slug)
      } catch (err: any) {
        setError(err?.message ?? "The draft was not created")
      } finally {
        setIsDrafting(false)
      }
    })()
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

  function addExtraField() {
    setExtraFields((prev) => [...prev, { label: "", type: "text", required: false, options: "" }])
  }
  function patchExtraField(i: number, patch: Partial<ExtraField>) {
    setExtraFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
  }
  function removeExtraField(i: number) {
    setExtraFields((prev) => prev.filter((_, idx) => idx !== i))
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
        extra_fields: extraFields
          .filter((f) => f.label.trim())
          .map((f) => ({ label: f.label.trim(), type: f.type, required: f.required, options: f.type === "select" ? f.options.split(",").map((o) => o.trim()).filter(Boolean) : undefined })),
        // Created as a DRAFT: the next step (publish) is the approval that makes it public.
        publish_state: "draft",
        // The AI landing copy is persisted WITH the row (one write — not a second save that could fail).
        landing: landing ?? null,
        // Who fills a CUSTOM form — the kernel stamps the contact type so the welcome + handoff fire.
        default_contact_type: magnetType === "generic_form" && defaultContactType ? defaultContactType : null,
      })

      if (!result.success || !result.magnetId) {
        setError(result.error ?? "Failed to create lead magnet")
        return
      }

      // THE REAL SLUG (wave 141): the kernel appends a time suffix; the client-side guess this used to
      // show sent the done screen, the QR card and the preview to a page that did not exist.
      setCreatedMagnet({ magnetId: result.magnetId, slug: result.slug ?? "" })
      setStep("publish")
    })
  }

  function handlePublish() {
    if (!createdMagnet) return
    setError(null)

    startTransition(async () => {
      // THE CHANNELS ARE PASSED (wave 141): the checkboxes were collected and never sent, so the
      // kernel's QR branch was unreachable from this builder.
      const result = await publishLeadMagnetAction(createdMagnet.magnetId, channels)

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
          <CardDescription>Your draft is saved. Choose how you want to distribute it — publishing makes the page public.</CardDescription>
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
          <Select value={magnetType} onValueChange={(v) => { setMagnetType(v as MagnetType); setLanding(null) }}>
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

        {/* Wave 141: AI creates the ACTUAL draft — a real record you then review, edit and publish. */}
        <div className="space-y-3 rounded-lg border p-4 bg-primary/5">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium">Draft it with AI</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Describe the lead magnet you want. The AI writes the page copy, the questions and the FAQ as a draft
            you preview, edit and approve — nothing goes public until you publish it.
          </p>
          <Textarea
            id="ai-concept"
            value={concept}
            onChange={(e) => setConcept(e.target.value)}
            placeholder="e.g. A spring selling guide for homeowners who are thinking about listing this year"
            rows={2}
          />
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
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={handleDraftWithAi} disabled={isDrafting || isGenerating || isStartingBook}>
              {isDrafting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Wand2 className="h-4 w-4 mr-2" />}
              Draft with AI
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={handleGenerateCopy} disabled={isGenerating || isDrafting || isStartingBook}>
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
              {landing ? "Regenerate page copy only" : "Write page copy only"}
            </Button>
          </div>
          {draftNote && <p className="text-xs text-green-700">{draftNote}</p>}

          {/* Wave 142: a WHOLE BOOK as the deliverable — researched, outlined, written, fact-checked, edited, laid out as a PDF you review. */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-2 border-t">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium flex items-center gap-1"><BookOpen className="h-3.5 w-3.5" /> Or write a whole book from this concept</p>
              <p className="text-[11px] text-muted-foreground">Research → outline → original chapters → fact check → edit → cover + PDF. You review every chapter before it can publish.</p>
            </div>
            <Select value={bookAudience} onValueChange={(v) => setBookAudience(v as "buyer" | "seller")}>
              <SelectTrigger className="w-[150px]" aria-label="Book audience"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="seller">For sellers</SelectItem>
                <SelectItem value="buyer">For buyers</SelectItem>
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" size="sm" onClick={handleWriteBook} disabled={isStartingBook || isDrafting || isGenerating}>
              {isStartingBook ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <BookOpen className="h-4 w-4 mr-2" />}
              Write the book
            </Button>
          </div>

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

        {/* Wave 141: the tenant's own questions (added to the type's standard fields). */}
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Your questions</p>
              <p className="text-xs text-muted-foreground">Name, email and phone are always asked{magnetType === "home_valuation" ? ", plus the property details" : ""}. Add anything else you want to know.</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addExtraField}>
              <Plus className="h-4 w-4 mr-1" /> Add question
            </Button>
          </div>
          {extraFields.length === 0 && (
            <p className="text-xs text-muted-foreground">No extra questions yet.</p>
          )}
          {extraFields.map((f, i) => (
            <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_140px_auto_auto] gap-2 items-center">
              <Input
                aria-label={`Question ${i + 1}`}
                value={f.label}
                onChange={(e) => patchExtraField(i, { label: e.target.value })}
                placeholder="e.g. When are you planning to move?"
              />
              <Select value={f.type} onValueChange={(v) => patchExtraField(i, { type: v })}>
                <SelectTrigger aria-label={`Question ${i + 1} type`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={f.required} onCheckedChange={(v) => patchExtraField(i, { required: Boolean(v) })} />
                Required
              </label>
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove question ${i + 1}`} onClick={() => removeExtraField(i)}>
                <Trash2 className="h-4 w-4" />
              </Button>
              {f.type === "select" && (
                <Input
                  className="sm:col-span-4"
                  aria-label={`Question ${i + 1} choices`}
                  value={f.options}
                  onChange={(e) => patchExtraField(i, { options: e.target.value })}
                  placeholder="Choices, comma-separated (e.g. 0-3 months, 3-6 months, 6-12 months)"
                />
              )}
            </div>
          ))}
        </div>

        {/* Wave 142 (merged from the admin Forms Manager): who fills a CUSTOM form, so the right welcome + manager pick them up. */}
        {magnetType === "generic_form" && (
          <div className="space-y-2">
            <Label>Who fills this form?</Label>
            <Select value={defaultContactType || "unspecified"} onValueChange={(v) => setDefaultContactType(v === "unspecified" ? "" : v)}>
              <SelectTrigger aria-label="Who fills this form"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unspecified">Unspecified — capture only, no automatic welcome</SelectItem>
                {FORM_DECLARABLE_CONTACT_TYPES.map((v) => (
                  <SelectItem key={v} value={v}>{v === "both" ? "Buyers and sellers" : v === "buyer" ? "Buyers" : "Sellers"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Sets the contact type on every submission so the welcome sequence and the right manager pick the person up. Leave unspecified to capture without guessing.</p>
          </div>
        )}

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

        <Button onClick={handleCreate} disabled={isPending || isDrafting} className="w-full">
          {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Save draft and continue to publish
        </Button>
      </CardContent>
    </Card>
  )
}
