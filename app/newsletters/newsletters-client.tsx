"use client"

import { useState, useCallback } from "react"
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
} from "lucide-react"
import {
  aiGenerateSubjectLines,
  aiOptimizeSendTime,
  aiWriteNewsletterContent,
  createNewsletterCampaign,
  getNewsletterAnalytics,
  aiAnalyzeNewsletterPerformance,
} from "@/app/actions/ai-newsletter"
import {
  sendEmailCampaign,
  scheduleEmailCampaign,
  deleteEmailCampaign,
} from "@/app/actions/email-campaigns"
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

  // Campaign list actions
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [scheduleDate, setScheduleDate] = useState("")

  // Analytics
  const [analyticsData, setAnalyticsData] = useState<any>(null)
  const [analyticsInsights, setAnalyticsInsights] = useState<any>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsLoaded, setAnalyticsLoaded] = useState(false)

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function updateWizard(patch: Partial<WizardData>) {
    setWizard((prev) => ({ ...prev, ...patch }))
  }

  function openWizard() {
    setWizard(INITIAL_WIZARD)
    setStep(1)
    setWizardOpen(true)
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
      })
      if (result.success && result.newsletter) {
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
          const sendResult = await sendEmailCampaign(result.newsletter.id, userId, brokerageId)
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

  // ── Campaign list actions ────────────────────────────────────────────────

  async function handleSend(campaignId: string) {
    setSendingId(campaignId)
    try {
      const result = await sendEmailCampaign(campaignId, userId, brokerageId)
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
      const result = await scheduleEmailCampaign(campaignId, userId, scheduleDate)
      if (result.success) {
        setCampaigns((prev) =>
          prev.map((c) =>
            c.id === campaignId ? { ...c, status: "scheduled", send_date: scheduleDate } : c
          )
        )
        toast.success("Campaign scheduled")
        setScheduleDate("")
      } else {
        toast.error((result as any).error ?? "Failed to schedule campaign")
      }
    } catch {
      toast.error("Unexpected error scheduling campaign")
    }
  }

  async function handleDelete(campaignId: string) {
    setDeletingId(campaignId)
    try {
      const result = await deleteEmailCampaign(campaignId)
      if (result.success) {
        setCampaigns((prev) => prev.filter((c) => c.id !== campaignId))
        toast.success("Campaign deleted")
      } else {
        toast.error((result as any).error ?? "Failed to delete campaign")
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
