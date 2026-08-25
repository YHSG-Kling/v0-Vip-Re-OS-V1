"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { StagedDraftBanner } from "@/app/components/shared/staged-draft-banner"
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Plus,
  MailOpen,
  Sparkles,
  Loader2,
  Send,
  Calendar,
  Trash2,
  TrendingUp,
  Clock,
  Users,
  GripVertical,
  ChevronLeft,
  ChevronRight,
  Check,
  Edit2,
  X,
  RefreshCw,
  Eye,
  Newspaper,
  Settings2,
} from "lucide-react"
import {
  aiGenerateSubjectLines,
  aiOptimizeSendTime,
  aiWriteNewsletterContent,
  createNewsletterCampaign,
  getNewsletterAnalytics,
  aiAnalyzeNewsletterPerformance,
  // SENDING A NEWSLETTER USES THE NEWSLETTER SENDER. This screen creates rows
  // in newsletter_campaigns (createNewsletterCampaign above) and used to send
  // them with sendEmailCampaign, which looks the id up in email_campaigns — a
  // DIFFERENT table. That lookup could never match, so every Send returned
  // "Campaign not found" and no newsletter this screen created was ever
  // sendable. sendNewsletter queries newsletter_campaigns, and returns the same
  // { success, recipientCount } shape this screen already reads.
  sendNewsletter,
  // Schedule and Delete carried the SAME wrong-table defect Send did — all
  // three called the email_campaigns lane with a newsletter_campaigns id, so
  // every one of them answered "Campaign not found". These are the newsletter
  // -lane counterparts.
  deleteNewsletterCampaign,
} from "@/app/actions/ai-newsletter"
import { fetchLocalNews, setupLocalNewsSource, recordNewsletterLocalContent } from "@/app/actions/newsletter/fetch-local-news"
import { scheduleNewsletter, scheduleExistingNewsletter } from "@/app/actions/newsletter/schedule-newsletter"
import { listTemplates } from "@/app/actions/newsletter/list-templates"
import { computeSeoScore } from "@/lib/newsletter/seo-score"
import { validateScheduleTime } from "@/lib/newsletter/schedule-time"
import { format } from "date-fns"
import { toast } from "sonner"

// ─── Types ──────────────────────────────────────────────────────────────────

interface Campaign {
  id: string
  status: string
  open_rate: number | null
  campaign_name: string
  subject_line: string
  created_at: string
  send_date: string | null
}

interface NewslettersClientProps {
  userId: string
  agentId: string
  brokerageId: string
  campaigns: Campaign[]
  stats: {
    activeCampaigns: number
    totalSubscribers: number
    avgOpenRate: number | null
    totalCampaigns: number
  }
}

interface GeneratedSection {
  type: string
  title: string
  content: string
  ctaText?: string
  ctaUrl?: string
}

interface WizardData {
  // Step 1 – Setup
  campaignName: string
  audienceSegment: "all" | "buyers" | "sellers" | "lifetime_customers" | "custom"
  fromName: string
  replyTo: string
  topic: string
  // Step 2 – Sections
  sections: string[]
  // Step 3 – Content
  generatedSections: GeneratedSection[]
  subjectLine: string
  subjectVariants: string[]
  wordCount: number | null
  estimatedReadTime: number | null
  /** Wave 20.1 — content_topic_bank IDs that seeded the generated sections.
   *  Threaded through the create-campaign call so the performance loop
   *  captures which topics produced this issue AND so the newsletter video
   *  render reads the same threads back for cohesion (sections + video lead
   *  with the same content). */
  seedTopicIds: string[]
  // Step 5 – Timing
  sendOptimization: {
    recommendedDay: string
    recommendedTime: string
    confidence: number
    reasoning: string
  } | null
  // Step 6 – Send
  sendMode: "now" | "scheduled"
  scheduleDate: string
}

const INITIAL_WIZARD: WizardData = {
  campaignName: "",
  audienceSegment: "all",
  fromName: "",
  replyTo: "",
  topic: "",
  sections: ["Market Update", "Home Tips"],
  generatedSections: [],
  seedTopicIds: [],
  subjectLine: "",
  subjectVariants: [],
  wordCount: null,
  estimatedReadTime: null,
  sendOptimization: null,
  sendMode: "scheduled",
  scheduleDate: "",
}

const ALL_SECTIONS = [
  "Market Update",
  "Featured Listing",
  "Just Sold",
  "Home Tips",
  "Local Events",
  "Client Spotlight",
  "Agent News",
  "Open Houses",
  "Educational Article",
  "Video of the Month",
  "Custom Section",
]

const AUDIENCE_LABELS: Record<string, string> = {
  all: "All Contacts",
  buyers: "Buyers",
  sellers: "Sellers",
  lifetime_customers: "Lifetime Customers",
  custom: "Custom Segment",
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  scheduled: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  sent: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
}

const STEP_LABELS = ["Setup", "Sections", "Content", "Preview", "Timing", "Send"]

// ─── Local News helpers ──────────────────────────────────────────────────────
// A row from newsletter_local_content has a free-form jsonb `content` column
// plus zip_code / relevance_score. Normalize it into a display shape so the
// agent can preview headlines and insert them into the newsletter.

interface LocalNewsRow {
  id?: string
  zip_code?: string | null
  relevance_score?: number | null
  content?: unknown
}

