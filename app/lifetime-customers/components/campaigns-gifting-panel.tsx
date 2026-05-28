"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sparkles,
  Gift,
  Mail,
  Send,
  Loader2,
  Heart,
  PartyPopper,
  ExternalLink,
} from "lucide-react"
import { toast } from "sonner"
import {
  listCampaignSequences,
  enrollContactInSequence,
} from "@/app/actions/campaign-sequences"
import type { CampaignSequence } from "@/lib/campaigns/sequence-constants"
import {
  aiRecommendGift,
  createGiftOrder,
  aiGenerateThankYouNote,
} from "@/app/actions/ai-client-gifting"
import { aiGenerateEventInvitation } from "@/app/actions/ai-sphere-management"

interface LifetimeContact {
  id: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}

interface Props {
  brokerageId: string
  agentId: string
  contacts: LifetimeContact[]
}

const GIFT_OCCASIONS = [
  { value: "closing", label: "Closing gift" },
  { value: "anniversary", label: "Home anniversary" },
  { value: "birthday", label: "Birthday" },
  { value: "referral_thank_you", label: "Referral thank-you" },
  { value: "holiday", label: "Holiday" },
  { value: "congratulations", label: "Congratulations" },
] as const

type Occasion = typeof GIFT_OCCASIONS[number]["value"]

