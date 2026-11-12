"use client"

/**
 * MagnetDraftReview — the HUMAN step between an AI (or cloned, or hand-built) DRAFT and a public page
 * (wave 141, lane 141E: "human preview → edit → approve → publish").
 *
 * Reads the magnet through getLeadMagnetDraftAction (tenant-scoped), lets the reviewer edit the page copy
 * (headline / subhead / CTA / bullets), the name, the thank-you text and the questions, saves through the
 * EXISTING writers (saveMagnetLandingContentAction + updateMagnetSettingsAction — nothing new writes
 * lead_capture_forms), and approves through publishLeadMagnetAction with the chosen channels. A published
 * magnet opens the same screen as an editor (no publish button; the page is already live).
 */

import { useEffect, useState, useTransition } from "react"
import { getLeadMagnetDraftAction, publishLeadMagnetAction, saveMagnetLandingContentAction, updateMagnetSettingsAction } from "@/app/actions/lead-magnets-actions"
import type { LeadMagnetField } from "@/lib/kernel/lead-magnets"
import type { LandingContent } from "@/lib/marketing/lead-magnet-copy"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CheckCircle2, Loader2, Plus, Save, Trash2, Wand2 } from "lucide-react"
// Wave 142: the book the magnet carries (staged pipeline) + the one "who fills this form" roster.
import { BookProjectPanel } from "./BookProjectPanel"
import { FORM_DECLARABLE_CONTACT_TYPES } from "@/lib/lead-magnets/form-contact-types"

type PublishChannel = "qr_code" | "email" | "landing_page" | "social"
const PUBLISH_CHANNELS: ReadonlyArray<{ id: PublishChannel; label: string }> = [
  { id: "landing_page", label: "Landing Page" },
  { id: "qr_code",      label: "QR Code" },
  { id: "email",        label: "Email Link" },
  { id: "social",       label: "Social Media" },
]

const CANONICAL_FIELD_NAMES = new Set(["first_name", "last_name", "email", "phone", "property_address", "city", "state", "zip_code"])

interface Props {
  magnetId: string
  onPublished?: (magnetId: string, slug: string) => void
  onSaved?: () => void
}

