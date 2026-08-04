"use client"

import { useState, useTransition, useEffect, useCallback } from "react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  Star,
  MessageSquare,
  Gift,
  ThumbsUp,
  Send,
  Copy,
  Loader2,
  Sparkles,
  Check,
  Heart,
  BookTemplate,
  Clock,
  PackageCheck,
  PlusCircle,
  Mail,
  Phone,
  PenLine,
  History,
  ExternalLink,
} from "lucide-react"
import {
  aiGenerateReviewRequest,
  aiExtractTestimonials,
} from "@/app/actions/ai-review-automation"
import { aiRecommendGift, aiGenerateThankYouNote } from "@/app/actions/ai-client-gifting"
import {
  sendThankYouNoteAction,
  assignGiftAction,
  markGiftSentAction,
  loadThankYouTemplatesAction,
  saveThankYouTemplateAction,
  loadNoteHistoryAction,
  loadGiftHistoryAction,
  createReviewRequestAction,
  loadReviewPerformanceAction,
} from "@/app/actions/reputation-kernel"
import { getReputationPreferences, saveReputationPreferences } from "@/app/actions/settings/reputation-preferences"

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReputationPanelProps {
  agentId:        string
  brokerageId?:   string
  clients?:       any[]
  reviews?:       any[]
  recentClosings?: any[]
}

const OCCASIONS = [
  { value: "closing",            label: "Closing" },
  { value: "anniversary",        label: "Home Anniversary" },
  { value: "birthday",           label: "Birthday" },
  { value: "referral_thank_you", label: "Referral Thank You" },
  { value: "holiday",            label: "Holiday" },
  { value: "congratulations",    label: "Congratulations" },
  { value: "general",            label: "General" },
]

const CHANNELS = [
  { value: "email",       label: "Email",       icon: Mail     },
  { value: "sms",         label: "SMS / Text",  icon: Phone    },
  { value: "handwritten", label: "Handwritten", icon: PenLine  },
]

const GIFT_TYPES = [
  { value: "physical",   label: "Physical Gift"  },
  { value: "digital",    label: "Digital / eGift"},
  { value: "experience", label: "Experience"     },
  { value: "gift_card",  label: "Gift Card"      },
  { value: "donation",   label: "Donation"       },
]

// A picker stores a VALUE and shows a LABEL, and the value set belongs to the
// constraint. agent_reviews_platform_check (verified live in pg_constraint)
// admits google | zillow | realtor_com | internal | facebook | yelp. This list
// stored "realtor", which is in no constraint and matches no recorded review, so
// a request raised on Realtor.com could never be reconciled against the review
// that answered it. `internal` is excluded on purpose: it is the platform the
// app writes for its own in-portal reviews, not something an agent asks for.
const REVIEW_PLATFORMS: Array<{ value: string; label: string }> = [
  { value: "google",      label: "Google"      },
  { value: "zillow",      label: "Zillow"      },
  { value: "realtor_com", label: "Realtor.com" },
  { value: "facebook",    label: "Facebook"    },
  { value: "yelp",        label: "Yelp"        },
]

/**
 * The AI DRAFT generator (app/actions/ai-review-automation.ts) carries its own
 * older literal union and keys its URL map on "realtor". That is a different
 * vocabulary from the one the COLUMN accepts, and the two must not be conflated
 * — so the stored value stays realtor_com and only the draft call is translated.
 */
const DRAFT_PLATFORM: Record<string, "google" | "zillow" | "realtor" | "yelp" | "facebook"> = {
  google: "google", zillow: "zillow", realtor_com: "realtor", facebook: "facebook", yelp: "yelp",
}