export function CampaignsGiftingPanel({ brokerageId, agentId, contacts }: Props) {
  const [isPending, startTransition] = useTransition()

  // Campaigns
  const [sequences, setSequences] = useState<CampaignSequence[]>([])
  const [sequencesLoading, setSequencesLoading] = useState(true)
  const [enrollSeqId, setEnrollSeqId] = useState<string | null>(null)
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set())

  // Gift dialog
  const [giftOpen, setGiftOpen] = useState(false)
  const [giftContactId, setGiftContactId] = useState<string>("")
  const [giftOccasion, setGiftOccasion] = useState<Occasion>("closing")
  const [giftRecommendation, setGiftRecommendation] = useState<any>(null)
  const [giftNote, setGiftNote] = useState<string>("")
  const [giftDeliveryAddress, setGiftDeliveryAddress] = useState<string>("")
  const [giftBusy, setGiftBusy] = useState(false)
  const [thankYouNote, setThankYouNote] = useState<string | null>(null)

  // Event invite dialog
  const [eventOpen, setEventOpen] = useState(false)
  const [eventName, setEventName] = useState("")
  const [eventDate, setEventDate] = useState("")
  const [eventLocation, setEventLocation] = useState("")
  const [eventDetails, setEventDetails] = useState("")
  const [eventCopy, setEventCopy] = useState<{ email?: string; sms?: string; social?: string } | null>(null)
  const [eventBusy, setEventBusy] = useState(false)

  // Load sequences once
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await listCampaignSequences(brokerageId)
        if (cancelled) return
        if ((result as any).sequences) setSequences((result as any).sequences as CampaignSequence[])
        else if (Array.isArray(result)) setSequences(result as CampaignSequence[])
      } finally {
        if (!cancelled) setSequencesLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [brokerageId])

  const lifetimeSequences = useMemo(
    () =>
      sequences.filter((s) => {
        const t = (s.sequence_type ?? "").toLowerCase()
        const trigger = (s.trigger_event ?? "").toLowerCase()
        return (
          t.includes("sphere") ||
          t.includes("post_close") ||
          t.includes("nurture") ||
          trigger.includes("anniversary") ||
          trigger.includes("birthday") ||
          trigger.includes("lifetime")
        )
      }),
    [sequences],
  )

  function toggleContact(id: string) {
    setSelectedContactIds((curr) => {
      const next = new Set(curr)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAll() {
    setSelectedContactIds(new Set(contacts.map((c) => c.id)))
  }

  function clearAll() {
    setSelectedContactIds(new Set())
  }

  async function enrollSelected(sequenceId: string) {
    if (selectedContactIds.size === 0) {
      toast.error("Select at least one contact to enroll.")
      return
    }
    startTransition(async () => {
      let ok = 0
      let fail = 0
      for (const cid of Array.from(selectedContactIds)) {
        try {
          await enrollContactInSequence({ contactId: cid, sequenceId })
          ok += 1
        } catch {
          fail += 1
        }
      }
      if (ok > 0) toast.success(`Enrolled ${ok} contact${ok === 1 ? "" : "s"}.`)
      if (fail > 0) toast.error(`${fail} enrollment${fail === 1 ? "" : "s"} failed.`)
      setEnrollSeqId(null)
      setSelectedContactIds(new Set())
    })
  }

  // ── GIFT FLOW ──────────────────────────────────────────────────────────────
  function openGift(contactId: string) {
    setGiftContactId(contactId)
    setGiftOccasion("closing")
    setGiftRecommendation(null)
    setGiftNote("")
    setGiftDeliveryAddress("")
    setThankYouNote(null)
    setGiftOpen(true)
  }

  async function recommendGift() {
    setGiftBusy(true)
    try {
      const result = await aiRecommendGift({
        agentId,
        contactId: giftContactId,
        occasion: giftOccasion,
      })
      if ((result as any).success) {
        const recs = (result as any).recommendations ?? (result as any).gift ?? null
        const top = Array.isArray(recs) ? recs[0] : recs
        setGiftRecommendation(top)
        setGiftNote(top?.personalNote ?? "")
      } else {
        toast.error((result as any).error ?? "Couldn't recommend a gift.")
      }
    } finally {
      setGiftBusy(false)
    }
  }

  async function placeGiftOrder() {
    if (!giftRecommendation) return
    setGiftBusy(true)
    try {
      const result = await createGiftOrder({
        agentId,
        contactId: giftContactId,
        giftDetails: {
          name: giftRecommendation.name ?? giftRecommendation.title ?? "Gift",
          description: giftRecommendation.description ?? "",
          cost: Number(giftRecommendation.cost ?? giftRecommendation.estimated_cost ?? 0),
          vendor: giftRecommendation.vendor ?? giftRecommendation.vendor_name ?? "TBD",
          occasion: giftOccasion,
          personalNote: giftNote || undefined,
        },
        deliveryAddress: giftDeliveryAddress || undefined,
      })
      if ((result as any).success) {
        toast.success("Gift order placed.")
        // Auto-draft a thank-you note for the agent to schedule.
        const noteResult = await aiGenerateThankYouNote({
          agentId,
          contactId: giftContactId,
          occasion: giftOccasion,
          giftSent: giftRecommendation.name ?? "the gift",
        } as any)
        if ((noteResult as any).success) {
          setThankYouNote((noteResult as any).note ?? (noteResult as any).text ?? null)
        }
      } else {
        toast.error((result as any).error ?? "Order failed.")
      }
    } finally {
      setGiftBusy(false)
    }
  }

  // ── EVENT INVITE ───────────────────────────────────────────────────────────
  async function generateEventCopy() {
    if (!eventName.trim() || !eventDate) {
      toast.error("Event name and date are required.")
      return
    }
    setEventBusy(true)
    try {
      const result = await aiGenerateEventInvitation({
        agentId,
        eventDetails: {
          name: eventName,
          date: eventDate,
          location: eventLocation || "TBD",
          description: eventDetails || "",
        },
      } as any)
      if ((result as any).success) {
        const data = (result as any).data ?? (result as any).invitation ?? {}
        setEventCopy({
          email: data.email ?? data.emailCopy ?? "",
          sms: data.sms ?? data.smsCopy ?? "",
          social: data.social ?? data.socialCopy ?? "",
        })
      } else {
        toast.error((result as any).error ?? "Couldn't generate invitation copy.")
      }
    } finally {
      setEventBusy(false)
    }
  }

  function copyToClipboard(text?: string) {
    if (!text) return
    navigator.clipboard.writeText(text)
    toast.success("Copied to clipboard.")
  }

  return (
    <div className="space-y-6">
      {/* ── CAMPAIGNS ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" />
            Retention campaigns
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {sequencesLoading ? (
            <p className="text-sm text-muted-foreground">Loading sequences…</p>
          ) : lifetimeSequences.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No lifetime-customer sequences yet.{" "}
              <Link href="/dashboard/campaigns/sequences" className="underline text-primary">
                Build one in the Workflow Builder
              </Link>
              .
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {lifetimeSequences.map((seq) => (
                <Card key={seq.id} className="border-muted">
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{seq.name}</p>
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {seq.description ?? seq.sequence_type}
                        </p>
                      </div>
                      <Badge variant={seq.is_active ? "default" : "secondary"} className="text-xs shrink-0">
                        {seq.is_active ? "Active" : "Draft"}
                      </Badge>
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{seq.enrollments_total ?? 0} enrolled</span>
                      <span>{seq.completions_total ?? 0} completed</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={() => setEnrollSeqId(seq.id)}
                    >
                      Enroll contacts
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── GIFTING + EVENT TOOLBAR ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Gift className="h-4 w-4 text-rose-600" />
              Send a gift
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Pick a contact to send a closing, anniversary, birthday, or thank-you gift. AI suggests
              the gift; the order routes to the vendor marketplace; a thank-you note is auto-drafted.
            </p>
            <Select value={giftContactId} onValueChange={(v) => openGift(v)}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a contact…" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {contacts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.first_name ?? ""} {c.last_name ?? ""} {c.email ? `(${c.email})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <PartyPopper className="h-4 w-4 text-violet-600" />
              Event invitation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Generate email + text + social copy for a client event (appreciation party, market update
              webinar, open house, community event).
            </p>
            <Button onClick={() => setEventOpen(true)} variant="outline" className="w-full">
              <Mail className="h-4 w-4 mr-2" />
              Compose invitation
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* ── ENROLL DIALOG ─────────────────────────────────────────────────── */}
      <Dialog
        open={enrollSeqId !== null}
        onOpenChange={(open) => !open && setEnrollSeqId(null)}
      >
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Enroll contacts in sequence</DialogTitle>
            <DialogDescription>
              Select the lifetime customers you want to enroll in this sequence.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{selectedContactIds.size} of {contacts.length} selected</span>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={selectAll}>Select all</Button>
                <Button size="sm" variant="ghost" onClick={clearAll}>Clear</Button>
              </div>
            </div>
            <div className="rounded-lg border max-h-72 overflow-y-auto divide-y">
              {contacts.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/30"
                >
                  <input
                    type="checkbox"
                    checked={selectedContactIds.has(c.id)}
                    onChange={() => toggleContact(c.id)}
                  />
                  <span className="text-sm flex-1 truncate">
                    {c.first_name ?? ""} {c.last_name ?? ""}
                  </span>
                  {c.email && <span className="text-xs text-muted-foreground truncate">{c.email}</span>}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnrollSeqId(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => enrollSeqId && enrollSelected(enrollSeqId)}
              disabled={isPending || selectedContactIds.size === 0}
            >
              {isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              Enroll {selectedContactIds.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── GIFT DIALOG ───────────────────────────────────────────────────── */}
      <Dialog open={giftOpen} onOpenChange={setGiftOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gift className="h-4 w-4 text-rose-600" />
              Send a gift
            </DialogTitle>
            <DialogDescription>
              {contacts.find((c) => c.id === giftContactId)?.first_name ?? ""}{" "}
              {contacts.find((c) => c.id === giftContactId)?.last_name ?? ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Occasion</Label>
              <Select value={giftOccasion} onValueChange={(v) => setGiftOccasion(v as Occasion)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GIFT_OCCASIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!giftRecommendation && (
              <Button onClick={recommendGift} disabled={giftBusy} className="w-full">
                {giftBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                Recommend a gift
              </Button>
            )}

            {giftRecommendation && (
              <Card>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold">{giftRecommendation.name ?? giftRecommendation.title ?? "Gift"}</p>
                    {giftRecommendation.cost != null && (
                      <Badge variant="outline" className="text-xs">
                        ${Number(giftRecommendation.cost).toFixed(0)}
                      </Badge>
                    )}
                  </div>
                  {giftRecommendation.description && (
                    <p className="text-xs text-muted-foreground">{giftRecommendation.description}</p>
                  )}
                  {giftRecommendation.vendor && (
                    <p className="text-xs text-muted-foreground">Vendor: {giftRecommendation.vendor}</p>
                  )}
                  <div>
                    <Label className="text-xs">Personal note</Label>
                    <Textarea
                      value={giftNote}
                      onChange={(e) => setGiftNote(e.target.value)}
                      rows={3}
                      placeholder="Hand-written note that goes with the gift…"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Delivery address (optional)</Label>
                    <Input
                      value={giftDeliveryAddress}
                      onChange={(e) => setGiftDeliveryAddress(e.target.value)}
                      placeholder="123 Main St, City, ST 12345"
                    />
                  </div>
                  <Button onClick={placeGiftOrder} disabled={giftBusy} className="w-full">
                    {giftBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Gift className="h-4 w-4 mr-2" />}
                    Place gift order
                  </Button>
                </CardContent>
              </Card>
            )}

            {thankYouNote && (
              <Card className="border-emerald-200 bg-emerald-50">
                <CardContent className="p-3 space-y-2">
                  <p className="text-xs font-semibold text-emerald-900 flex items-center gap-1">
                    <Heart className="h-3 w-3" /> AI-drafted thank-you note
                  </p>
                  <p className="text-xs text-emerald-900 whitespace-pre-wrap">{thankYouNote}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(thankYouNote)}
                  >
                    Copy note
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── EVENT INVITE DIALOG ──────────────────────────────────────────── */}
      <Dialog open={eventOpen} onOpenChange={setEventOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PartyPopper className="h-4 w-4 text-violet-600" />
              Compose event invitation
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Event name</Label>
                <Input value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="Client appreciation party" />
              </div>
              <div>
                <Label className="text-xs">Date</Label>
                <Input type="datetime-local" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
              </div>
            </div>
            <div>
              <Label className="text-xs">Location</Label>
              <Input value={eventLocation} onChange={(e) => setEventLocation(e.target.value)} placeholder="Address or virtual link" />
            </div>
            <div>
              <Label className="text-xs">Details</Label>
              <Textarea value={eventDetails} onChange={(e) => setEventDetails(e.target.value)} rows={3} placeholder="What's happening, who's invited, etc." />
            </div>
            <Button onClick={generateEventCopy} disabled={eventBusy} className="w-full">
              {eventBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
              Generate copy
            </Button>

            {eventCopy && (
              <div className="space-y-3 mt-2">
                {(["email", "sms", "social"] as const).map((channel) => {
                  const text = (eventCopy as any)[channel] as string | undefined
                  if (!text) return null
                  return (
                    <Card key={channel}>
                      <CardContent className="p-3 space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {channel}
                        </p>
                        <p className="text-xs whitespace-pre-wrap">{text}</p>
                        <Button size="sm" variant="outline" onClick={() => copyToClipboard(text)}>
                          Copy
                        </Button>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button asChild variant="outline">
              <Link href="/dashboard/campaigns/sequences">
                Build follow-up sequence <ExternalLink className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