interface NormalizedHeadline {
  key: string
  title: string
  summary: string
  zip: string | null
  score: number | null
  ctaUrl?: string
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function normalizeLocalNews(row: LocalNewsRow, idx: number): NormalizedHeadline {
  const c = (row.content ?? {}) as Record<string, unknown>
  const title =
    asString(c.title) ??
    asString(c.headline) ??
    asString(c.name) ??
    (typeof row.content === "string" ? asString(row.content) : undefined) ??
    "Untitled local item"
  const summary =
    asString(c.summary) ??
    asString(c.description) ??
    asString(c.excerpt) ??
    asString(c.body) ??
    ""
  const ctaUrl = asString(c.url) ?? asString(c.link)
  return {
    key: row.id ?? `local-${idx}`,
    title,
    summary,
    zip: row.zip_code ?? null,
    score: typeof row.relevance_score === "number" ? row.relevance_score : null,
    ctaUrl,
  }
}

// ─── Sortable Section Item ───────────────────────────────────────────────────

function SortableSectionItem({
  id,
  onRemove,
}: {
  id: string
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 bg-card border rounded-md px-3 py-2 text-sm"
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="flex-1">{id}</span>
      <button
        type="button"
        onClick={onRemove}
        className="text-muted-foreground hover:text-destructive transition-colors"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// ─── Email Preview ────────────────────────────────────────────────────────────

function EmailPreview({
  subject,
  fromName,
  sections,
  onEditSection,
}: {
  subject: string
  fromName: string
  sections: GeneratedSection[]
  onEditSection: (index: number) => void
}) {
  return (
    <div className="border rounded-lg overflow-hidden bg-white shadow-sm max-w-2xl mx-auto">
      {/* Simulated email client header */}
      <div className="bg-gray-50 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
          <span className="font-medium text-gray-700">From:</span>
          <span>{fromName || "Your Name"} &lt;no-reply@yourbrokerage.com&gt;</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="font-medium text-gray-700">Subject:</span>
          <span className="font-medium text-gray-800">{subject || "(No subject)"}</span>
        </div>
      </div>
      {/* Email body */}
      <div className="p-6 space-y-0">
        {sections.length === 0 ? (
          <p className="text-center text-gray-400 py-8 text-sm italic">
            Generate content in Step 3 to see the preview here.
          </p>
        ) : (
          sections.map((section, idx) => (
            <div
              key={idx}
              className="group relative border border-transparent hover:border-blue-200 hover:bg-blue-50/30 rounded-md transition-colors"
            >
              <button
                type="button"
                onClick={() => onEditSection(idx)}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white border rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 flex items-center gap-1 shadow-sm z-10"
              >
                <Edit2 className="h-3 w-3" />
                Edit
              </button>
              <div className="px-4 py-4">
                <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.4rem", color: "#111" }}>
                  {section.title}
                </h2>
                <div style={{ lineHeight: 1.65, color: "#374151", fontSize: "0.9rem" }}>
                  {section.content.split("\n\n").map((para, p) => (
                    <p key={p} style={{ marginBottom: "0.5rem" }}>
                      {para}
                    </p>
                  ))}
                </div>
                {section.ctaText && (
                  <div style={{ marginTop: "0.75rem" }}>
                    <span
                      style={{
                        display: "inline-block",
                        background: "#1d4ed8",
                        color: "#fff",
                        padding: "0.4rem 1rem",
                        borderRadius: "0.375rem",
                        fontSize: "0.85rem",
                        fontWeight: 500,
                      }}
                    >
                      {section.ctaText}
                    </span>
                  </div>
                )}
              </div>
              {idx < sections.length - 1 && (
                <hr style={{ margin: "0 1rem", borderColor: "#e5e7eb" }} />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ─── Section Edit Modal ───────────────────────────────────────────────────────

function SectionEditor({
  section,
  onSave,
  onClose,
}: {
  section: GeneratedSection
  onSave: (updated: GeneratedSection) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(section.title)
  const [content, setContent] = useState(section.content)
  const [ctaText, setCtaText] = useState(section.ctaText ?? "")
  const [ctaUrl, setCtaUrl] = useState(section.ctaUrl ?? "")

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Edit Section: {section.type}</h3>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Section Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">Content</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              className="mt-1 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">CTA Text (optional)</Label>
              <Input
                value={ctaText}
                onChange={(e) => setCtaText(e.target.value)}
                placeholder="Learn More"
                className="mt-1 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs">CTA URL (optional)</Label>
              <Input
                value={ctaUrl}
                onChange={(e) => setCtaUrl(e.target.value)}
                placeholder="https://..."
                className="mt-1 text-sm"
              />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onSave({ ...section, title, content, ctaText: ctaText || undefined, ctaUrl: ctaUrl || undefined })
              onClose()
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Step Indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current, total, labels }: { current: number; total: number; labels: string[] }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {Array.from({ length: total }, (_, i) => {
        const stepNum = i + 1
        const done = stepNum < current
        const active = stepNum === current
        return (
          <div key={stepNum} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium border-2 transition-colors ${
                  done
                    ? "bg-primary border-primary text-primary-foreground"
                    : active
                    ? "border-primary text-primary bg-background"
                    : "border-muted text-muted-foreground bg-background"
                }`}
              >
                {done ? <Check className="h-4 w-4" /> : stepNum}
              </div>
              <span
                className={`text-[10px] font-medium hidden sm:block ${
                  active ? "text-primary" : done ? "text-muted-foreground" : "text-muted-foreground/50"
                }`}
              >
                {labels[i]}
              </span>
            </div>
            {i < total - 1 && (
              <div
                className={`flex-1 h-0.5 mx-1 transition-colors ${done ? "bg-primary" : "bg-muted"}`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function NewslettersClient({
  userId,
  agentId,
  brokerageId,
  campaigns: initialCampaigns,
  stats,
}: NewslettersClientProps) {
  const router = useRouter()
  const [campaigns, setCampaigns] = useState<Campaign[]>(initialCampaigns)

  // Wizard state
  const [wizardOpen, setWizardOpen] = useState(false)
  const [step, setStep] = useState(1)
  const [wizard, setWizard] = useState<WizardData>(INITIAL_WIZARD)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isOptimizing, setIsOptimizing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [subjectVariantsLoading, setSubjectVariantsLoading] = useState(false)
  const [editingSection, setEditingSection] = useState<number | null>(null)

  // ── Pull Local News panel (Step 3) ──────────────────────────────────────
  // Wires fetchLocalNews / setupLocalNewsSource: the agent enters market ZIPs,
  // pulls curated local headlines (ordered by relevance_score, server-side),
  // and inserts any of them as a "Local News" section into the newsletter.
  const [localNewsZips, setLocalNewsZips] = useState("")
  const [localNewsMarket, setLocalNewsMarket] = useState("")
  const [localNewsFreq, setLocalNewsFreq] = useState<"hourly" | "daily" | "weekly">("daily")
  const [localNewsLoading, setLocalNewsLoading] = useState(false)
  const [localNewsSaving, setLocalNewsSaving] = useState(false)
  const [localHeadlines, setLocalHeadlines] = useState<NormalizedHeadline[]>([])
  const [localNewsFetched, setLocalNewsFetched] = useState(false)

  // Campaign list actions
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [scheduleDate, setScheduleDate] = useState("")

  // Analytics
  const [analyticsData, setAnalyticsData] = useState<any>(null)
  const [analyticsInsights, setAnalyticsInsights] = useState<any>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsLoaded, setAnalyticsLoaded] = useState(false)

  // ── Governed scheduled send (Step 6) ──────────────────────────────────────
  // Records an approved-template send into newsletter_scheduled_sends via the
  // scheduleNewsletter action. The row is picked up by the governed cron that
  // sends through the egress gate later — nothing is delivered to consumers here.
  const [approvedTemplates, setApprovedTemplates] = useState<Array<{ id: string; template_name: string }>>([])
  const [scheduleTemplateId, setScheduleTemplateId] = useState("")
  const [isRegisteringSend, setIsRegisteringSend] = useState(false)

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Live, draft-time SEO/readability score over the assembled email body.
  // Pure (lib/newsletter/seo-score.ts) — recomputes as the user edits content,
  // subject, or topic. The same math is persisted server-side by getSEOScore
  // once a send is scheduled (newsletter_seo_scores, keyed by scheduledSendId).
  const seoBreakdown = useMemo(() => {
    if (wizard.generatedSections.length === 0) return null
    const html = wizard.generatedSections
      .map((s) => `<h1>${s.title}</h1>\n<p>${s.content}</p>`)
      .join("\n")
    return computeSeoScore({
      subjectLine: wizard.subjectLine,
      htmlContent: html,
      primaryKeyword: wizard.topic || wizard.campaignName,
    })
  }, [wizard.generatedSections, wizard.subjectLine, wizard.topic, wizard.campaignName])

  function updateWizard(patch: Partial<WizardData>) {
    setWizard((prev) => ({ ...prev, ...patch }))
  }

  function openWizard() {
    setWizard(INITIAL_WIZARD)
    setStep(1)
    setLocalNewsZips("")
    setLocalNewsMarket("")
    setLocalNewsFreq("daily")
    setLocalHeadlines([])
    setLocalNewsFetched(false)
    setScheduleTemplateId("")
    setWizardOpen(true)
    // Load approved templates for the governed Schedule Send control (Step 6).
    // Only approved templates can be scheduled (enforced server-side too).
    listTemplates("approved")
      .then((tpls) =>
        setApprovedTemplates(
          (tpls as Array<{ id: string; template_name: string }>).map((t) => ({
            id: t.id,
            template_name: t.template_name,
          }))
        )
      )
      .catch(() => setApprovedTemplates([]))
  }

  // ── Local News handlers ──────────────────────────────────────────────────

  function parseZips(raw: string): string[] {
    return Array.from(
      new Set(
        raw
          .split(/[\s,]+/)
          .map((z) => z.trim())
          .filter((z) => /^\d{5}$/.test(z))
      )
    )
  }

  async function handlePullLocalNews() {
    const zips = parseZips(localNewsZips)
    if (zips.length === 0) {
      toast.error("Enter at least one 5-digit ZIP code")
      return
    }
    setLocalNewsLoading(true)
    try {
      const rows = (await fetchLocalNews(zips, 10)) as LocalNewsRow[]
      setLocalHeadlines(rows.map((r, i) => normalizeLocalNews(r, i)))
      setLocalNewsFetched(true)
      if (rows.length === 0) {
        toast.info("No fresh local items for those ZIPs yet — configure a source to start collecting.")
      } else {
        toast.success(`Pulled ${rows.length} local headline${rows.length === 1 ? "" : "s"}`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to pull local news")
    } finally {
      setLocalNewsLoading(false)
    }
  }

  async function handleSaveNewsSource() {
    const zips = parseZips(localNewsZips)
    if (zips.length === 0) {
      toast.error("Enter at least one 5-digit ZIP code")
      return
    }
    setLocalNewsSaving(true)
    try {
      const res = await setupLocalNewsSource(zips, localNewsMarket.trim() || undefined, localNewsFreq)
      if (res.success) {
        toast.success(res.message ?? "News source saved")
      } else {
        toast.error("Failed to save news source")
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save news source")
    } finally {
      setLocalNewsSaving(false)
    }
  }

  function insertHeadline(h: NormalizedHeadline) {
    const section: GeneratedSection = {
      type: "Local News",
      title: h.title,
      content: h.summary || h.title,
      ctaText: h.ctaUrl ? "Read More" : undefined,
      ctaUrl: h.ctaUrl,
    }
    updateWizard({ generatedSections: [...wizard.generatedSections, section] })
    toast.success("Headline added to newsletter")
  }

  function closeWizard() {
    setWizardOpen(false)
  }

  // ── Step 2: Drag handlers ────────────────────────────────────────────────

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = wizard.sections.indexOf(active.id as string)
    const newIndex = wizard.sections.indexOf(over.id as string)
    updateWizard({ sections: arrayMove(wizard.sections, oldIndex, newIndex) })
  }

  function toggleSection(name: string) {
    if (wizard.sections.includes(name)) {
      updateWizard({ sections: wizard.sections.filter((s) => s !== name) })
    } else {
      updateWizard({ sections: [...wizard.sections, name] })
    }
  }

  // ── Step 3: Generate content ─────────────────────────────────────────────

  async function handleGenerateContent() {
    if (!agentId || !brokerageId) {
      toast.error("Agent or brokerage not found")
      return
    }
    setIsGenerating(true)
    try {
      const result = await aiWriteNewsletterContent({
        agentId,
        brokerageId,
        topic: wizard.topic || wizard.campaignName,
        customSections: wizard.sections,
        targetAudience: wizard.audienceSegment,
        tone: "professional",
      })
      if (result.success && result.sections) {
        updateWizard({
          generatedSections: result.sections as GeneratedSection[],
          // Wave 20.1 — capture seed topic IDs so handleSubmit can thread them
          // into createNewsletterCampaign. Without this the cohesion + Wave 19
          // performance loop never fire on this path.
          seedTopicIds: Array.isArray((result as { seedTopicIds?: string[] }).seedTopicIds)
            ? (result as { seedTopicIds?: string[] }).seedTopicIds ?? []
            : [],
          wordCount: result.wordCount ?? null,
          estimatedReadTime: result.estimatedReadTime ?? null,
        })
        // Also auto-generate subject variants
        handleGenerateSubjectVariants()
      } else {
        toast.error((result as any).error ?? "Content generation failed")
      }
    } catch {
      toast.error("Content generation failed")
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleGenerateSubjectVariants() {
    if (!agentId) return
    setSubjectVariantsLoading(true)
    try {
      const res = await aiGenerateSubjectLines({
        agentId,
        brokerageId,
        newsletterTopic: wizard.topic || wizard.campaignName,
        tone: "professional",
      })
      if ((res as any).success && (res as any).subjectLines) {
        updateWizard({ subjectVariants: (res as any).subjectLines.slice(0, 3) })
      }
    } finally {
      setSubjectVariantsLoading(false)
    }
  }

  // ── Step 5: Send time optimization ──────────────────────────────────────

  async function handleOptimizeSendTime() {
    if (!agentId) return
    setIsOptimizing(true)
    try {
      const result = await aiOptimizeSendTime({ agentId, audienceSegment: wizard.audienceSegment })
      if ((result as any).success && (result as any).optimization) {
        updateWizard({ sendOptimization: (result as any).optimization })
      }
    } catch {
      // non-fatal
    } finally {
      setIsOptimizing(false)
    }
  }

  // ── Step 6: Submit ───────────────────────────────────────────────────────

  async function handleSubmit() {
    if (!agentId || !brokerageId) {
      toast.error("Agent or brokerage not found")
      return
    }
    setIsSubmitting(true)
    try {
      const result = await createNewsletterCampaign({
        agentId,
        brokerageId,
        title: wizard.campaignName,
        subjectLine: wizard.subjectLine,
        preheaderText: "",
        template: "modern",
        content: wizard.generatedSections as any,
        audienceSegment: wizard.audienceSegment,
        scheduledAt: wizard.sendMode === "scheduled" && wizard.scheduleDate ? wizard.scheduleDate : undefined,
        // Wave 20.1 — thread the topic IDs that anchored the generated
        // sections so the Wave 19 content_topic_uses ledger captures
        // newsletter_campaign-asset uses AND the video render reads them
        // back for cohesion with the section content.
        seedTopicIds: wizard.seedTopicIds,
      })
      if (result.success && result.newsletter) {
        // Record which LOCAL headlines this campaign used — newsletter_local_content
        // rows attach to the created campaign (NOT NULL FK), keeping the
        // "included_in_last_newsletter" ledger honest. Best-effort.
        const localSections = wizard.generatedSections.filter((s) => s.type === "Local News")
        if (localSections.length > 0) {
          recordNewsletterLocalContent(
            result.newsletter.id,
            localSections.map((s) => ({ title: s.title, content: s.content, ctaUrl: s.ctaUrl, zipCode: parseZips(localNewsZips)[0] })),
          ).catch(() => {})
        }
        const newCampaign: Campaign = {
          id: result.newsletter.id,
          campaign_name: wizard.campaignName,
          subject_line: wizard.subjectLine,
          status: wizard.sendMode === "scheduled" && wizard.scheduleDate ? "scheduled" : "draft",
          open_rate: null,
          created_at: new Date().toISOString(),
          send_date: wizard.scheduleDate || null,
        }
        setCampaigns((prev) => [newCampaign, ...prev])

        if (wizard.sendMode === "now") {
          // Immediately send
          const sendResult = await sendNewsletter({ newsletterId: result.newsletter.id })
          if (sendResult.success) {
            toast.success(`Sent to ${(sendResult as any).recipientCount ?? 0} subscribers`)
            setCampaigns((prev) =>
              prev.map((c) => (c.id === result.newsletter!.id ? { ...c, status: "sent" } : c))
            )
          } else {
            toast.warning("Campaign created but send failed — check Campaigns list")
          }
        } else {
          toast.success(
            wizard.scheduleDate
              ? `Newsletter scheduled for ${format(new Date(wizard.scheduleDate), "MMM d 'at' h:mm a")}`
              : "Newsletter saved as draft"
          )
        }
        closeWizard()
      } else {
        toast.error((result as any).error ?? "Failed to create newsletter")
      }
    } catch {
      toast.error("Unexpected error creating newsletter")
    } finally {
      setIsSubmitting(false)
    }
  }

  // ── Step 6: Register governed scheduled send ─────────────────────────────
  // Wires scheduleNewsletter: validates the picked time (pure schedule-time lib),
  // then writes a newsletter_scheduled_sends row against an approved template.
  // The governed cron sends it through the egress gate later — no inline send.
  async function handleRegisterScheduledSend() {
    if (!scheduleTemplateId) {
      toast.error("Select an approved template to schedule")
      return
    }
    const verdict = validateScheduleTime(wizard.scheduleDate)
    if (!verdict.valid || !verdict.date) {
      toast.error(verdict.reason)
      return
    }
    setIsRegisteringSend(true)
    try {
      const html = wizard.generatedSections
        .map((s) => `<h1>${s.title}</h1>\n<p>${s.content}</p>`)
        .join("\n")
      const result = await scheduleNewsletter({
        templateId: scheduleTemplateId,
        subjectLine: wizard.subjectLine,
        scheduledSendTime: verdict.date,
        recipientSegment: { role: wizard.audienceSegment === "all" ? undefined : wizard.audienceSegment },
        sectionsIncluded: wizard.sections,
        htmlContent: html || undefined,
        primaryKeyword: wizard.topic || wizard.campaignName,
      })
      if (result.success) {
        toast.success(
          `Send registered for ${format(verdict.date, "MMM d 'at' h:mm a")} — the governed cron will deliver it`
        )
      } else {
        toast.error("Failed to register scheduled send")
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to register scheduled send")
    } finally {
      setIsRegisteringSend(false)
    }
  }

  // ── Campaign list actions ────────────────────────────────────────────────

  async function handleSend(campaignId: string) {
    setSendingId(campaignId)
    try {
      const result = await sendNewsletter({ newsletterId: campaignId })
      if (result.success) {
        setCampaigns((prev) =>
          prev.map((c) => (c.id === campaignId ? { ...c, status: "sent" } : c))
        )
        toast.success(`Sent to ${(result as any).recipientCount ?? 0} subscribers`)
      } else {
        toast.error((result as any).error ?? "Failed to send campaign")
      }
    } catch {
      toast.error("Unexpected error sending campaign")
    } finally {
      setSendingId(null)
    }
  }

  async function handleSchedule(campaignId: string) {
    if (!scheduleDate) {
      toast.error("Select a date before scheduling")
      return
    }
    try {
      const result = await scheduleExistingNewsletter({
        newsletterId: campaignId,
        scheduledSendTime: scheduleDate,
      })
      if (result.success) {
        setCampaigns((prev) =>
          prev.map((c) =>
            c.id === campaignId
              ? { ...c, status: "scheduled", send_date: result.scheduledFor ?? scheduleDate }
              : c
          )
        )
        // A scheduled send whose ledger row failed still goes out — say which
        // half succeeded rather than a flat "Scheduled".
        if (result.ledgerWarning) {
          toast.warning(result.ledgerWarning)
        } else {
          toast.success("Newsletter scheduled — the send cron will deliver it")
        }
        setScheduleDate("")
      } else {
        toast.error(result.error ?? "Failed to schedule newsletter")
      }
    } catch {
      toast.error("Unexpected error scheduling campaign")
    }
  }

  async function handleDelete(campaignId: string) {
    setDeletingId(campaignId)
    try {
      const result = await deleteNewsletterCampaign(campaignId)
      if (result.success) {
        setCampaigns((prev) => prev.filter((c) => c.id !== campaignId))
        toast.success("Newsletter deleted")
      } else {
        toast.error((result as any).error ?? "Failed to delete newsletter")
      }
    } catch {
      toast.error("Unexpected error deleting campaign")
    } finally {
      setDeletingId(null)
    }
  }

  async function handleLoadAnalytics() {
    if (analyticsLoaded) return
    setAnalyticsLoading(true)
    try {
      const [analyticsRes, insightsRes] = await Promise.all([
        campaigns.length > 0
          ? getNewsletterAnalytics({ newsletterId: campaigns[0].id, agentId })
          : Promise.resolve(null),
        aiAnalyzeNewsletterPerformance({ agentId }),
      ])
      setAnalyticsData(analyticsRes)
      setAnalyticsInsights(insightsRes)
      setAnalyticsLoaded(true)
    } finally {
      setAnalyticsLoading(false)
    }
  }

  // ── Wizard step validation ───────────────────────────────────────────────

  function canAdvance(): boolean {
    if (step === 1) return !!wizard.campaignName.trim() && !!wizard.topic.trim()
    if (step === 2) return wizard.sections.length > 0
    if (step === 3) return wizard.generatedSections.length > 0 && !!wizard.subjectLine.trim()
    if (step === 4) return true
    if (step === 5) return true
    return false
  }

  async function handleNext() {
    if (step === 4 && !wizard.sendOptimization) {
      // Auto-fetch send time optimization when entering step 5
      setStep(5)
      handleOptimizeSendTime()
      return
    }
    setStep((s) => Math.min(s + 1, 6))
  }

  // ─── Wizard UI ────────────────────────────────────────────────────────────

  if (wizardOpen) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto py-6 px-4 max-w-3xl">
          {/* Wizard header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-xl font-bold tracking-tight">Create Newsletter</h1>
              <p className="text-sm text-muted-foreground">Step {step} of 6 — {STEP_LABELS[step - 1]}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={closeWizard} className="gap-1 text-muted-foreground">
              <X className="h-4 w-4" />
              Cancel
            </Button>
          </div>

          <StepIndicator current={step} total={6} labels={STEP_LABELS} />

          {/* ── STEP 1: SETUP ── */}
          {step === 1 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Campaign Setup</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Campaign Name <span className="text-destructive">*</span></Label>
                  <Input
                    placeholder="e.g. Q2 Market Update Newsletter"
                    value={wizard.campaignName}
                    onChange={(e) => updateWizard({ campaignName: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Topic / Purpose <span className="text-destructive">*</span></Label>
                  <Input
                    placeholder="e.g. Spring market trends and buyer tips"
                    value={wizard.topic}
                    onChange={(e) => updateWizard({ topic: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    AI will write content around this topic for each selected section.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Audience Segment</Label>
                  <Select
                    value={wizard.audienceSegment}
                    onValueChange={(v) => updateWizard({ audienceSegment: v as WizardData["audienceSegment"] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Contacts</SelectItem>
                      <SelectItem value="buyers">Buyers</SelectItem>
                      <SelectItem value="sellers">Sellers</SelectItem>
                      <SelectItem value="lifetime_customers">Lifetime Customers</SelectItem>
                      <SelectItem value="custom">Custom Segment</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>From Name</Label>
                    <Input
                      placeholder="Your Name"
                      value={wizard.fromName}
                      onChange={(e) => updateWizard({ fromName: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Reply-To Email</Label>
                    <Input
                      type="email"
                      placeholder="you@example.com"
                      value={wizard.replyTo}
                      onChange={(e) => updateWizard({ replyTo: e.target.value })}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── STEP 2: SECTION PICKER ── */}
          {step === 2 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Choose & Order Sections</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <p className="text-sm font-medium mb-3">Available Sections — click to add</p>
                  <div className="flex flex-wrap gap-2">
                    {ALL_SECTIONS.filter((s) => !wizard.sections.includes(s)).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => toggleSection(s)}
                        className="px-3 py-1 rounded-full border text-sm border-muted-foreground/30 hover:border-primary hover:bg-primary/5 transition-colors"
                      >
                        + {s}
                      </button>
                    ))}
                    {ALL_SECTIONS.every((s) => wizard.sections.includes(s)) && (
                      <p className="text-sm text-muted-foreground italic">All sections added</p>
                    )}
                  </div>
                </div>

                <div>
                  <p className="text-sm font-medium mb-3">
                    Selected Sections <span className="text-muted-foreground">({wizard.sections.length})</span>
                    <span className="text-xs text-muted-foreground ml-2">— drag to reorder</span>
                  </p>
                  {wizard.sections.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic py-4 text-center border border-dashed rounded-lg">
                      No sections selected. Add at least one above.
                    </p>
                  ) : (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleDragEnd}
                    >
                      <SortableContext items={wizard.sections} strategy={verticalListSortingStrategy}>
                        <div className="space-y-2">
                          {wizard.sections.map((s) => (
                            <SortableSectionItem
                              key={s}
                              id={s}
                              onRemove={() => toggleSection(s)}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── STEP 3: AI CONTENT GENERATION ── */}
          {step === 3 && (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">AI Content Generation</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {wizard.generatedSections.length === 0 ? (
                    <div className="text-center py-8">
                      <Sparkles className="h-10 w-10 text-amber-400 mx-auto mb-3" />
                      <p className="text-sm text-muted-foreground mb-4">
                        AI will write content for each of your {wizard.sections.length} selected sections.
                        Brand voice and compliance checks are applied automatically.
                      </p>
                      <Button onClick={handleGenerateContent} disabled={isGenerating} className="gap-2">
                        {isGenerating ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Generating…
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-4 w-4" />
                            Generate Content
                          </>
                        )}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs gap-1">
                            <Check className="h-3 w-3 text-green-600" />
                            {wizard.generatedSections.length} sections generated
                          </Badge>
                          {wizard.wordCount && (
                            <Badge variant="outline" className="text-xs">
                              ~{wizard.wordCount} words · {wizard.estimatedReadTime} min read
                            </Badge>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleGenerateContent}
                          disabled={isGenerating}
                          className="gap-1 text-xs"
                        >
                          {isGenerating ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3" />
                          )}
                          Regenerate
                        </Button>
                      </div>
                      {wizard.generatedSections.map((section, idx) => (
                        <div key={idx} className="border rounded-md p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                              {section.type}
                            </p>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-xs gap-1"
                              onClick={() => setEditingSection(idx)}
                            >
                              <Edit2 className="h-3 w-3" />
                              Edit
                            </Button>
                          </div>
                          <p className="text-sm font-medium">{section.title}</p>
                          <p className="text-xs text-muted-foreground line-clamp-2">{section.content}</p>
                          {section.ctaText && (
                            <Badge variant="secondary" className="text-xs">{section.ctaText}</Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* ── Pull Local News ── */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Newspaper className="h-4 w-4 text-sky-500" />
                    Pull Local News
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-xs text-muted-foreground">
                    Enter your market ZIP codes to pull curated local headlines. Insert any of
                    them as a section, or configure a recurring source to keep them flowing in.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Market ZIP Codes</Label>
                      <Input
                        placeholder="e.g. 90210, 90211"
                        value={localNewsZips}
                        onChange={(e) => setLocalNewsZips(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Market Name (optional)</Label>
                      <Input
                        placeholder="e.g. Beverly Hills"
                        value={localNewsMarket}
                        onChange={(e) => setLocalNewsMarket(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-end gap-3">
                    <Button onClick={handlePullLocalNews} disabled={localNewsLoading} className="gap-2">
                      {localNewsLoading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Pulling…
                        </>
                      ) : (
                        <>
                          <Newspaper className="h-4 w-4" />
                          Pull Local News
                        </>
                      )}
                    </Button>

                    <div className="flex items-end gap-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Auto-refresh</Label>
                        <Select
                          value={localNewsFreq}
                          onValueChange={(v) => setLocalNewsFreq(v as "hourly" | "daily" | "weekly")}
                        >
                          <SelectTrigger className="h-9 w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="hourly">Hourly</SelectItem>
                            <SelectItem value="daily">Daily</SelectItem>
                            <SelectItem value="weekly">Weekly</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        variant="outline"
                        onClick={handleSaveNewsSource}
                        disabled={localNewsSaving}
                        className="gap-1.5"
                      >
                        {localNewsSaving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Settings2 className="h-3.5 w-3.5" />
                        )}
                        Save Source
                      </Button>
                    </div>
                  </div>

                  {localHeadlines.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {localHeadlines.length} headline{localHeadlines.length === 1 ? "" : "s"} — click to insert
                      </p>
                      {localHeadlines.map((h) => (
                        <div
                          key={h.key}
                          className="flex items-start justify-between gap-3 border rounded-md p-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{h.title}</p>
                            {h.summary && (
                              <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{h.summary}</p>
                            )}
                            <div className="flex items-center gap-2 mt-1">
                              {h.zip && (
                                <Badge variant="outline" className="text-[10px]">
                                  {h.zip}
                                </Badge>
                              )}
                              {h.score !== null && (
                                <span className="text-[10px] text-muted-foreground">
                                  relevance {h.score.toFixed(0)}
                                </span>
                              )}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs gap-1 shrink-0"
                            onClick={() => insertHeadline(h)}
                          >
                            <Plus className="h-3 w-3" />
                            Insert
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : localNewsFetched ? (
                    <p className="text-xs text-muted-foreground italic">
                      No local items yet for those ZIPs. Save a source above and items will appear here once collected.
                    </p>
                  ) : null}
                </CardContent>
              </Card>

              {/* Subject line A/B variants */}
              {wizard.generatedSections.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center justify-between">
                      Subject Line
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleGenerateSubjectVariants}
                        disabled={subjectVariantsLoading}
                        className="gap-1 text-xs"
                      >
                        {subjectVariantsLoading ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        Regenerate A/B
                      </Button>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Input
                      placeholder="Enter or select a subject line below"
                      value={wizard.subjectLine}
                      onChange={(e) => updateWizard({ subjectLine: e.target.value })}
                    />
                    {wizard.subjectVariants.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                          AI Variants — click to select
                        </p>
                        {wizard.subjectVariants.map((variant, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => updateWizard({ subjectLine: variant })}
                            className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                              wizard.subjectLine === variant
                                ? "border-primary bg-primary/5 text-foreground"
                                : "border-muted hover:border-primary/50 hover:bg-muted/50 text-muted-foreground"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-muted-foreground/60 shrink-0">
                                {String.fromCharCode(65 + i)}
                              </span>
                              {variant}
                              {wizard.subjectLine === variant && (
                                <Check className="h-3.5 w-3.5 text-primary ml-auto shrink-0" />
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* ── STEP 4: PREVIEW & EDIT ── */}
          {step === 4 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Full email preview. Hover any section and click <strong>Edit</strong> to modify it inline.
                </p>
              </div>
              <EmailPreview
                subject={wizard.subjectLine}
                fromName={wizard.fromName}
                sections={wizard.generatedSections}
                onEditSection={setEditingSection}
              />

              {/* Live SEO Score — recomputes as you edit content & subject. */}
              {seoBreakdown && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-emerald-500" />
                      SEO Score
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center gap-4">
                      <div
                        className={`text-3xl font-bold tabular-nums ${
                          seoBreakdown.overallScore >= 85
                            ? "text-emerald-600"
                            : seoBreakdown.overallScore >= 70
                            ? "text-amber-600"
                            : "text-red-600"
                        }`}
                      >
                        {seoBreakdown.overallScore}
                        <span className="text-base text-muted-foreground font-normal">/100</span>
                      </div>
                      <div className="flex-1 grid grid-cols-3 gap-2 text-center">
                        <div>
                          <p className="text-sm font-semibold tabular-nums">{seoBreakdown.readabilityScore}</p>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Readability</p>
                        </div>
                        <div>
                          <p className="text-sm font-semibold tabular-nums">{seoBreakdown.keywordDensity.toFixed(1)}%</p>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Kw Density</p>
                        </div>
                        <div>
                          <p className="text-sm font-semibold tabular-nums">{seoBreakdown.wordCount}</p>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Words</p>
                        </div>
                      </div>
                    </div>
                    {seoBreakdown.recommendations.length > 0 ? (
                      <div className="space-y-1">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Recommendations
                        </p>
                        <ul className="space-y-1">
                          {seoBreakdown.recommendations.map((rec, i) => (
                            <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                              <span className="text-amber-500 mt-0.5">•</span>
                              {rec}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="text-xs text-emerald-600 flex items-center gap-1.5">
                        <Check className="h-3.5 w-3.5" />
                        Looks great — no SEO issues detected.
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* ── STEP 5: SEND OPTIMIZATION ── */}
          {step === 5 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Send Optimization</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {isOptimizing ? (
                  <div className="flex items-center gap-3 py-8 justify-center text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span>Analyzing your audience engagement history…</span>
                  </div>
                ) : wizard.sendOptimization ? (
                  <div className="space-y-4">
                    <div className="rounded-xl border bg-gradient-to-br from-primary/5 to-primary/10 p-5">
                      <div className="flex items-start gap-3">
                        <div className="rounded-full bg-primary/10 p-2">
                          <Clock className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <p className="font-semibold text-foreground">
                            Send on {wizard.sendOptimization.recommendedDay} at {wizard.sendOptimization.recommendedTime}
                          </p>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            {wizard.sendOptimization.reasoning}
                          </p>
                          <div className="mt-2 flex items-center gap-2">
                            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                              <div
                                className="h-full bg-primary rounded-full"
                                style={{ width: `${wizard.sendOptimization.confidence ?? 70}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {wizard.sendOptimization.confidence ?? 70}% confidence
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      You can apply this recommendation in Step 6 when you schedule the send time.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleOptimizeSendTime}
                      disabled={isOptimizing}
                      className="gap-1"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Re-analyze
                    </Button>
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <p className="text-sm text-muted-foreground mb-3">
                      AI couldn&apos;t retrieve optimization data. You can still send or schedule manually.
                    </p>
                    <Button variant="outline" size="sm" onClick={handleOptimizeSendTime} className="gap-1">
                      <RefreshCw className="h-3.5 w-3.5" />
                      Try Again
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── STEP 6: SEND / SCHEDULE ── */}
          {step === 6 && (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Review & Send</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  {/* Summary */}
                  <div className="space-y-2 text-sm">
                    {[
                      { label: "Campaign", value: wizard.campaignName },
                      { label: "Subject", value: wizard.subjectLine },
                      { label: "Audience", value: AUDIENCE_LABELS[wizard.audienceSegment] },
                      { label: "Sections", value: wizard.sections.join(", ") },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex items-start gap-2">
                        <span className="text-muted-foreground w-20 shrink-0">{label}:</span>
                        <span className="font-medium">{value}</span>
                      </div>
                    ))}
                  </div>

                  <hr />

                  {/* Send mode */}
                  <div className="space-y-3">
                    <p className="text-sm font-medium">When to send?</p>
                    <div className="grid grid-cols-2 gap-3">
                      {(["scheduled", "now"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => updateWizard({ sendMode: mode })}
                          className={`rounded-lg border px-4 py-3 text-sm text-left transition-colors ${
                            wizard.sendMode === mode
                              ? "border-primary bg-primary/5"
                              : "border-muted hover:border-primary/40"
                          }`}
                        >
                          <div className="font-medium">
                            {mode === "now" ? "Send Now" : "Schedule"}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {mode === "now" ? "Deliver immediately" : "Pick a date and time"}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {wizard.sendMode === "scheduled" && (
                    <div className="space-y-2">
                      <Label>Schedule Date & Time</Label>
                      {wizard.sendOptimization && (
                        <p className="text-xs text-muted-foreground">
                          AI recommends: {wizard.sendOptimization.recommendedDay} at {wizard.sendOptimization.recommendedTime}
                        </p>
                      )}
                      <Input
                        type="datetime-local"
                        value={wizard.scheduleDate}
                        onChange={(e) => updateWizard({ scheduleDate: e.target.value })}
                      />
                      {wizard.scheduleDate &&
                        !validateScheduleTime(wizard.scheduleDate).valid && (
                          <p className="text-xs text-destructive">
                            {validateScheduleTime(wizard.scheduleDate).reason}
                          </p>
                        )}
                    </div>
                  )}

                  {/* Governed scheduled send — writes a newsletter_scheduled_sends
                      row against an approved template; the cron delivers it later
                      through the egress gate (no inline consumer send here). */}
                  {wizard.sendMode === "scheduled" && (
                    <div className="space-y-2 rounded-lg border border-dashed p-3">
                      <Label className="text-xs">Governed Schedule Send (approved template)</Label>
                      <Select value={scheduleTemplateId} onValueChange={setScheduleTemplateId}>
                        <SelectTrigger>
                          <SelectValue
                            placeholder={
                              approvedTemplates.length === 0
                                ? "No approved templates"
                                : "Select an approved template"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {approvedTemplates.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.template_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Records a governed scheduled send. The cron delivers it through the
                        egress gate at the chosen time — nothing is sent now.
                      </p>
                      <Button
                        variant="outline"
                        className="w-full gap-2"
                        disabled={
                          isRegisteringSend ||
                          !scheduleTemplateId ||
                          !validateScheduleTime(wizard.scheduleDate).valid
                        }
                        onClick={handleRegisterScheduledSend}
                      >
                        {isRegisteringSend ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Registering…
                          </>
                        ) : (
                          <>
                            <Clock className="h-4 w-4" />
                            Register Scheduled Send
                          </>
                        )}
                      </Button>
                    </div>
                  )}

                  <Button
                    className="w-full gap-2"
                    disabled={isSubmitting || (wizard.sendMode === "scheduled" && !wizard.scheduleDate)}
                    onClick={handleSubmit}
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {wizard.sendMode === "now" ? "Sending…" : "Saving…"}
                      </>
                    ) : wizard.sendMode === "now" ? (
                      <>
                        <Send className="h-4 w-4" />
                        Send Now
                      </>
                    ) : wizard.scheduleDate ? (
                      <>
                        <Calendar className="h-4 w-4" />
                        Schedule for {format(new Date(wizard.scheduleDate), "MMM d 'at' h:mm a")}
                      </>
                    ) : (
                      <>
                        <Calendar className="h-4 w-4" />
                        Schedule (pick date above)
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Wizard navigation */}
          <div className="flex items-center justify-between mt-6">
            <Button
              variant="outline"
              onClick={() => setStep((s) => Math.max(s - 1, 1))}
              disabled={step === 1}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>
            {step < 6 && (
              <Button onClick={handleNext} disabled={!canAdvance()} className="gap-1">
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Section edit modal */}
        {editingSection !== null && wizard.generatedSections[editingSection] && (
          <SectionEditor
            section={wizard.generatedSections[editingSection]}
            onSave={(updated) => {
              const next = [...wizard.generatedSections]
              next[editingSection] = updated
              updateWizard({ generatedSections: next })
            }}
            onClose={() => setEditingSection(null)}
          />
        )}
      </div>
    )
  }

  // ─── Campaign List View ───────────────────────────────────────────────────

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      {/* Banner — surfaces a fresh draft staged via voice/Copilot
          stage_newsletter_draft tool. Reads `?draft=<uuid>`. */}
      <StagedDraftBanner
        paramKey="draft"
        label="Newsletter draft"
        hint="Find your new draft in the Drafts list below — open it to add sections, optimize the subject, and schedule the send."
      />
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Newsletter Manager</h1>
          <p className="text-muted-foreground">
            Design, schedule, and send professional newsletters to your database
          </p>
        </div>
        <Button onClick={openWizard} className="gap-2">
          <Plus className="h-4 w-4" />
          Create Newsletter
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {[
          { icon: Clock, label: "Scheduled", value: stats.activeCampaigns },
          { icon: Users, label: "Active Subscribers", value: stats.totalSubscribers.toLocaleString() },
          {
            icon: TrendingUp,
            label: "Avg. Open Rate",
            value: stats.avgOpenRate !== null ? `${stats.avgOpenRate.toFixed(1)}%` : "--",
          },
        ].map(({ icon: Icon, label, value }) => (
          <Card key={label}>
            <CardContent className="pt-6 pb-4">
              <div className="flex items-center gap-3">
                <div className="rounded-full bg-primary/10 p-2">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="text-2xl font-bold">{value}</div>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Campaigns + Analytics tabs */}
      <div className="space-y-1 mb-4 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={handleLoadAnalytics}
          disabled={analyticsLoading}
        >
          {analyticsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TrendingUp className="h-3.5 w-3.5" />}
          Performance Analytics
        </Button>
      </div>

      {/* Analytics panel (lazy loaded) */}
      {analyticsLoaded && (
        <div className="mb-6 space-y-4">
          {analyticsData?.success && (analyticsData as any).metrics && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Open Rate", value: `${((analyticsData as any).metrics.openRate ?? 0).toFixed(1)}%` },
                { label: "Click Rate", value: `${((analyticsData as any).metrics.clickRate ?? 0).toFixed(1)}%` },
                { label: "Unsubscribes", value: (analyticsData as any).metrics.unsubscribeCount ?? 0 },
                { label: "Bounces", value: (analyticsData as any).metrics.bounceCount ?? 0 },
              ].map((m) => (
                <Card key={m.label}>
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground">{m.label}</p>
                    <p className="text-2xl font-bold tabular-nums">{m.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          {analyticsInsights && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-500" />
                  AI Performance Insights
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {(analyticsInsights as any).insights?.map((insight: string, i: number) => (
                  <p key={i} className="text-muted-foreground">• {insight}</p>
                ))}
                {(analyticsInsights as any).recommendations?.map((rec: string, i: number) => (
                  <p key={i} className="text-foreground font-medium">→ {rec}</p>
                ))}
                {!(analyticsInsights as any).insights?.length && !(analyticsInsights as any).recommendations?.length && (
                  <p className="text-muted-foreground">No insights available yet. Send more campaigns to generate analysis.</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Campaign list */}
      {campaigns.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <MailOpen className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="font-medium mb-1">No campaigns yet</p>
            <p className="text-sm text-muted-foreground mb-4">
              Create your first newsletter to start engaging with subscribers.
            </p>
            <Button onClick={openWizard} className="gap-2">
              <Plus className="h-4 w-4" />
              Create Newsletter
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {campaigns.map((campaign) => (
            <Card key={campaign.id}>
              <CardContent className="py-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium truncate">{campaign.campaign_name}</p>
                      <Badge
                        className={`text-xs ${STATUS_COLORS[campaign.status] ?? "bg-muted text-muted-foreground"}`}
                        variant="secondary"
                      >
                        {campaign.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground truncate mt-0.5">{campaign.subject_line}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Created {format(new Date(campaign.created_at), "MMM d, yyyy")}
                      {campaign.send_date &&
                        ` · Sends ${format(new Date(campaign.send_date), "MMM d, yyyy 'at' h:mm a")}`}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {campaign.status === "draft" && (
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="datetime-local"
                          className="h-8 text-xs w-44"
                          value={scheduleDate}
                          onChange={(e) => setScheduleDate(e.target.value)}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 h-8"
                          onClick={() => handleSchedule(campaign.id)}
                          disabled={!scheduleDate}
                        >
                          <Calendar className="h-3.5 w-3.5" />
                          Schedule
                        </Button>
                      </div>
                    )}

                    {(campaign.status === "draft" || campaign.status === "scheduled") && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="sm"
                            className="gap-1 h-8"
                            disabled={sendingId === campaign.id}
                          >
                            {sendingId === campaign.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                            Send
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Send Campaign Now?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will immediately send &quot;{campaign.campaign_name}&quot; to all active
                              subscribers. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleSend(campaign.id)}>
                              Send Now
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}

                    {campaign.status === "sent" && campaign.open_rate !== null && (
                      <Badge variant="outline" className="text-xs gap-1">
                        <TrendingUp className="h-3 w-3" />
                        {campaign.open_rate.toFixed(1)}% open
                      </Badge>
                    )}

                    {campaign.status !== "sent" && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                            disabled={deletingId === campaign.id}
                          >
                            {deletingId === campaign.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Campaign?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently delete &quot;{campaign.campaign_name}&quot;. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDelete(campaign.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