export function MagnetDraftReview({ magnetId, onPublished, onSaved }: Props) {
  const [isPending, startTransition] = useTransition()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [slug, setSlug] = useState("")
  const [lifecycleState, setLifecycleState] = useState<"draft" | "published">("draft")
  const [isActive, setIsActive] = useState(false)
  const [authoredBy, setAuthoredBy] = useState<"ai" | "human">("human")
  const [authoringNote, setAuthoringNote] = useState<string | null>(null)
  const [fairHousingFlags, setFairHousingFlags] = useState<string[]>([])
  const [fairHousing, setFairHousing] = useState<{ rewrites: number; escalated: boolean; findings: Array<{ phrase: string; fix: string }> }>({ rewrites: 0, escalated: false, findings: [] })
  const [clonedFromName, setClonedFromName] = useState<string | null>(null)
  const [landingBase, setLandingBase] = useState<LandingContent | null>(null)
  const [magnetType, setMagnetType] = useState("generic_form")
  const [defaultContactType, setDefaultContactType] = useState("")
  const [bookStage, setBookStage] = useState<string | null>(null)

  const [name, setName] = useState("")
  const [headline, setHeadline] = useState("")
  const [subhead, setSubhead] = useState("")
  const [cta, setCta] = useState("")
  const [bullets, setBullets] = useState("")
  const [thankYou, setThankYou] = useState("")
  const [fields, setFields] = useState<LeadMagnetField[]>([])
  const [channels, setChannels] = useState<PublishChannel[]>(["landing_page", "qr_code"])

  useEffect(() => {
    let live = true
    setLoading(true)
    getLeadMagnetDraftAction(magnetId).then((r) => {
      if (!live) return
      if (!r.success) { setError(r.error ?? "Could not load this lead magnet"); setLoading(false); return }
      const m = r.magnet
      setSlug(m.slug)
      setLifecycleState(m.lifecycleState)
      setIsActive(m.isActive)
      setAuthoredBy(m.authoredBy)
      setAuthoringNote(m.authoringNote)
      setFairHousingFlags(m.fairHousingFlags)
      setFairHousing(m.fairHousing)
      setClonedFromName(m.clonedFromName)
      setLandingBase(m.landing)
      setMagnetType(m.magnetType)
      setDefaultContactType(m.defaultContactType)
      setBookStage(m.bookStage)
      setName(m.name)
      setHeadline(m.landing?.headline ?? "")
      setSubhead(m.landing?.subhead ?? "")
      setCta(m.landing?.cta ?? "")
      setBullets((m.landing?.bullets ?? []).join("\n"))
      setThankYou(m.thankYouMessage)
      setFields(m.fields)
      setLoading(false)
    })
    return () => { live = false }
  }, [magnetId])

  function patchField(i: number, patch: Partial<LeadMagnetField>) {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
  }
  function addField() {
    setFields((prev) => {
      const n = prev.length + 1
      let fname = `question_${n}`
      while (prev.some((f) => f.name === fname)) fname = `${fname}_x`
      return [...prev, { name: fname, label: "", type: "text", required: false }]
    })
  }
  function removeField(i: number) {
    setFields((prev) => prev.filter((f, idx) => idx !== i || CANONICAL_FIELD_NAMES.has(f.name)))
  }

  async function save(): Promise<boolean> {
    setError(null)
    setNotice(null)
    if (!name.trim()) { setError("The title is required"); return false }
    if (!headline.trim()) { setError("The headline is required — it is the offer a visitor hands over their details for"); return false }
    const cleanFields = fields.filter((f) => f.label.trim())
    const landing: LandingContent = {
      headline: headline.trim(),
      subhead: subhead.trim(),
      cta: cta.trim() || "Get started",
      bullets: bullets.split("\n").map((b) => b.trim()).filter(Boolean),
      topics: landingBase?.topics ?? [],
      faq: landingBase?.faq ?? [],
      faqJsonLd: landingBase?.faqJsonLd ?? null,
      fromTopics: landingBase?.fromTopics ?? false,
      generatedAt: landingBase?.generatedAt ?? new Date().toISOString(),
      videoUrl: landingBase?.videoUrl ?? null,
      videoProjectId: landingBase?.videoProjectId ?? null,
    }
    const saved = await saveMagnetLandingContentAction(magnetId, landing)
    if (!saved.success) { setError(saved.error ?? "The page copy was not saved"); return false }
    const settings = await updateMagnetSettingsAction(magnetId, { name: name.trim(), thankYouMessage: thankYou.trim(), fields: cleanFields, ...(magnetType === "generic_form" ? { defaultContactType } : {}) })
    if (!settings.success) { setError(settings.error ?? "The settings were not saved"); return false }
    setLandingBase(landing)
    onSaved?.()
    return true
  }

  function handleSave() {
    startTransition(async () => {
      if (await save()) setNotice("Saved.")
    })
  }

  function handleApproveAndPublish() {
    startTransition(async () => {
      if (!(await save())) return
      const result = await publishLeadMagnetAction(magnetId, channels)
      if (!result.success) { setError(result.error ?? "Publish failed"); return }
      setLifecycleState("published")
      setIsActive(true)
      setNotice(`Published — live at /lm/${slug}`)
      onPublished?.(magnetId, slug)
    })
  }

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">Loading draft...</div>
  }
  if (error && !name) {
    return <div className="flex items-center justify-center py-16 text-sm text-destructive">{error}</div>
  }

  const isDraft = lifecycleState === "draft"

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 flex-wrap">
          <CardTitle>{isDraft ? "Review and publish" : "Edit lead magnet"}</CardTitle>
          {isDraft ? <Badge variant="outline" className="border-amber-400 text-amber-800">Draft</Badge> : <Badge variant={isActive ? "default" : "secondary"}>{isActive ? "Live" : "Paused"}</Badge>}
          {authoredBy === "ai" && <Badge variant="outline" className="flex items-center gap-1"><Wand2 className="h-3 w-3" /> AI draft</Badge>}
        </div>
        <CardDescription>
          {isDraft
            ? "Nothing here is public yet. Edit anything, then approve and publish to make the page live."
            : "Changes save to the live page immediately."}
          {clonedFromName ? ` Cloned from "${clonedFromName}".` : ""}
        </CardDescription>
        {authoringNote && <p className="text-xs text-amber-800">{authoringNote}</p>}
        {fairHousing.escalated ? (
          <div className="text-xs text-destructive space-y-1" role="alert">
            <p>Fair-housing review needed: the AI rewrote this copy {fairHousing.rewrites} time{fairHousing.rewrites === 1 ? "" : "s"} and it still mentioned {fairHousing.findings.map((f) => `"${f.phrase}"`).join(", ") || fairHousingFlags.join(", ")}. The safe baseline is on the page — publishing re-checks the copy and refuses a hard flag.</p>
            {fairHousing.findings.length > 0 && <ul className="list-disc pl-4">{fairHousing.findings.map((f) => <li key={f.phrase}>{f.phrase} → {f.fix}</li>)}</ul>}
          </div>
        ) : fairHousingFlags.length > 0 ? (
          <p className="text-xs text-amber-800">Fair-housing review: an earlier draft mentioned {fairHousingFlags.join(", ")}{fairHousing.rewrites > 0 ? ` — the AI rewrote it ${fairHousing.rewrites} time${fairHousing.rewrites === 1 ? "" : "s"} and the current copy is clean` : ""}. Publishing re-checks the copy.</p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-6">
        {bookStage && (
          <BookProjectPanel magnetId={magnetId} onStage={setBookStage} />
        )}
        <div className="space-y-2">
          <Label htmlFor="dr-name">Title</Label>
          <Input id="dr-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="dr-headline">Headline</Label>
            <Input id="dr-headline" value={headline} onChange={(e) => setHeadline(e.target.value)} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="dr-subhead">Subheadline</Label>
            <Textarea id="dr-subhead" value={subhead} onChange={(e) => setSubhead(e.target.value)} rows={2} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dr-cta">Button label</Label>
            <Input id="dr-cta" value={cta} onChange={(e) => setCta(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dr-thanks">Thank-you message</Label>
            <Input id="dr-thanks" value={thankYou} onChange={(e) => setThankYou(e.target.value)} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="dr-bullets">Benefit bullets <span className="text-muted-foreground text-xs">(one per line)</span></Label>
            <Textarea id="dr-bullets" value={bullets} onChange={(e) => setBullets(e.target.value)} rows={3} />
          </div>
        </div>

        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Questions on the form</p>
              <p className="text-xs text-muted-foreground">Contact fields are always asked; edit or add the rest.</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addField}><Plus className="h-4 w-4 mr-1" /> Add question</Button>
          </div>
          {fields.map((f, i) => {
            const canonical = CANONICAL_FIELD_NAMES.has(f.name)
            return (
              <div key={f.name} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 items-center">
                <Input aria-label={`Question ${i + 1}`} value={f.label} onChange={(e) => patchField(i, { label: e.target.value })} disabled={canonical} />
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={f.required} onCheckedChange={(v) => patchField(i, { required: Boolean(v) })} disabled={canonical && (f.name === "email" || f.name === "first_name" || f.name === "last_name")} />
                  Required
                </label>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove question ${i + 1}`} disabled={canonical} onClick={() => removeField(i)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )
          })}
        </div>

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
          </div>
        )}

        {isDraft && (
          <div className="space-y-2">
            <Label>Publish to</Label>
            <div className="grid grid-cols-2 gap-2">
              {PUBLISH_CHANNELS.map((ch) => (
                <label key={ch.id} className="flex items-center gap-2 rounded-lg border p-2 text-sm cursor-pointer">
                  <Checkbox checked={channels.includes(ch.id)} onCheckedChange={() => setChannels((prev) => prev.includes(ch.id) ? prev.filter((c) => c !== ch.id) : [...prev, ch.id])} />
                  {ch.label}
                </label>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        {notice && <p className="text-sm text-green-700 flex items-center gap-1"><CheckCircle2 className="h-4 w-4" /> {notice}</p>}

        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={handleSave} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            Save
          </Button>
          {isDraft && (
            <Button onClick={handleApproveAndPublish} disabled={isPending || channels.length === 0 || (!!bookStage && bookStage !== "ready_for_review")} className="flex-1" title={bookStage && bookStage !== "ready_for_review" ? "The book is still being written" : undefined}>
              {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
              {bookStage && bookStage !== "ready_for_review" ? "Finish the book to publish" : "Approve and publish"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