/** Filters must speak the same vocabulary the rows are stored in. */
const REVIEW_FILTER_PLATFORMS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  ...REVIEW_PLATFORMS,
  { value: "internal", label: "In-app" },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function interpolateTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending:     "bg-yellow-50 text-yellow-700 border-yellow-200",
    sent:        "bg-blue-50 text-blue-700 border-blue-200",
    delivered:   "bg-green-50 text-green-700 border-green-200",
    recommended: "bg-slate-50 text-slate-600 border-slate-200",
    ordered:     "bg-purple-50 text-purple-700 border-purple-200",
    failed:      "bg-red-50 text-red-700 border-red-200",
  }
  return map[status] ?? "bg-slate-50 text-slate-600 border-slate-200"
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ReputationPanel({
  agentId,
  clients       = [],
  reviews       = [],
  recentClosings = [],
}: ReputationPanelProps) {
  const [isPending, startTransition] = useTransition()

  // ── Shared ──────────────────────────────────────────
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // J8 Gap 8.2 — review filters + auto-respond preferences
  const [reviewFilterPlatform, setReviewFilterPlatform] = useState<string>("all")
  const [reviewFilterRange, setReviewFilterRange] = useState<"30d" | "90d" | "all">("all")
  const [autoRespondMode, setAutoRespondMode] = useState<"off" | "review" | "auto">("off")
  const [autoRespondApprovalHours, setAutoRespondApprovalHours] = useState<number>(24)
  const [prefsLoaded, setPrefsLoaded] = useState(false)

  // Load preferences on mount
  useEffect(() => {
    if (!agentId || prefsLoaded) return
    getReputationPreferences(agentId).then((prefs) => {
      setAutoRespondMode(prefs.autoRespondMode)
      setAutoRespondApprovalHours(prefs.autoRespondApprovalHours)
      setPrefsLoaded(true)
    })
  }, [agentId, prefsLoaded])

  // Persist auto-respond mode change
  const handleAutoRespondModeChange = useCallback((mode: "off" | "review" | "auto") => {
    setAutoRespondMode(mode)
    if (agentId) {
      saveReputationPreferences(agentId, { autoRespondMode: mode, autoRespondApprovalHours })
        .then((res) => { if (!res.success) toast.error("Failed to save preference") })
    }
  }, [agentId, autoRespondApprovalHours])

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  // ── Review request ───────────────────────────────────
  const [reviewPlatform,    setReviewPlatform]    = useState("google")
  const [reviewDraft,       setReviewDraft]        = useState("")
  const [reviewClient,      setReviewClient]       = useState<any>(null)
  const [reviewDialogOpen,  setReviewDialogOpen]   = useState(false)
  const [loggingRequest,    setLoggingRequest]     = useState(false)

  // ── REPUTATION PERFORMANCE ────────────────────────────────────────────────
  //
  // The four tiles above are computed from the `reviews` prop, so they can only
  // ever say "how many" and "how good". Response rate, per-platform breakdown
  // and direction of travel are computed server-side by the reputation kernel
  // and were reaching no screen at all. This read is scoped to the acting agent
  // by the action itself — no id crosses the wire.
  //
  // `null` is "not loaded yet"; a refusal is kept as its own state so an
  // unreadable performance strip cannot be mistaken for a spotless one.
  const [performance, setPerformance] = useState<{
    avgRating: number
    totalReviews: number
    responseRate: number
    byPlatform: Record<string, { count: number; avgRating: number }>
    recentTrend: "improving" | "stable" | "declining"
  } | null>(null)
  const [performanceError, setPerformanceError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadReviewPerformanceAction().then((res) => {
      if (cancelled) return
      if (res.success && (res as any).data) {
        setPerformance((res as any).data)
        setPerformanceError(null)
      } else {
        setPerformance(null)
        setPerformanceError((res as { error?: string })?.error ?? "Reputation performance could not be loaded.")
      }
    })
    return () => { cancelled = true }
  }, [])

  const reviewReadyClients = recentClosings.filter((c: any) => {
    const d = new Date(c.actual_close_date || c.close_date || Date.now())
    const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
    return days >= 7 && days <= 30
  })

  function handleGenerateReview(client: any) {
    const transactionId = client.transaction_id || client.transactionId || client.id
    if (!transactionId) { toast.error("No transaction found"); return }
    setReviewClient(client)
    setReviewDraft("")
    startTransition(async () => {
      const result = await aiGenerateReviewRequest({
        transactionId,
        agentId,
        platform: DRAFT_PLATFORM[reviewPlatform] ?? "google",
        channel:  "email",
      })
      if (result.success && result.message) {
        setReviewDraft(result.message)
        setReviewDialogOpen(true)
      } else {
        toast.error(result.error ?? "Failed to generate review request")
      }
    })
  }

  // ── Thank you notes ──────────────────────────────────
  const [tyClient,       setTyClient]        = useState<any>(null)
  const [tyOccasion,     setTyOccasion]      = useState("closing")
  const [tyChannel,      setTyChannel]       = useState("email")
  const [tyDraft,        setTyDraft]         = useState("")
  const [tySubject,      setTySubject]       = useState("A personal note from your agent")
  const [tyDialogOpen,   setTyDialogOpen]    = useState(false)
  const [tySending,      setTySending]       = useState(false)

  // Templates
  const [templates,         setTemplates]         = useState<any[]>([])
  const [templatesLoaded,   setTemplatesLoaded]   = useState(false)
  const [saveTemplateOpen,  setSaveTemplateOpen]  = useState(false)
  const [templateName,      setTemplateName]      = useState("")
  const [savingTemplate,    setSavingTemplate]    = useState(false)

  // Note history
  const [noteHistory,       setNoteHistory]       = useState<any[]>([])
  const [noteHistoryOpen,   setNoteHistoryOpen]   = useState(false)

  async function loadTemplates(occasion?: string) {
    const result = await loadThankYouTemplatesAction(occasion)
    if (result.success) setTemplates(result.templates ?? [])
    setTemplatesLoaded(true)
  }

  function openThankYouDialog(client: any) {
    setTyClient(client)
    setTyDraft("")
    setTySubject("A personal note from your agent")
    setNoteHistory([])
    setTyDialogOpen(true)
    if (!templatesLoaded) loadTemplates()
    // Load note history for this client
    const contactId = client.contact_id || client.id
    if (contactId) {
      loadNoteHistoryAction(contactId).then(r => {
        if (r.success) setNoteHistory(r.notes ?? [])
      })
    }
  }

  function applyTemplate(tpl: any) {
    const firstName = tyClient?.contacts?.first_name || tyClient?.first_name || ""
    const lastName  = tyClient?.contacts?.last_name  || tyClient?.last_name  || ""
    const vars = {
      first_name:       firstName,
      last_name:        lastName,
      property_address: tyClient?.property_address || "",
      agent_name:       "Your Agent",
      referred_name:    "",
    }
    if (tpl.subject) setTySubject(interpolateTemplate(tpl.subject, vars))
    setTyDraft(interpolateTemplate(tpl.body, vars))
    setTyChannel(tpl.channel || "email")
    setTyOccasion(tpl.occasion || "general")
  }

  function handleGenerateThankYou() {
    if (!tyClient) return
    const contactId = tyClient.contact_id || tyClient.id
    if (!contactId) { toast.error("No contact found"); return }
    startTransition(async () => {
      const result = await aiGenerateThankYouNote({
        agentId,
        contactId,
        occasion:    tyOccasion as any,
        handwritten: tyChannel === "handwritten",
      })
      if (result.success && result.data?.note) {
        setTyDraft(result.data.note)
      } else {
        toast.error(result.error ?? "Failed to generate note")
      }
    })
  }

  async function handleSendThankYou() {
    if (!tyDraft || !tyClient) return
    setTySending(true)
    try {
      const contactId    = tyClient.contact_id || tyClient.id
      const contactEmail = tyClient.contacts?.email || tyClient.email || ""
      const contactName  = `${tyClient.contacts?.first_name || tyClient.first_name || ""} ${tyClient.contacts?.last_name || tyClient.last_name || ""}`.trim()
      const result = await sendThankYouNoteAction({
        contactId,
        contactEmail,
        contactName,
        noteText:      tyDraft,
        subject:       tySubject,
        occasion:      tyOccasion,
        channel:       tyChannel,
        transactionId: tyClient.id,
      })
      if (result.success) {
        // All three channels now really dispatch — email through the email lane,
        // sms through dispatchSms, and the handwritten card down the SAME
        // direct-mail line as a postcard (owner's ruling). The old copy said
        // "marked as sent" for the last two because nothing sent them.
        toast.success(
          tyChannel === "email" ? "Note sent via email"
          : tyChannel === "sms" ? "Text sent"
          : "Card sent to print & mail",
        )
        setTyDialogOpen(false)
      } else {
        toast.error(result.error ?? "Failed to send note")
      }
    } finally {
      setTySending(false)
    }
  }

  async function handleSaveTemplate() {
    if (!templateName || !tyDraft) { toast.error("Give the template a name"); return }
    setSavingTemplate(true)
    try {
      const result = await saveThankYouTemplateAction({
        name:    templateName,
        occasion: tyOccasion,
        channel:  tyChannel,
        subject:  tyChannel === "email" ? tySubject : undefined,
        body:     tyDraft,
      })
      if (result.success) {
        toast.success("Template saved")
        setSaveTemplateOpen(false)
        setTemplateName("")
        loadTemplates()
      } else {
        toast.error(result.error ?? "Failed to save template")
      }
    } finally {
      setSavingTemplate(false)
    }
  }

  // ── Gifting ──────────────────────────────────────────
  const [giftClient,      setGiftClient]      = useState<any>(null)
  const [giftOccasion,    setGiftOccasion]    = useState("closing")
  const [giftBudgetMin,   setGiftBudgetMin]   = useState(50)
  const [giftBudgetMax,   setGiftBudgetMax]   = useState(200)
  const [giftType,        setGiftType]        = useState("physical")
  const [giftRec,         setGiftRec]         = useState<any>(null)
  const [giftNote,        setGiftNote]        = useState("")
  const [giftDialogOpen,  setGiftDialogOpen]  = useState(false)
  const [assigningGift,   setAssigningGift]   = useState(false)
  const [giftHistory,     setGiftHistory]     = useState<any[]>([])
  const [giftHistoryOpen, setGiftHistoryOpen] = useState(false)
  const [markingSent,     setMarkingSent]     = useState<string | null>(null)

  function openGiftDialog(client: any) {
    setGiftClient(client)
    setGiftRec(null)
    setGiftNote("")
    setGiftHistory([])
    setGiftDialogOpen(true)
    const contactId = client.id || client.contact_id
    if (contactId) {
      loadGiftHistoryAction(contactId).then(r => {
        if (r.success) setGiftHistory(r.gifts ?? [])
      })
    }
  }

  function handleRecommendGift() {
    if (!giftClient) return
    const contactId = giftClient.id || giftClient.contact_id
    if (!contactId) { toast.error("No contact found"); return }
    startTransition(async () => {
      const result = await aiRecommendGift({
        agentId,
        contactId,
        occasion: giftOccasion as any,
        budget:   { min: giftBudgetMin, max: giftBudgetMax },
      })
      if (result.success && result.data) {
        setGiftRec(result.data)
      } else {
        toast.error(result.error ?? "Failed to generate gift recommendation")
      }
    })
  }

  async function handleAssignGift(gift: any) {
    if (!giftClient) return
    setAssigningGift(true)
    try {
      const result = await assignGiftAction({
        contactId:           giftClient.id || giftClient.contact_id,
        contactName:         `${giftClient.first_name || ""} ${giftClient.last_name || ""}`.trim(),
        giftName:            gift.name,
        giftDescription:     gift.description,
        giftType,
        vendorName:          gift.vendor || undefined,
        vendorUrl:           gift.purchaseUrl || undefined,
        budget:              gift.estimatedCost,
        budgetMin:           giftBudgetMin,
        budgetMax:           giftBudgetMax,
        occasion:            giftOccasion,
        personalizationNote: giftNote || undefined,
        aiReasoning:         gift.whyThisGift || undefined,
        transactionId:       giftClient.transaction_id || undefined,
      })
      if (result.success) {
        toast.success("Gift assigned and logged")
        setGiftHistory(prev => [{
          id: result.giftId, gift_name: gift.name, gift_type: giftType,
          occasion: giftOccasion, status: "recommended",
          estimated_cost: gift.estimatedCost, created_at: new Date().toISOString(),
        }, ...prev])
      } else {
        toast.error(result.error ?? "Failed to assign gift")
      }
    } finally {
      setAssigningGift(false)
    }
  }

  async function handleMarkGiftSent(giftId: string) {
    setMarkingSent(giftId)
    try {
      const result = await markGiftSentAction(giftId)
      if (result.success) {
        toast.success("Gift marked as sent")
        setGiftHistory(prev => prev.map(g => g.id === giftId ? { ...g, status: "sent", sent_at: new Date().toISOString() } : g))
      } else {
        toast.error(result.error ?? "Failed to update gift")
      }
    } finally {
      setMarkingSent(null)
    }
  }

  // ── Testimonials ─────────────────────────────────────
  const [testimonials,      setTestimonials]       = useState<string[]>([])
  const [testimonialOpen,   setTestimonialOpen]    = useState(false)

  function handleExtractTestimonials() {
    startTransition(async () => {
      const result = await aiExtractTestimonials({ agentId, source: "reviews" })
      if (result.success && result.testimonials) {
        setTestimonials(result.testimonials)
        setTestimonialOpen(true)
      } else {
        toast.error(result.error ?? "Failed to extract testimonials")
      }
    })
  }

  // ── Stats ────────────────────────────────────────────
  const totalReviews = reviews.length
  const avgRating =
    reviews.length > 0
      ? (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length).toFixed(1)
      : "—"

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Reviews",  value: totalReviews,           icon: Star,         bg: "bg-yellow-50", color: "text-yellow-500" },
          { label: "Avg Rating",     value: avgRating,              icon: ThumbsUp,     bg: "bg-green-50",  color: "text-green-500"  },
          { label: "Review Ready",   value: reviewReadyClients.length, icon: MessageSquare, bg: "bg-blue-50", color: "text-blue-500" },
          { label: "Lifetime Customers",   value: clients.length,         icon: Heart,        bg: "bg-rose-50",   color: "text-rose-500"   },
        ].map(({ label, value, icon: Icon, bg, color }) => (
          <Card key={label}>
            <CardContent className="p-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="text-2xl font-bold">{value}</p>
              </div>
              <div className={`p-3 ${bg} rounded-full`}>
                <Icon className={`w-5 h-5 ${color}`} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Performance — the server's view of this agent's reputation */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ThumbsUp className="w-4 h-4 text-emerald-500" /> Reputation Performance
          </CardTitle>
          <CardDescription>Response rate and direction of travel across every platform</CardDescription>
        </CardHeader>
        <CardContent>
          {performanceError ? (
            <p className="text-sm text-destructive">{performanceError}</p>
          ) : !performance ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading performance…
            </p>
          ) : performance.totalReviews === 0 ? (
            <p className="text-sm text-muted-foreground">
              No reviews recorded yet — performance appears here once the first one lands.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <span>
                  <span className="font-semibold">{performance.responseRate}%</span>{" "}
                  <span className="text-muted-foreground">responded to</span>
                </span>
                <span>
                  <span className="font-semibold">{performance.avgRating}</span>{" "}
                  <span className="text-muted-foreground">avg over {performance.totalReviews}</span>
                </span>
                <Badge
                  variant="outline"
                  className={
                    performance.recentTrend === "improving"
                      ? "border-green-200 bg-green-50 text-green-700"
                      : performance.recentTrend === "declining"
                        ? "border-red-200 bg-red-50 text-red-700"
                        : "border-slate-200 bg-slate-50 text-slate-600"
                  }
                >
                  {performance.recentTrend}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(performance.byPlatform).map(([platform, stats]) => (
                  <Badge key={platform} variant="outline" className="text-xs">
                    {platform}: {stats.count} &middot; {stats.avgRating.toFixed(1)}★
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="reviews">
        <TabsList className="w-full grid grid-cols-3">
          <TabsTrigger value="reviews">Reviews</TabsTrigger>
          <TabsTrigger value="notes">Thank You Notes</TabsTrigger>
          <TabsTrigger value="gifting">Gifting</TabsTrigger>
        </TabsList>

        {/* ── REVIEWS TAB ─────────────────────────────── */}
        <TabsContent value="reviews" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Star className="w-4 h-4 text-yellow-500" /> Review Requests
              </CardTitle>
              <CardDescription>Request reviews from closings 7–30 days ago at the optimal time</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Select value={reviewPlatform} onValueChange={setReviewPlatform}>
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REVIEW_PLATFORMS.map(p => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Badge variant="outline" className="text-xs">{reviewReadyClients.length} ready</Badge>
              </div>

              {reviewReadyClients.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No clients in the 7–30 day window right now
                </p>
              ) : (
                reviewReadyClients.slice(0, 6).map((client: any) => (
                  <div key={client.id} className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent/30 transition-colors">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {client.contacts?.first_name || client.first_name}{" "}
                        {client.contacts?.last_name  || client.last_name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{client.property_address}</p>
                    </div>
                    <Button size="sm" variant="outline" disabled={isPending} onClick={() => handleGenerateReview(client)}>
                      {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Sparkles className="w-4 h-4 mr-1" />Request</>}
                    </Button>
                  </div>
                ))
              )}

              <Button variant="outline" className="w-full" disabled={isPending} onClick={handleExtractTestimonials}>
                <Sparkles className="w-4 h-4 mr-2" />Extract Testimonials from Reviews
              </Button>
            </CardContent>
          </Card>

          {/* Recent Reviews */}
          <Card>
            <CardHeader className="space-y-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <ThumbsUp className="w-4 h-4 text-green-500" /> Recent Reviews
              </CardTitle>
              {/* J8 Gap 8.2 — platform + date filters */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">Platform:</span>
                {REVIEW_FILTER_PLATFORMS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setReviewFilterPlatform(p.value)}
                    className={`px-2 py-0.5 rounded-full border ${
                      reviewFilterPlatform === p.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-muted-foreground/20 hover:border-primary/50"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <span className="text-muted-foreground ml-2">Range:</span>
                {(["30d", "90d", "all"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setReviewFilterRange(r)}
                    className={`px-2 py-0.5 rounded-full border ${
                      reviewFilterRange === r
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-muted-foreground/20 hover:border-primary/50"
                    }`}
                  >
                    {r === "30d" ? "30 days" : r === "90d" ? "90 days" : "All time"}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              {(() => {
                const cutoff =
                  reviewFilterRange === "all"
                    ? null
                    : Date.now() - (reviewFilterRange === "30d" ? 30 : 90) * 24 * 60 * 60 * 1000
                const filteredReviews = reviews.filter((r: any) => {
                  if (reviewFilterPlatform !== "all" && r.platform !== reviewFilterPlatform) return false
                  if (cutoff && new Date(r.created_at).getTime() < cutoff) return false
                  return true
                })
                if (filteredReviews.length === 0) {
                  return (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No reviews match the current filter.
                    </p>
                  )
                }
                return (
                <div className="space-y-3">
                  {filteredReviews.slice(0, 10).map((r: any) => (
                    <div key={r.id} className="p-3 rounded-lg border space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">{r.reviewer_name || "Anonymous"}</p>
                        <div className="flex">
                          {Array.from({ length: r.rating || 5 }).map((_, i) => (
                            <Star key={i} className="w-3.5 h-3.5 fill-yellow-400 text-yellow-400" />
                          ))}
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-2">{r.review_text}</p>
                      <p className="text-xs text-muted-foreground capitalize">{r.platform} &mdash; {new Date(r.created_at).toLocaleDateString()}</p>
                    </div>
                  ))}
                </div>
                )
              })()}
            </CardContent>
          </Card>

          {/* J8 Gap 8.2 — Auto-respond preferences */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-500" /> Auto-respond
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <p className="text-muted-foreground">
                When a new review arrives, AI can draft a persona-aware response (matched to the
                reviewer's age group when known) and either queue it for your review or publish it
                automatically.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {(["off", "review", "auto"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => handleAutoRespondModeChange(m)}
                    className={`px-2.5 py-1 rounded-full border ${
                      autoRespondMode === m
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-muted-foreground/20 hover:border-primary/50"
                    }`}
                  >
                    {m === "off" ? "Off" : m === "review" ? "Review then publish" : "Fully automatic"}
                  </button>
                ))}
              </div>
              {autoRespondMode === "review" && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-muted-foreground">Approval window:</span>
                  <input
                    type="number"
                    min={1}
                    max={168}
                    value={autoRespondApprovalHours}
                    onChange={(e) => setAutoRespondApprovalHours(Math.max(1, Number(e.target.value) || 24))}
                    onBlur={(e) => {
                      const hours = Math.max(1, Number(e.target.value) || 24)
                      if (agentId) {
                        saveReputationPreferences(agentId, { autoRespondMode, autoRespondApprovalHours: hours })
                      }
                    }}
                    className="w-16 h-7 rounded border px-2 text-xs"
                  />
                  <span className="text-muted-foreground">hours</span>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── THANK YOU NOTES TAB ──────────────────────── */}
        <TabsContent value="notes" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-blue-500" /> Thank You Notes
              </CardTitle>
              <CardDescription>AI-drafted, template-backed notes sent via email, SMS, or handwritten</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {recentClosings.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No recent closings</p>
              ) : (
                recentClosings.slice(0, 6).map((client: any) => (
                  <div key={client.id} className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent/30 transition-colors">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {client.contacts?.first_name || client.first_name}{" "}
                        {client.contacts?.last_name  || client.last_name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{client.property_address}</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => openThankYouDialog(client)}>
                      <Send className="w-4 h-4 mr-1" />Note
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── GIFTING TAB ──────────────────────────────── */}
        <TabsContent value="gifting" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Gift className="w-4 h-4 text-indigo-500" /> Client Gifting
              </CardTitle>
              <CardDescription>AI-curated gift recommendations with budget controls and tracking</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {clients.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No clients found</p>
              ) : (
                clients.slice(0, 6).map((client: any) => (
                  <div key={client.id} className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent/30 transition-colors">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{client.first_name} {client.last_name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {client.transactions?.[0]?.property_address || "Lifetime Customer"}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => openGiftDialog(client)}>
                      <Gift className="w-4 h-4 mr-1" />Gifts
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ════════════════════════════════════════════════════════════════
          REVIEW REQUEST DIALOG
      ════════════════════════════════════════════════════════════════ */}
      <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Review Request</DialogTitle>
            <DialogDescription>
              For {reviewClient?.contacts?.first_name || reviewClient?.first_name} on {reviewPlatform}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={reviewDraft} onChange={e => setReviewDraft(e.target.value)} rows={8} className="font-mono text-sm" />
          <DialogFooter>
            <Button variant="outline" onClick={() => copy(reviewDraft, "review")}>
              {copiedId === "review" ? <><Check className="w-4 h-4 mr-1" />Copied</> : <><Copy className="w-4 h-4 mr-1" />Copy</>}
            </Button>
            {/* This button used to `.catch(() => null)` and close the dialog
                unconditionally. The kernel refuses a duplicate pending request
                for the same contact and platform, and refuses an unresolvable
                actor — both verdicts went into the bin and the agent was shown
                a dialog that closed as if the request had been logged. The
                dialog now stays open on a refusal and repeats what the server
                said. */}
            <Button
              disabled={loggingRequest}
              onClick={async () => {
                const contactName = `${reviewClient?.contacts?.first_name || reviewClient?.first_name || ""} ${reviewClient?.contacts?.last_name || reviewClient?.last_name || ""}`.trim()
                setLoggingRequest(true)
                try {
                  const result = await createReviewRequestAction({
                    contactId: reviewClient?.contact_id || reviewClient?.id,
                    contactName: contactName || "Client",
                    platform: reviewPlatform as any,
                  })
                  if (result?.success) {
                    toast.success("Review request logged")
                    setReviewDialogOpen(false)
                  } else {
                    toast.error((result as { error?: string })?.error ?? "The review request was not logged.")
                  }
                } finally {
                  setLoggingRequest(false)
                }
              }}
            >
              {loggingRequest ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Log Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ════════════════════════════════════════════════════════════════
          THANK YOU NOTE DIALOG — full composer
      ════════════════════════════════════════════════════════════════ */}
      <Dialog open={tyDialogOpen} onOpenChange={setTyDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Thank You Note</DialogTitle>
            <DialogDescription>
              For {tyClient?.contacts?.first_name || tyClient?.first_name}{" "}
              {tyClient?.contacts?.last_name  || tyClient?.last_name}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-3 gap-3">
            {/* Occasion */}
            <div className="space-y-1">
              <Label className="text-xs">Occasion</Label>
              <Select value={tyOccasion} onValueChange={setTyOccasion}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OCCASIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* Channel */}
            <div className="space-y-1">
              <Label className="text-xs">Channel</Label>
              <Select value={tyChannel} onValueChange={setTyChannel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CHANNELS.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* AI Generate */}
            <div className="flex flex-col justify-end">
              <Button variant="outline" disabled={isPending} onClick={handleGenerateThankYou} className="w-full">
                {isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
                AI Draft
              </Button>
            </div>
          </div>

          {/* Subject (email only) */}
          {tyChannel === "email" && (
            <div className="space-y-1">
              <Label className="text-xs">Subject</Label>
              <Input value={tySubject} onChange={e => setTySubject(e.target.value)} placeholder="Subject line…" />
            </div>
          )}

          {/* Body */}
          <div className="space-y-1">
            <Label className="text-xs">Message</Label>
            <Textarea
              value={tyDraft}
              onChange={e => setTyDraft(e.target.value)}
              rows={9}
              placeholder="Start typing or generate with AI…"
            />
          </div>

          {/* Templates */}
          <Accordion type="single" collapsible>
            <AccordionItem value="templates">
              <AccordionTrigger className="text-sm py-2">
                <span className="flex items-center gap-1.5">
                  <BookTemplate className="w-4 h-4" /> Saved Templates
                  {templates.length > 0 && <Badge variant="secondary" className="text-xs ml-1">{templates.length}</Badge>}
                </span>
              </AccordionTrigger>
              <AccordionContent>
                {templates.length === 0 ? (
                  <p className="text-sm text-muted-foreground px-1 py-2">
                    No templates yet. Write a note, then save it as a template below.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {templates.map(tpl => (
                      <div key={tpl.id} className="flex items-center justify-between p-2 rounded border text-sm">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{tpl.name}</p>
                          <p className="text-xs text-muted-foreground capitalize">{tpl.occasion} &middot; {tpl.channel}</p>
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => applyTemplate(tpl)}>
                          Use
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {tyDraft && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 w-full"
                    onClick={() => setSaveTemplateOpen(true)}
                  >
                    <PlusCircle className="w-4 h-4 mr-1" />Save current note as template
                  </Button>
                )}
              </AccordionContent>
            </AccordionItem>

            {/* Note history */}
            {noteHistory.length > 0 && (
              <AccordionItem value="history">
                <AccordionTrigger className="text-sm py-2">
                  <span className="flex items-center gap-1.5">
                    <History className="w-4 h-4" /> Previous Notes
                    <Badge variant="secondary" className="text-xs ml-1">{noteHistory.length}</Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-1.5">
                    {noteHistory.map(n => (
                      <div key={n.id} className="flex items-center justify-between p-2 rounded border text-sm">
                        <div className="min-w-0">
                          <p className="font-medium truncate capitalize">{n.occasion}</p>
                          <p className="text-xs text-muted-foreground">
                            {n.channel} &middot; {new Date(n.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <Badge variant="outline" className={`text-xs ${statusBadge(n.status)}`}>{n.status}</Badge>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            )}
          </Accordion>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => copy(tyDraft, "ty")}>
              {copiedId === "ty" ? <><Check className="w-4 h-4 mr-1" />Copied</> : <><Copy className="w-4 h-4 mr-1" />Copy</>}
            </Button>
            <Button onClick={handleSendThankYou} disabled={tySending || !tyDraft}>
              {tySending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
              {tyChannel === "email" ? "Send Email" : tyChannel === "sms" ? "Send Text" : "Mail Card"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save Template Dialog */}
      <Dialog open={saveTemplateOpen} onOpenChange={setSaveTemplateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save as Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">Template Name</Label>
            <Input
              value={templateName}
              onChange={e => setTemplateName(e.target.value)}
              placeholder="e.g. Warm Closing Note"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Use <code>{"{{first_name}}"}</code>, <code>{"{{property_address}}"}</code>, and <code>{"{{agent_name}}"}</code> as dynamic variables.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveTemplateOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveTemplate} disabled={savingTemplate || !templateName}>
              {savingTemplate ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Save Template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ════════════════════════════════════════════════════════════════
          GIFT DIALOG — full composer with history
      ════════════════════════════════════════════════════════════════ */}
      <Dialog open={giftDialogOpen} onOpenChange={setGiftDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Client Gifting</DialogTitle>
            <DialogDescription>
              For {giftClient?.first_name} {giftClient?.last_name}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Occasion</Label>
              <Select value={giftOccasion} onValueChange={setGiftOccasion}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OCCASIONS.slice(0, 7).map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Gift Type</Label>
              <Select value={giftType} onValueChange={setGiftType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {GIFT_TYPES.map(g => <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Budget Min ($)</Label>
              <Input
                type="number"
                min={0}
                value={giftBudgetMin}
                onChange={e => setGiftBudgetMin(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Budget Max ($)</Label>
              <Input
                type="number"
                min={0}
                value={giftBudgetMax}
                onChange={e => setGiftBudgetMax(Number(e.target.value))}
              />
            </div>
          </div>

          <Button className="w-full" disabled={isPending} onClick={handleRecommendGift}>
            {isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            Get AI Gift Recommendations
          </Button>

          {/* Recommendations */}
          {giftRec && (
            <div className="space-y-3">
              {/* Top pick */}
              {giftRec.topRecommendation && (
                <div className="rounded-xl border-2 border-indigo-200 bg-indigo-50/60 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge className="bg-indigo-600 text-white text-xs">Top Pick</Badge>
                    <p className="font-semibold">{giftRec.topRecommendation.name}</p>
                    <Badge variant="outline" className="ml-auto">${giftRec.topRecommendation.estimatedCost}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{giftRec.topRecommendation.description}</p>
                  <p className="text-xs italic text-indigo-700">{giftRec.topRecommendation.whyThisGift}</p>
                  {giftRec.topRecommendation.purchaseUrl && (
                    <a
                      href={giftRec.topRecommendation.purchaseUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
                    >
                      <ExternalLink className="w-3 h-3" />View / Purchase
                    </a>
                  )}
                  <Button size="sm" className="w-full" disabled={assigningGift} onClick={() => handleAssignGift(giftRec.topRecommendation)}>
                    {assigningGift ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <PackageCheck className="w-4 h-4 mr-1" />}
                    Assign this Gift
                  </Button>
                </div>
              )}

              {/* Alternatives */}
              {giftRec.alternatives?.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Alternatives</p>
                  {giftRec.alternatives.slice(0, 3).map((alt: any, i: number) => (
                    <div key={i} className="flex items-center justify-between p-3 rounded-lg border text-sm">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{alt.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{alt.description}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-3">
                        <Badge variant="outline">${alt.estimatedCost}</Badge>
                        <Button size="sm" variant="outline" disabled={assigningGift} onClick={() => handleAssignGift(alt)}>
                          Assign
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Personalization note */}
              <div className="space-y-1">
                <Label className="text-xs">Personalization Note (optional)</Label>
                <Textarea
                  value={giftNote}
                  onChange={e => setGiftNote(e.target.value)}
                  rows={2}
                  placeholder="Add a personal message or instructions for this gift…"
                />
              </div>
            </div>
          )}

          {/* Gift history */}
          {giftHistory.length > 0 && (
            <Accordion type="single" collapsible>
              <AccordionItem value="history">
                <AccordionTrigger className="text-sm py-2">
                  <span className="flex items-center gap-1.5">
                    <History className="w-4 h-4" /> Gift History
                    <Badge variant="secondary" className="text-xs ml-1">{giftHistory.length}</Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-2">
                    {giftHistory.map(g => (
                      <div key={g.id} className="flex items-center justify-between p-2 rounded border text-sm">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{g.gift_name}</p>
                          <p className="text-xs text-muted-foreground capitalize">
                            {g.occasion} &middot; ${g.estimated_cost} &middot; {new Date(g.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          <Badge variant="outline" className={`text-xs ${statusBadge(g.status)}`}>{g.status}</Badge>
                          {g.status === "recommended" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={markingSent === g.id}
                              onClick={() => handleMarkGiftSent(g.id)}
                            >
                              {markingSent === g.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setGiftDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Testimonials Dialog */}
      <Dialog open={testimonialOpen} onOpenChange={setTestimonialOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Extracted Testimonials</DialogTitle>
            <DialogDescription>{testimonials.length} quotes extracted from your reviews</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
            {testimonials.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No testimonials extracted</p>
            ) : (
              testimonials.map((t, i) => (
                <div key={i} className="p-4 rounded-lg border flex items-start justify-between gap-3">
                  <p className="text-sm italic flex-1">"{t}"</p>
                  <Button size="sm" variant="ghost" onClick={() => copy(t, `t-${i}`)}>
                    {copiedId === `t-${i}` ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setTestimonialOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
