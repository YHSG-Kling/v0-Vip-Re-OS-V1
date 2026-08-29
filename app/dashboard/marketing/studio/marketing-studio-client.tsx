"use client"

import { useState, useEffect, useMemo } from "react"
import { useToast } from "@/hooks/use-toast"
import { StagedDraftBanner } from "@/app/components/shared/staged-draft-banner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { MarketingOpsPanel } from "./components/marketing-ops-panel"
import { ReadinessTrendsPanel } from "./components/readiness-trends-panel"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { format } from "date-fns"
import {
  LayoutDashboard,
  Megaphone,
  Image,
  Calendar as CalendarIcon,
  MessageSquare,
  CheckSquare,
  QrCode,
  Plus,
  Search,
  Filter,
  Loader2,
  Play,
  Pause,
  CheckCircle,
  Clock,
  AlertCircle,
  TrendingUp,
  ChevronRight,
  Eye,
  Edit,
  Trash2,
  Link2,
  FileText,
  Video,
  Mail,
  Sparkles,
  Rocket,
  Mic,
  Send,
  ExternalLink,
  Newspaper,
  Truck,
  Activity,
} from "lucide-react"
import {
  getCampaigns,
  createCampaign,
  updateCampaign,
  generateCampaignContent,
  getCampaignById,
  transitionCampaignStatus,
  getAssets,
  createAsset,
  approveAsset,
  rejectAsset,
  getCalendarEvents,
  createCalendarEvent,
  updateCalendarEventStatus,
  // TOMBSTONE (dead-import tranche): `getCampaignComments` and
  // `getCampaignTasks` were imported here and never called, and this is their
  // only importer in the tree. Survivor: `getCampaignById` (imported above),
  // whose bundle already carries `campaign.comments` and `campaign.tasks` —
  // it is what populates the two lists in the detail dialog and what
  // refreshOpenCampaignDetail re-reads after a write. A second reader of the
  // same two tables would give one dialog two sources for one list.
  addCampaignComment,
  createCampaignTask,
  updateTaskStatus,
  getMarketingStudioDashboard,
  linkQrToAsset,
  getAssetQrLinks,
  unlinkQrFromAsset,
  getQrCodePerformance,
  type CampaignStatus,
  type AssetApprovalStatus,
  type VisibilityScope,
} from "@/app/actions/marketing-studio"
import { getMailCampaigns } from "@/app/actions/direct-mail"
import { getMyMarketingCadencePolicies, type MarketingCadencePolicyRow } from "@/app/actions/marketing-cadence-policy"
import { createCampaignSequence, createSequenceStep, deleteCampaignSequence } from "@/app/actions/campaign-sequences"
import { getCampaignRegistry, registerCampaignSource, type ContentSourceItem } from "@/lib/marketing/campaign-registry"
import { listAvailableQrCodes, type QrLinkInfo } from "@/lib/marketing/qr-asset-linker"
// TYPE-ONLY: lib/marketing/tracked-qr.ts is `server-only` (it holds the service client), so a
// value import would crash this client component at load. The types are erased at compile time,
// and they are what keeps the option lists below from drifting out of the live CHECK vocabularies
// — an option whose value is not in the union is a build error, not a runtime refused insert.
import type { QrPurpose, QrDestinationType } from "@/lib/marketing/tracked-qr"

/** qr_codes.purpose CHECK — the full live set. */
const QR_PURPOSE_OPTIONS: Array<{ value: QrPurpose; label: string }> = [
  { value: "general",         label: "General" },
  { value: "open_house",      label: "Open House" },
  { value: "listing",         label: "Listing" },
  { value: "listing_inquiry", label: "Listing Inquiry" },
  { value: "lead_capture",    label: "Lead Capture" },
  { value: "lead_magnet",     label: "Lead Magnet" },
  { value: "campaign",        label: "Campaign" },
  { value: "event",           label: "Event" },
  { value: "business_card",   label: "Business Card" },
]

/** qr_codes.destination_type CHECK (m148) — what analytics buckets scans by. */
const QR_DESTINATION_OPTIONS: Array<{ value: QrDestinationType; label: string }> = [
  { value: "landing_page",      label: "Landing Page" },
  { value: "listing_detail",    label: "Listing Detail" },
  { value: "book_meeting",      label: "Book a Meeting" },
  { value: "cma_form",          label: "CMA / Home Value Form" },
  { value: "video_avatar_tour", label: "Video Tour" },
  { value: "podcast_episode",   label: "Podcast Episode" },
  { value: "anniversary_video", label: "Anniversary Video" },
  { value: "other",             label: "Other" },
]
import { predictPerformanceAction, getUserContextForPrediction } from "@/app/actions/content-prediction"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
import { PredictionWidget, type PredictionData } from "@/app/components/prediction-widget"
import {
  CampaignLauncherPanel,
  CompetitorWatchPanel,
  RepurposeEnginePanel,
  CreativeVariationsPanel,
  PerformanceIntelligencePanel,
  PrelaunchPredictionPanel,
  SellerSafeMarketingSummary,
  ListingCopyPanel,
} from "./components/ad-os"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface Campaign {
  id: string
  campaign_name: string
  campaign_type: string
  status: CampaignStatus
  listing_id?: string
  budget_total: number
  budget_spent: number
  scheduled_start_at?: string
  scheduled_end_at?: string
  launched_at?: string
  completed_at?: string
  created_at: string
  listing?: { address?: string; city?: string; list_price?: number }
  assets?: { count: number }[]
  tasks?: { count: number }[]
}

interface Asset {
  id: string
  asset_name: string
  asset_type: string
  approval_status: AssetApprovalStatus
  asset_url?: string
  thumbnail_url?: string
  preview_text?: string
  campaign_id?: string
  source_table?: string
  source_id?: string
  created_at: string
  qr_links?: QrLinkInfo[]
}

interface CalendarEvent {
  id: string
  title: string
  event_type: string
  channel?: string
  scheduled_at: string
  status: string
  notes?: string
  campaign?: { campaign_name: string }
}

interface Task {
  id: string
  title: string
  description?: string
  status: string
  due_at?: string
  assignee?: { first_name: string; last_name: string }
}

interface Comment {
  id: string
  comment_body: string
  created_at: string
  author?: { first_name: string; last_name: string }
}

interface DashboardData {
  campaignsByStatus: Record<string, number>
  totalCampaigns: number
  assetsByApproval: Record<string, number>
  totalAssets: number
  upcomingEvents: CalendarEvent[]
  pendingTasks: Task[]
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

interface MarketingStudioClientProps {
  userId?: string
  /** agents(id) — server-resolved. NOT interchangeable with userId. */
  agentId?: string
  brokerageId?: string
  userRole?: string
  initialTab?: string
}

/**
 * One line of honest cadence copy. "off"/no row means the cron will never fire
 * for this channel — said out loud, because silence reads as "it is handled".
 */
function describeCadence(label: string, row: MarketingCadencePolicyRow | null): string {
  if (!row || row.cadence === "off") return `${label}: manual only`
  const day = row.fire_day !== null && row.fire_day !== undefined ? ` (day ${row.fire_day})` : ""
  return `${label}: auto ${row.cadence}${day}`
}

export default function MarketingStudioClient({ userId: userIdProp, agentId: agentIdProp, brokerageId: brokerageIdProp, userRole, initialTab = "overview" }: MarketingStudioClientProps) {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState(initialTab)
  const [isLoading, setIsLoading] = useState(true)
  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null)
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [calendarViewDate, setCalendarViewDate] = useState(new Date())
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")

  const eventsByDate = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {}
    for (const ev of calendarEvents) {
      const key = format(new Date(ev.scheduled_at), "yyyy-MM-dd")
      if (!map[key]) map[key] = []
      map[key].push(ev)
    }
    return map
  }, [calendarEvents])

  // Dialog states
  const [isCreateCampaignOpen, setIsCreateCampaignOpen] = useState(false)
  const [isCreateAssetOpen, setIsCreateAssetOpen] = useState(false)
  const [isCreateEventOpen, setIsCreateEventOpen] = useState(false)
  const [isRegistryOpen, setIsRegistryOpen] = useState(false)
  const [isQrLinkOpen, setIsQrLinkOpen] = useState(false)
  const [selectedAssetForQr, setSelectedAssetForQr] = useState<string | null>(null)
  const [qrLinkError, setQrLinkError] = useState<string | null>(null)
  // getAssetQrLinks + unlinkQrFromAsset were IMPORTED BUT NEVER INVOKED: the studio could attach
  // a QR to an asset and then had no way to see or remove what it had attached, and the Asset
  // type's `qr_links` field was never populated by anything. Both are now called here.
  const [assetQrLinks, setAssetQrLinks] = useState<QrLinkInfo[]>([])
  const [isLoadingQrLinks, setIsLoadingQrLinks] = useState(false)
  // getQrCodePerformance was an ORPHAN EXPORT — the only reader of per-code scan DETAIL
  // (unique scans + the recent-scan list from qr_scan_events). Nothing else surfaces it, so it
  // was wired rather than deleted.
  const [qrPerformance, setQrPerformance] = useState<Record<string, any>>({})
  const [loadingQrPerformanceId, setLoadingQrPerformanceId] = useState<string | null>(null)

  // Campaign detail (the eye control on every campaign card)
  // ── CAMPAIGN COLLABORATION COMPOSERS ───────────────────────────────────────
  //
  // BUILT, not tidied. `addCampaignComment` and `createCampaignTask` were
  // imported by this file and called by NOTHING — and this is the only importer
  // of either, anywhere in the tree. The campaign detail dialog below RENDERS
  // "Tasks (n)" and "Comments (n)" and has done all along; there was simply no
  // way for a human to produce either one, so both lists could only ever read
  // "No tasks on this campaign yet." / "No comments yet." Confirmed against the
  // live database (hrvaqgvukzxfskkcrwbt): marketing_campaign_comments and
  // marketing_campaign_tasks each hold 0 rows — a writer with no caller and a
  // reader with nothing to read.
  //
  // The dead imports named the missing UI precisely: `Popover` /
  // `PopoverContent` / `PopoverTrigger` and `MessageSquare` were imported by
  // this file and unused too. They are the task composer and the comment
  // affordance, which is what the two below now are.
  const [newCommentBody, setNewCommentBody] = useState("")
  const [isPostingComment, setIsPostingComment] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState("")
  const [newTaskDueAt, setNewTaskDueAt] = useState("")
  const [isCreatingTask, setIsCreatingTask] = useState(false)
  const [isTaskComposerOpen, setIsTaskComposerOpen] = useState(false)
  const [collabError, setCollabError] = useState<string | null>(null)

  const [isCampaignDetailOpen, setIsCampaignDetailOpen] = useState(false)
  const [campaignDetail, setCampaignDetail] = useState<any | null>(null)
  const [isLoadingCampaignDetail, setIsLoadingCampaignDetail] = useState(false)
  const [campaignDetailError, setCampaignDetailError] = useState<string | null>(null)

  // Newsletter template preview (the chevron on every template row)
  const [previewTemplate, setPreviewTemplate] = useState<any | null>(null)

  // Registry data
  const [registryItems, setRegistryItems] = useState<ContentSourceItem[]>([])
  const [availableQrCodes, setAvailableQrCodes] = useState<any[]>([])
  
  // Prediction widget state
  const [isPredictionDialogOpen, setIsPredictionDialogOpen] = useState(false)
  const [selectedAssetForPrediction, setSelectedAssetForPrediction] = useState<Asset | null>(null)
  const [currentPrediction, setCurrentPrediction] = useState<PredictionData | null>(null)
  const [isPredicting, setIsPredicting] = useState(false)

  // Newsletter state
  const [newsletterCampaigns, setNewsletterCampaigns] = useState<any[]>([])
  const [scheduledSends, setScheduledSends] = useState<any[]>([])
  const [subscriberCount, setSubscriberCount] = useState(0)
  const [newsletterTemplates, setNewsletterTemplates] = useState<any[]>([])
  const [localContent, setLocalContent] = useState<any[]>([])
  const [isNewsletterLoading, setIsNewsletterLoading] = useState(false)
  const [newsletterError, setNewsletterError] = useState<string | null>(null)

  // EMAIL CAMPAIGN state. The "New Campaign" button on this tab has always
  // called createEmailCampaign, which writes `email_campaigns` — but the list
  // beside it read `newsletter_campaigns`, so every campaign created here
  // vanished on save. These are the email_campaigns rows, read back through
  // the canonical brokerage-scoped action.
  const [emailCampaigns, setEmailCampaigns] = useState<any[]>([])
  const [emailStats, setEmailStats] = useState<{
    totalCampaigns: number
    activeCampaigns: number
    totalSubscribers: number
    avgOpenRate: number | null
  } | null>(null)
  const [emailCampaignsError, setEmailCampaignsError] = useState<string | null>(null)
  // Per-row schedule pickers, keyed by campaign id, so opening one row's
  // scheduler does not clobber another's half-entered time.
  const [emailScheduleDrafts, setEmailScheduleDrafts] = useState<Record<string, string>>({})
  const [schedulingEmailCampaignId, setSchedulingEmailCampaignId] = useState<string | null>(null)
  const [deletingEmailCampaignId, setDeletingEmailCampaignId] = useState<string | null>(null)
  const [editingEmailCampaign, setEditingEmailCampaign] = useState<any | null>(null)
  const [emailEditorDraft, setEmailEditorDraft] = useState({
    campaignName: "",
    subjectLine: "",
    previewText: "",
    content: "",
  })
  const [isLoadingEmailCampaign, setIsLoadingEmailCampaign] = useState(false)
  const [isSavingEmailCampaign, setIsSavingEmailCampaign] = useState(false)
  const [emailEditorError, setEmailEditorError] = useState<string | null>(null)
  const [isComposingEmail, setIsComposingEmail] = useState(false)
  const [aiComposeTopic, setAiComposeTopic] = useState("")
  const [aiComposeAudience, setAiComposeAudience] = useState<
    "buyers" | "sellers" | "investors" | "lifetime_customers" | "all"
  >("all")

  // AI newsletter generator (writes a newsletter_campaigns draft through the
  // canonical createNewsletterCampaign writer — see ai-marketing-automation).
  const [isAiNewsletterOpen, setIsAiNewsletterOpen] = useState(false)
  const [aiNewsletter, setAiNewsletter] = useState<{
    topic: string
    audienceSegment: "buyers" | "sellers" | "investors" | "lifetime_customers" | "sphere" | "all"
    tone: "professional" | "friendly" | "educational" | "urgent"
    includeMarketData: boolean
    includeListings: boolean
  }>({
    topic: "",
    audienceSegment: "all",
    tone: "friendly",
    includeMarketData: true,
    includeListings: true,
  })
  const [isGeneratingNewsletter, setIsGeneratingNewsletter] = useState(false)
  const [aiNewsletterError, setAiNewsletterError] = useState<string | null>(null)
  const [subjectVariants, setSubjectVariants] = useState<string[] | null>(null)
  const [isGeneratingVariants, setIsGeneratingVariants] = useState(false)

  // Bulk readiness sweep over the loaded marketing assets. Each verdict is
  // RECORDED against the asset, which is where the ops tab's pass-rate reads.
  const [isSweepingReadiness, setIsSweepingReadiness] = useState(false)
  const [readinessSweep, setReadinessSweep] = useState<{
    results: Array<{ contentId: string; status: "ready" | "blocked"; blockingReasons: string[] }>
    loggedCount: number
    logError: string | null
  } | null>(null)
  const [readinessSweepError, setReadinessSweepError] = useState<string | null>(null)

  // Blog state
  const [blogPosts, setBlogPosts] = useState<any[]>([])
  const [isBlogLoading, setIsBlogLoading] = useState(false)

  // Video state

  // Podcast state
  const [podcastEpisodes, setPodcastEpisodes] = useState<any[]>([])
  const [isPodcastLoading, setIsPodcastLoading] = useState(false)

  // Direct Mail state
  const [mailCampaigns, setMailCampaigns] = useState<any[]>([])
  const [isMailLoading, setIsMailLoading] = useState(false)

  // Omnichannel sequence builder state
  type OmnichannelStepType = "email" | "sms" | "social_post" | "video" | "direct_mail" | "wait"
  interface OmnichannelStep {
    id: string
    type: OmnichannelStepType
    name: string
    delay_days: number
    delay_hours: number
    subject: string
    body: string
  }
  const [omnichannelName, setOmnichannelName] = useState("")
  const [omnichannelDescription, setOmnichannelDescription] = useState("")
  const [omnichannelSteps, setOmnichannelSteps] = useState<OmnichannelStep[]>([])
  const [isCreatingOmnichannel, setIsCreatingOmnichannel] = useState(false)
  const [omnichannelSuccess, setOmnichannelSuccess] = useState<string | null>(null)

  // Create newsletter dialog state (inline in studio)
  const [isCreateNewsletterOpen, setIsCreateNewsletterOpen] = useState(false)
  const [newNewsletter, setNewNewsletter] = useState({ campaignName: "", subjectLine: "", content: "", marketingCampaignId: "", audienceSegmentId: "" })
  // The segments this brokerage actually has. There is no segment catalogue in
  // the schema (contact_segments.segment_id carries no FK and nothing names a
  // segment), so the list is derived from live memberships and labelled by id
  // prefix + member count — the same honest treatment the contact page's
  // segment badges already use. Without this control
  // email_campaigns.audience_segment_id had no writer at all and the sender's
  // segment-targeted path was unreachable.
  const [audienceSegments, setAudienceSegments] = useState<Array<{ segmentId: string; memberCount: number }>>([])
  const [audienceSegmentsError, setAudienceSegmentsError] = useState<string | null>(null)
  const [isCreatingNewsletter, setIsCreatingNewsletter] = useState(false)

  // Create QR dialog state (inline in studio)
  const [isCreateQrOpen, setIsCreateQrOpen] = useState(false)
  // purpose + destinationType are CHECK-constrained vocabularies on qr_codes; these lists are the
  // LIVE sets (verified against the database), and a value outside them is a refused insert.
  const [newQr, setNewQr] = useState<{
    label: string
    targetUrl: string
    purpose: QrPurpose
    destinationType: QrDestinationType | ""
    /** ★ TRACKING LINKED TO CAMPAIGN ★ marketing_campaigns.id → qr_codes.marketing_campaign_id. */
    campaignId: string
    expiresAt: string
  }>({ label: "", targetUrl: "", purpose: "general", destinationType: "", campaignId: "", expiresAt: "" })
  const [isCreatingQr, setIsCreatingQr] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)

  // Ad OS state
  const [listings, setListings] = useState<Array<{ id: string; address: string; city: string; zip?: string; list_price?: number }>>([])
  // agents(id), server-resolved. This was seeded from userIdProp — a users id
  // wearing the name agentId — and every downstream consumer is agents-class.
  const [agentId, setAgentId] = useState<string>(agentIdProp ?? "")
  const [brokerageId, setBrokerageId] = useState<string>(brokerageIdProp ?? "")

  // Form states
  const [newCampaign, setNewCampaign] = useState({
    campaignName: "",
    campaignType: "brand" as const,
    budgetTotal: 0,
    scheduledStartAt: "",
    scheduledEndAt: "",
    visibilityScope: "agent" as VisibilityScope,
  })
  // ── EDIT A CAMPAIGN ─────────────────────────────────────────────────────────
  // A campaign's name, budget and flight dates were write-once from this
  // screen: createCampaign could set them and transitionCampaignStatus could
  // move the campaign through its lifecycle, but nothing could correct a typo
  // or a budget. updateCampaign is the writer that was already there.
  const [editingCampaign, setEditingCampaign] = useState<any | null>(null)
  const [editCampaign, setEditCampaign] = useState({
    campaignName: "",
    budgetTotal: "",
    scheduledStartAt: "",
    scheduledEndAt: "",
  })
  const [isSavingCampaign, setIsSavingCampaign] = useState(false)
  // ── AI COPY FOR AN ASSET, IN THE BRAND VOICE ────────────────────────────────
  // generateCampaignContent grounds the copy in the campaign (name, type, the
  // linked listing) AND in the brokerage's brand_voice_profile, then runs the
  // Fair-Housing / Them-First gates before returning. Writing asset copy by
  // hand in this dialog skipped all of it.
  // ── YOUR CONTENT HEARTBEAT ──────────────────────────────────────────────────
  // The newsletter + social cadence crons publish on a schedule the agent set
  // once, on a Settings page they had to already know about. Nothing on the
  // marketing surface said whether anything was scheduled to go out at all —
  // the same gap the blog dashboard closed with getMyBlogCadencePolicy.
  const [cadence, setCadence] = useState<{
    newsletter: MarketingCadencePolicyRow | null
    social: MarketingCadencePolicyRow | null
  } | null>(null)
  const [isWritingAsset, setIsWritingAsset] = useState(false)
  const [assetCopyPrompt, setAssetCopyPrompt] = useState("")
  const [assetBrandVoice, setAssetBrandVoice] = useState<{ violations: string[]; notes: string[] } | null>(null)
  const [newAsset, setNewAsset] = useState<{
    assetName: string
    assetType: string
    campaignId: string
    previewText: string
    qrTargetUrl: string
  }>({
    assetName: "",
    assetType: "graphic",
    campaignId: "",
    previewText: "",
    qrTargetUrl: "",
  })
  const [newEvent, setNewEvent] = useState({
    title: "",
    eventType: "publish" as const,
    scheduledAt: "",
    campaignId: "",
    notes: "",
  })

  // ─── LOAD DATA ────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadInitialData()
    // A REFUSED read is not "no cadence configured" — leave the state null so
    // the chip simply does not render, rather than telling the agent nothing is
    // scheduled when we could not check.
    getMyMarketingCadencePolicies()
      .then((r) => {
        if (!r.success) return
        setCadence({ newsletter: r.newsletter ?? null, social: r.social ?? null })
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (activeTab === "campaigns")   loadCampaigns()
    if (activeTab === "assets")      loadAssets()
    if (activeTab === "calendar")    loadCalendarEvents()
    if (activeTab === "newsletters") loadNewsletterData()
    if (activeTab === "ad-os")       loadAdOsData()
    if (activeTab === "blog")        loadBlogData()
    if (activeTab === "podcast")     loadPodcastData()
    if (activeTab === "mail")        loadMailData()
  }, [activeTab, statusFilter])

  useEffect(() => {
    if (activeTab === "calendar") loadCalendarEvents()
  }, [calendarViewDate])

  async function loadInitialData() {
    setIsLoading(true)
    try {
      const [dashboardResult, campaignsResult] = await Promise.all([
        getMarketingStudioDashboard(),
        getCampaigns({ status: statusFilter !== "all" ? (statusFilter as CampaignStatus) : undefined }),
      ])
      if (dashboardResult.success) {
        setDashboard((dashboardResult as any).dashboard)
        setDashboardError(null)
      } else {
        setDashboardError((dashboardResult as any).error ?? "Failed to load dashboard metrics")
      }
      if (campaignsResult.success) setCampaigns(campaignsResult.campaigns)
    } catch (error) {
      console.error("[v0] Failed to load marketing studio data:", error)
    } finally {
      setIsLoading(false)
    }
  }

  async function loadAudienceSegments() {
    const { listAudienceSegments } = await import("@/app/actions/email-campaigns")
    const res = await listAudienceSegments()
    if (!(res as any).success) {
      // A refused read is NOT "you have no segments" — say so, or the agent
      // picks "everyone" believing that is their only option.
      setAudienceSegmentsError((res as any).error ?? "Could not load your segments")
      setAudienceSegments([])
      return
    }
    setAudienceSegmentsError(null)
    setAudienceSegments((res as any).segments ?? [])
  }

  async function loadCampaigns() {
    const result = await getCampaigns({
      status: statusFilter !== "all" ? (statusFilter as CampaignStatus) : undefined,
    })
    if (result.success) setCampaigns(result.campaigns)
  }

  async function loadAssets() {
    const result = await getAssets({
      approvalStatus: statusFilter !== "all" ? (statusFilter as AssetApprovalStatus) : undefined,
    })
    if (result.success) setAssets(result.assets)
  }

  async function loadCalendarEvents() {
    const start = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth(), 1)
    const end = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 0)
    const result = await getCalendarEvents({
      startDate: format(start, "yyyy-MM-dd"),
      endDate: format(end, "yyyy-MM-dd"),
    })
    if (result.success) setCalendarEvents(result.events)
  }

  async function loadRegistry() {
    const result = await getCampaignRegistry({ limit: 50 })
    if (result.success) setRegistryItems(result.items)
  }

  async function loadQrCodes() {
    const result = await listAvailableQrCodes()
    if (result.success) setAvailableQrCodes(result.qrCodes)
  }

  // ─── EMAIL CAMPAIGNS (email_campaigns) ──────────────────────────────────────
  // Both reads go through the brokerage-scoped server actions, and both report
  // the SERVER's verdict rather than rendering an empty list on refusal.
  async function loadEmailCampaigns() {
    setEmailCampaignsError(null)
    const { getEmailCampaigns, getEmailCampaignStats } = await import("@/app/actions/email-campaigns")
    const [listRes, statsRes] = await Promise.all([getEmailCampaigns(), getEmailCampaignStats()])
    if (listRes.success) {
      setEmailCampaigns((listRes as any).campaigns ?? [])
    } else {
      setEmailCampaigns([])
      setEmailCampaignsError((listRes as any).error ?? "Could not load email campaigns")
    }
    if (statsRes.success) {
      setEmailStats((statsRes as any).stats ?? null)
    } else {
      setEmailStats(null)
      setEmailCampaignsError(
        (prev) => prev ?? ((statsRes as any).error ?? "Could not load email campaign stats")
      )
    }
  }

  async function openEmailCampaignEditor(campaignId: string) {
    setIsLoadingEmailCampaign(true)
    setEmailEditorError(null)
    try {
      const { getEmailCampaign } = await import("@/app/actions/email-campaigns")
      const res = await getEmailCampaign(campaignId)
      if (!res.success) {
        toast({
          title: "Could not open campaign",
          description: (res as any).error ?? "Unknown error",
          variant: "destructive",
        })
        return
      }
      const campaign = (res as any).campaign
      setEditingEmailCampaign(campaign)
      setEmailEditorDraft({
        campaignName: campaign.campaign_name ?? "",
        subjectLine: campaign.subject_line ?? "",
        previewText: campaign.preview_text ?? "",
        content: campaign.content ?? "",
      })
      setAiComposeTopic(campaign.campaign_name ?? "")
    } finally {
      setIsLoadingEmailCampaign(false)
    }
  }

  // SCHEDULE / DELETE for email_campaigns.
  //
  // These two actions existed and were correct, but their only caller was the
  // NEWSLETTER list, which passed a `newsletter_campaigns` id into actions that
  // query `email_campaigns` — so both answered "Campaign not found" on every
  // click. The newsletter list now calls the newsletter lane, which left these
  // reachable from nowhere. This is the surface they were written for: the list
  // right here already renders email_campaigns rows.
  //
  // This does NOT breach surface/studio-does-not-send. That rule keeps EGRESS
  // off this screen — no sendEmailCampaign, no dispatchEmail, no sendCampaignNow.
  // Scheduling performs no send: it writes status='scheduled' + send_date, and
  // the send-email-campaigns cron does the delivery through the consent-gated
  // dispatcher. Scheduling IS the consent-gated path. Deleting sends nothing.
  async function scheduleEmailCampaignRow(campaignId: string) {
    const when = emailScheduleDrafts[campaignId]
    if (!when) {
      toast({ title: "Pick a send date and time first", variant: "destructive" })
      return
    }
    setSchedulingEmailCampaignId(campaignId)
    try {
      const { scheduleEmailCampaign } = await import("@/app/actions/email-campaigns")
      // Second argument is ignored server-side (identity comes from the session).
      const res = await scheduleEmailCampaign(campaignId, "", new Date(when).toISOString())
      if (!res.success) {
        // The server's refusal, verbatim — never an optimistic "Scheduled!".
        toast({
          title: "Could not schedule campaign",
          description: (res as any).error ?? "Unknown error",
          variant: "destructive",
        })
        return
      }
      setEmailScheduleDrafts((prev) => {
        const next = { ...prev }
        delete next[campaignId]
        return next
      })
      toast({ title: "Campaign scheduled — the send cron will deliver it" })
      await loadEmailCampaigns()
    } finally {
      setSchedulingEmailCampaignId(null)
    }
  }

  async function deleteEmailCampaignRow(campaignId: string) {
    setDeletingEmailCampaignId(campaignId)
    try {
      const { deleteEmailCampaign } = await import("@/app/actions/email-campaigns")
      const res = await deleteEmailCampaign(campaignId)
      if (!res.success) {
        toast({
          title: "Could not delete campaign",
          description: (res as any).error ?? "Unknown error",
          variant: "destructive",
        })
        return
      }
      toast({ title: "Campaign deleted" })
      await loadEmailCampaigns()
    } finally {
      setDeletingEmailCampaignId(null)
    }
  }

  async function saveEmailCampaign() {
    if (!editingEmailCampaign) return
    setIsSavingEmailCampaign(true)
    setEmailEditorError(null)
    try {
      const { updateEmailCampaign } = await import("@/app/actions/email-campaigns")
      // The second argument is ignored server-side (identity comes from the
      // session) — it is kept only for the existing signature.
      const res = await updateEmailCampaign(editingEmailCampaign.id, "", {
        campaignName: emailEditorDraft.campaignName.trim(),
        subjectLine: emailEditorDraft.subjectLine.trim(),
        previewText: emailEditorDraft.previewText.trim(),
        content: emailEditorDraft.content,
      })
      if (!res.success) {
        // Report the SERVER's refusal — never an optimistic "Saved!".
        setEmailEditorError((res as any).error ?? "Save was refused")
        return
      }
      setEditingEmailCampaign(null)
      toast({ title: "Campaign saved" })
      await loadEmailCampaigns()
    } finally {
      setIsSavingEmailCampaign(false)
    }
  }

  async function composeEmailWithAI() {
    if (!aiComposeTopic.trim()) return
    setIsComposingEmail(true)
    setEmailEditorError(null)
    try {
      const { aiComposeEmail } = await import("@/app/actions/email-campaigns")
      const res = await aiComposeEmail({
        brokerageId: brokerageIdProp || brokerageId,
        agentId: agentId || undefined,
        topic: aiComposeTopic.trim(),
        audience: aiComposeAudience,
        campaignId: editingEmailCampaign?.id,
      })
      if (!res.success) {
        setEmailEditorError((res as any).error ?? "AI compose failed")
        return
      }
      // Draft only — nothing is persisted or sent until the agent saves.
      setEmailEditorDraft((prev) => ({
        ...prev,
        subjectLine: (res as any).subject ?? prev.subjectLine,
        previewText: (res as any).preheader ?? prev.previewText,
        content: (res as any).body ?? prev.content,
      }))
    } finally {
      setIsComposingEmail(false)
    }
  }

  // ─── BULK READINESS SWEEP ───────────────────────────────────────────────────
  async function sweepAssetReadiness() {
    const candidates = assets
      .filter((a) => (a.preview_text ?? "").trim().length > 0)
      .slice(0, 25)
    if (candidates.length === 0) {
      setReadinessSweepError("No assets with preview text to evaluate.")
      setReadinessSweep(null)
      return
    }
    setIsSweepingReadiness(true)
    setReadinessSweepError(null)
    setReadinessSweep(null)
    try {
      const { runBatchReadinessCheck } = await import("./components/ad-os/ad-os-actions")
      const res = await runBatchReadinessCheck(
        candidates.map((a) => ({
          contentId: a.id,
          contentText: a.preview_text as string,
          contentType: a.asset_type,
          platform: "email",
        }))
      )
      if (!res.success) {
        setReadinessSweepError(res.error ?? "Readiness sweep failed")
        return
      }
      setReadinessSweep({
        results: res.results ?? [],
        loggedCount: res.loggedCount ?? 0,
        logError: res.logError ?? null,
      })
    } finally {
      setIsSweepingReadiness(false)
    }
  }

  // ─── AI NEWSLETTER ──────────────────────────────────────────────────────────
  async function generateSubjectVariants() {
    if (!aiNewsletter.topic.trim() || !agentId) return
    setIsGeneratingVariants(true)
    setAiNewsletterError(null)
    setSubjectVariants(null)
    try {
      const { generateNewsletterSubjectVariants } = await import(
        "@/app/actions/ai-marketing-automation"
      )
      const res = await generateNewsletterSubjectVariants(
        agentId,
        aiNewsletter.topic.trim(),
        aiNewsletter.audienceSegment
      )
      if (!res.success) setAiNewsletterError(res.error ?? "Could not generate subject variants")
      else setSubjectVariants(res.variants ?? [])
    } finally {
      setIsGeneratingVariants(false)
    }
  }

  async function generateNewsletterWithAI() {
    if (!agentId) {
      setAiNewsletterError("No agent profile resolved for your account.")
      return
    }
    setIsGeneratingNewsletter(true)
    setAiNewsletterError(null)
    try {
      const { generateAINewsletter } = await import("@/app/actions/ai-marketing-automation")
      const res = await generateAINewsletter({
        agentId,
        audienceSegment: aiNewsletter.audienceSegment,
        topic: aiNewsletter.topic.trim() || undefined,
        tone: aiNewsletter.tone,
        includeMarketData: aiNewsletter.includeMarketData,
        includeListings: aiNewsletter.includeListings,
      })
      if (!res.success) {
        // The server's refusal, verbatim — no optimistic success.
        setAiNewsletterError(res.error ?? "Newsletter generation failed")
        return
      }
      setIsAiNewsletterOpen(false)
      setSubjectVariants(null)
      toast({
        title: "AI newsletter drafted",
        description: res.newsletter?.subject ?? "Saved as a draft campaign",
      })
      // Re-read so the new draft appears in the list it was written to.
      await loadNewsletterData()
    } finally {
      setIsGeneratingNewsletter(false)
    }
  }

  async function loadNewsletterData() {
    setIsNewsletterLoading(true)
    setNewsletterError(null)
    try {
      await loadEmailCampaigns()
      // Use server-resolved props first; fall back to action
      let resolvedBrokerageId = brokerageIdProp
      let resolvedUserId = userIdProp
      if (!resolvedBrokerageId || !resolvedUserId) {
        const userContext = await getUserContextForPrediction()
        if (!userContext.success || !userContext.brokerageId || !userContext.userId) {
          setNewsletterCampaigns([])
          setScheduledSends([])
          setSubscriberCount(0)
          setNewsletterTemplates([])
          setLocalContent([])
          return
        }
        resolvedBrokerageId = userContext.brokerageId
        resolvedUserId = userContext.userId
      }
      const { brokerageId, userId } = { brokerageId: resolvedBrokerageId, userId: resolvedUserId }

      const supabase = (await import("@/lib/supabase/client")).createClient()
      
      // Get newsletter campaigns. `const { data } = ...` alone turns a REFUSED
      // read into an empty list — destructure error and surface it.
      const { data: campaigns, error: campaignsError } = await supabase
        .from("newsletter_campaigns")
        .select("*")
        .eq("brokerage_id", brokerageId)
        .order("created_at", { ascending: false })
        .limit(10)
      if (campaignsError) setNewsletterError(campaignsError.message)
      setNewsletterCampaigns(campaigns || [])

      // Get scheduled sends. agent_id here is agents-class — agentIdProp is
      // already server-resolved; without it, resolve rather than reach for the
      // users id sitting in the same scope. No agents row ⇒ no sends are yours.
      const sendsAgentId = agentIdProp || agentId || (await resolveAgentIdInBrokerage(supabase, userId, brokerageId))
      if (!sendsAgentId) {
        setScheduledSends([])
      } else {
        const { data: sends, error: sendsError } = await supabase
          .from("newsletter_scheduled_sends")
          .select("*, newsletter:newsletter_campaigns(campaign_name)")
          .eq("agent_id", sendsAgentId)
          .order("sent_time", { ascending: false })
          .limit(10)
        if (sendsError) console.error("[v0] Failed to load scheduled sends:", sendsError.message)
        setScheduledSends(sends || [])
      }

      // Get subscriber count
      const { count, error: countError } = await supabase
        .from("newsletter_subscribers")
        .select("*", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("status", "subscribed")
      if (countError) setNewsletterError((prev) => prev ?? countError.message)
      setSubscriberCount(count || 0)

      // Get templates. A refusal here used to render the "No newsletter
      // templates yet" empty state — an error disguised as an onboarding hint.
      const { data: templates, error: templatesError } = await supabase
        .from("newsletter_brokers_templates")
        .select("*")
        .eq("brokerage_id", brokerageId)
        .limit(5)
      if (templatesError) setNewsletterError((prev) => prev ?? templatesError.message)
      setNewsletterTemplates(templates || [])

      // Get local content
      const { data: content, error: contentError } = await supabase
        .from("newsletter_local_content")
        .select("*")
        .eq("brokerage_id", brokerageId)
        .order("created_at", { ascending: false })
        .limit(5)
      if (contentError) setNewsletterError((prev) => prev ?? contentError.message)
      setLocalContent(content || [])
    } catch (error) {
      console.error("[v0] Failed to load newsletter data:", error)
    } finally {
      setIsNewsletterLoading(false)
    }
  }

  async function loadBlogData() {
    setIsBlogLoading(true)
    try {
      const resolvedBrokerageId = brokerageIdProp || brokerageId
      if (!resolvedBrokerageId) return
      const { createClient } = await import("@/lib/supabase/client")
      const supabase = createClient()
      const { data } = await supabase
        .from("blog_posts")
        .select("id, title, publish_status, seo_score, created_at, published_at")
        .eq("brokerage_id", resolvedBrokerageId)
        .order("created_at", { ascending: false })
        .limit(20)
      setBlogPosts(data || [])
    } catch (e) {
      console.error("[v0] loadBlogData error:", e)
    } finally {
      setIsBlogLoading(false)
    }
  }

  async function loadPodcastData() {
    setIsPodcastLoading(true)
    try {
      const resolvedBrokerageId = brokerageIdProp || brokerageId
      if (!resolvedBrokerageId) return
      const { createClient } = await import("@/lib/supabase/client")
      const supabase = createClient()
      const { data } = await supabase
        .from("podcast_episodes")
        .select("id, title, status, category, duration_seconds, published_at, created_at")
        .eq("brokerage_id", resolvedBrokerageId)
        .order("created_at", { ascending: false })
        .limit(20)
      setPodcastEpisodes(data || [])
    } catch (e) {
      console.error("[v0] loadPodcastData error:", e)
    } finally {
      setIsPodcastLoading(false)
    }
  }

  async function loadMailData() {
    setIsMailLoading(true)
    try {
      const resolvedBrokerageId = brokerageIdProp || brokerageId
      if (!resolvedBrokerageId) return
      const result = await getMailCampaigns(resolvedBrokerageId)
      if (result.success) setMailCampaigns(result.campaigns || [])
    } catch (e) {
      console.error("[v0] loadMailData error:", e)
    } finally {
      setIsMailLoading(false)
    }
  }

  async function loadAdOsData() {
    try {
      // Use server-resolved props first; fall back to action
      let resolvedBrokerageId = brokerageIdProp
      let resolvedUserId = userIdProp
      if (!resolvedBrokerageId || !resolvedUserId) {
        const userContext = await getUserContextForPrediction()
        if (userContext.success && userContext.userId && userContext.brokerageId) {
          resolvedBrokerageId = userContext.brokerageId
          resolvedUserId = userContext.userId
        }
      }
      if (resolvedUserId && resolvedBrokerageId) {
        // agentId is agents-class and comes from the server prop. It is NOT
        // recoverable from a users id on the client, so this no longer
        // overwrites it with resolvedUserId (which it did, unconditionally,
        // undoing the correct value on every Ad-OS load).
        if (agentIdProp) setAgentId(agentIdProp)
        setBrokerageId(resolvedBrokerageId)

        // Load agent's active listings
        const supabase = (await import("@/lib/supabase/client")).createClient()
        const { data: listingsData } = await supabase
          .from("listings")
          .select("id, address, city, zip, list_price")
          .eq("brokerage_id", resolvedBrokerageId)
          .in("status", ["active", "pending", "coming_soon"])
          .order("created_at", { ascending: false })
          .limit(50)

        setListings(listingsData || [])
      }
    } catch (error) {
      console.error("[v0] Failed to load Ad OS data:", error)
    }
  }

  // ─── HANDLERS ─────────────────────────────────────────────────────────────────

  async function handleCreateCampaign() {
    try {
      const result = await createCampaign(newCampaign)
      if (result.success) {
        setIsCreateCampaignOpen(false)
        setNewCampaign({
          campaignName: "",
          campaignType: "brand",
          budgetTotal: 0,
          scheduledStartAt: "",
          scheduledEndAt: "",
          visibilityScope: "agent",
        })
        loadCampaigns()
        loadInitialData()
      } else {
        toast({ title: "Failed to create campaign", description: (result as any).error ?? "Unknown error", variant: "destructive" })
      }
    } catch (err) {
      toast({ title: "Failed to create campaign", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    }
  }

  async function handleCampaignStatusChange(campaignId: string, status: CampaignStatus) {
    const result = await transitionCampaignStatus(campaignId, status)
    if (result.success) {
      loadCampaigns()
      loadInitialData()
    }
  }

  async function handleSaveCampaignEdits() {
    if (!editingCampaign) return
    if (!editCampaign.campaignName.trim()) {
      toast({ title: "Campaign name is required", variant: "destructive" })
      return
    }
    const budget = editCampaign.budgetTotal.trim()
    if (budget !== "" && !(Number(budget) >= 0)) {
      toast({ title: "Budget must be a number", variant: "destructive" })
      return
    }
    if (
      editCampaign.scheduledStartAt &&
      editCampaign.scheduledEndAt &&
      editCampaign.scheduledEndAt < editCampaign.scheduledStartAt
    ) {
      toast({ title: "End date cannot be before the start date", variant: "destructive" })
      return
    }
    setIsSavingCampaign(true)
    const result = await updateCampaign({
      campaignId: editingCampaign.id,
      campaignName: editCampaign.campaignName.trim(),
      ...(budget !== "" ? { budgetTotal: Number(budget) } : {}),
      scheduledStartAt: editCampaign.scheduledStartAt,
      scheduledEndAt: editCampaign.scheduledEndAt,
    })
    setIsSavingCampaign(false)
    if (result.success) {
      setEditingCampaign(null)
      loadCampaigns()
      loadInitialData()
      toast({ title: "Campaign updated" })
    } else {
      toast({
        title: "Could not update the campaign",
        description: (result as any).error ?? "Unknown error",
        variant: "destructive",
      })
    }
  }

  async function handleWriteAssetCopy() {
    if (!newAsset.campaignId) {
      toast({
        title: "Pick a campaign first",
        description: "The copy is written from the campaign's name, type and listing — there is nothing to ground it in otherwise.",
        variant: "destructive",
      })
      return
    }
    setIsWritingAsset(true)
    setAssetBrandVoice(null)
    try {
      // Asset type → the copy shape the generator writes. Anything not on this
      // map is prose for a social-style asset.
      const contentType: "social_caption" | "email_subject" | "email_body" | "ad_copy" =
        newAsset.assetType === "ad_creative"
          ? "ad_copy"
          : newAsset.assetType === "newsletter"
            ? "email_body"
            : "social_caption"
      const result = await generateCampaignContent({
        campaignId: newAsset.campaignId,
        contentType,
        prompt:
          assetCopyPrompt.trim() ||
          `Write the ${newAsset.assetType.replace(/_/g, " ")} copy for "${newAsset.assetName || "this asset"}".`,
      })
      if (!result.success || !result.content) {
        toast({
          title: "Could not write the copy",
          description: (result as any).error ?? "The AI writer returned nothing.",
          variant: "destructive",
        })
        return
      }
      setNewAsset((prev) => ({ ...prev, previewText: result.content as string }))
      // Brand-voice findings are SHOWN. A violation the writer flagged and the
      // screen swallowed is the same as no check at all.
      if (result.brandVoiceViolations?.length || result.brandVoiceNotes?.length) {
        setAssetBrandVoice({
          violations: result.brandVoiceViolations ?? [],
          notes: result.brandVoiceNotes ?? [],
        })
      }
    } catch (err) {
      toast({
        title: "Could not write the copy",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      })
    } finally {
      setIsWritingAsset(false)
    }
  }

  async function handleCreateAsset() {
    try {
      // The QR preview image is rendered SERVER-SIDE by the vendored `qrcode` package and stored
      // as a data: URI. It used to be an api.qrserver.com URL persisted onto the asset row, which
      // shipped the (often lead-bearing) target URL to a third party and left every saved asset
      // permanently dependent on an outside host to render its own artwork.
      let qrUrl: string | undefined
      if (newAsset.assetType === "qr" && newAsset.qrTargetUrl.trim()) {
        const { renderQrImageAction } = await import("@/app/actions/marketing-studio")
        const rendered = await renderQrImageAction(newAsset.qrTargetUrl.trim())
        if (!rendered.success) {
          toast({ title: "Failed to create asset", description: rendered.error, variant: "destructive" })
          return
        }
        qrUrl = rendered.dataUrl
      }
      const result = await createAsset({
        ...newAsset,
        assetType: newAsset.assetType as any,
        campaignId: newAsset.campaignId || undefined,
        assetUrl: qrUrl,
      })
      if (result.success) {
        setIsCreateAssetOpen(false)
        setNewAsset({ assetName: "", assetType: "graphic", campaignId: "", previewText: "", qrTargetUrl: "" })
        loadAssets()
        loadInitialData()
      } else {
        toast({ title: "Failed to create asset", description: (result as any).error ?? "Unknown error", variant: "destructive" })
      }
    } catch (err) {
      toast({ title: "Failed to create asset", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    }
  }

  async function handleApproveAsset(assetId: string) {
    const result = await approveAsset(assetId)
    if (result.success) {
      loadAssets()
      loadInitialData()
    }
  }

  async function handleRejectAsset(assetId: string) {
    const result = await rejectAsset(assetId, "Does not meet brand guidelines")
    if (result.success) {
      loadAssets()
      loadInitialData()
    }
  }

  async function handleCreateCalendarEvent() {
    try {
      const result = await createCalendarEvent({
        ...newEvent,
        campaignId: newEvent.campaignId || undefined,
      })
      if (result.success) {
        setIsCreateEventOpen(false)
        setNewEvent({ title: "", eventType: "publish", scheduledAt: "", campaignId: "", notes: "" })
        loadCalendarEvents()
      } else {
        toast({ title: "Failed to create calendar event", description: (result as any).error ?? "Unknown error", variant: "destructive" })
      }
    } catch (err) {
      toast({ title: "Failed to create calendar event", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    }
  }

  async function handleRegisterSource(item: ContentSourceItem, campaignId: string) {
    const result = await registerCampaignSource({
      campaignId,
      sourceTable: item.sourceTable,
      sourceId: item.id,
      assetName: item.title,
    })
    if (result.success) {
      setIsRegistryOpen(false)
      loadAssets()
    }
  }

  /**
   * The eye control on a campaign card. The card only carries the counts it was
   * listed with; the full record (assets, tasks, comments, listing) comes from
   * getCampaignById, which is brokerage-scoped server side.
   */
  async function handleViewCampaign(campaign: Campaign) {
    setSelectedCampaign(campaign)
    setCampaignDetail(null)
    setCampaignDetailError(null)
    setIsCampaignDetailOpen(true)
    setIsLoadingCampaignDetail(true)
    try {
      const result = await getCampaignById(campaign.id)
      if (!result.success) {
        setCampaignDetailError((result as any).error ?? "This campaign could not be loaded.")
        return
      }
      if (!result.campaign) {
        setCampaignDetailError("This campaign is no longer available on your brokerage.")
        return
      }
      setCampaignDetail(result.campaign)
    } catch (err) {
      setCampaignDetailError(err instanceof Error ? err.message : "This campaign could not be loaded.")
    } finally {
      setIsLoadingCampaignDetail(false)
    }
  }

  /**
   * Re-read the open campaign after a collaboration write.
   *
   * Through `getCampaignById` — the SAME brokerage-scoped reader that opened the
   * dialog — rather than through `getCampaignComments` / `getCampaignTasks`.
   * Those two were also imported-and-unused here, and they are a second read of
   * rows this bundle already carries; using them would have given the dialog two
   * sources for one list, which is how two lists come to disagree.
   */
  async function refreshOpenCampaignDetail(campaignId: string) {
    try {
      const result = await getCampaignById(campaignId)
      if (result.success && result.campaign) setCampaignDetail(result.campaign)
    } catch {
      // A failed refresh must not look like a failed WRITE — the write already
      // returned success. Leave the stale list; the next open re-reads it.
    }
  }

  async function handleAddCampaignComment() {
    const campaignId = campaignDetail?.id ?? selectedCampaign?.id
    const body = newCommentBody.trim()
    if (!campaignId || !body) return
    setIsPostingComment(true)
    setCollabError(null)
    try {
      const result = await addCampaignComment({ campaignId, commentBody: body })
      if (!result.success) {
        setCollabError((result as any).error ?? "The comment could not be posted.")
        return
      }
      setNewCommentBody("")
      await refreshOpenCampaignDetail(campaignId)
    } catch (err) {
      setCollabError(err instanceof Error ? err.message : "The comment could not be posted.")
    } finally {
      setIsPostingComment(false)
    }
  }

  async function handleCreateCampaignTask() {
    const campaignId = campaignDetail?.id ?? selectedCampaign?.id
    const title = newTaskTitle.trim()
    if (!campaignId || !title) return
    setIsCreatingTask(true)
    setCollabError(null)
    try {
      const result = await createCampaignTask({
        campaignId,
        title,
        // The input is a date-only control; the column is timestamptz. An empty
        // box means "no due date", which the writer stores as NULL — never as
        // an invented one.
        dueAt: newTaskDueAt ? new Date(`${newTaskDueAt}T12:00:00`).toISOString() : undefined,
      })
      if (!result.success) {
        setCollabError((result as any).error ?? "The task could not be created.")
        return
      }
      setNewTaskTitle("")
      setNewTaskDueAt("")
      setIsTaskComposerOpen(false)
      await refreshOpenCampaignDetail(campaignId)
    } catch (err) {
      setCollabError(err instanceof Error ? err.message : "The task could not be created.")
    } finally {
      setIsCreatingTask(false)
    }
  }

  async function handleLinkQr(assetId: string, qrCodeId: string, placementType: string) {
    setQrLinkError(null)
    const result = await linkQrToAsset({
      marketingAssetId: assetId,
      qrCodeId,
      placementType: placementType as any,
    })
    // A refusal used to fall out of this `if` and vanish: the dialog stayed
    // open, the list did not change, and nothing said the link had not been
    // made. Report what the action reported.
    if (!result.success) {
      setQrLinkError((result as any).error ?? "The QR code was not linked to this asset.")
      return
    }
    await loadAssetQrLinks(assetId)
    loadAssets()
  }

  /** Show what is ALREADY attached to this asset — the missing half of the link flow. */
  async function loadAssetQrLinks(assetId: string) {
    setIsLoadingQrLinks(true)
    try {
      const result = await getAssetQrLinks(assetId)
      if (!result.success) {
        setQrLinkError(result.error ?? "The linked QR codes could not be loaded.")
        setAssetQrLinks([])
        return
      }
      setAssetQrLinks(result.links)
    } finally {
      setIsLoadingQrLinks(false)
    }
  }

  async function handleUnlinkQr(linkId: string, assetId: string) {
    setQrLinkError(null)
    const result = await unlinkQrFromAsset(linkId)
    if (!result.success) {
      setQrLinkError(result.error ?? "The QR code was not unlinked from this asset.")
      return
    }
    await loadAssetQrLinks(assetId)
    loadAssets()
  }

  async function handleLoadQrPerformance(qrCodeId: string) {
    setLoadingQrPerformanceId(qrCodeId)
    try {
      const result = await getQrCodePerformance(qrCodeId)
      setQrPerformance((prev) => ({
        ...prev,
        [qrCodeId]: result.success
          ? result.performance
          : { error: result.error ?? "Scan detail could not be loaded." },
      }))
    } finally {
      setLoadingQrPerformanceId(null)
    }
  }

  async function handlePredictPerformance(asset: Asset) {
    setSelectedAssetForPrediction(asset)
    setIsPredictionDialogOpen(true)
    setIsPredicting(true)
    setCurrentPrediction(null)

    let resolvedBrokerageId = brokerageIdProp
    let resolvedUserId = userIdProp
    if (!resolvedBrokerageId || !resolvedUserId) {
      const userContext = await getUserContextForPrediction()
      if (!userContext.success || !userContext.userId || !userContext.brokerageId) {
        setIsPredicting(false)
        return
      }
      resolvedBrokerageId = userContext.brokerageId
      resolvedUserId = userContext.userId
    }

    // Map asset_type to content_type
    const contentTypeMap: Record<string, string> = {
      social_post: "social_post",
      snippet: "social_post",
      script: "social_post",
      newsletter: "newsletter",
      mailer: "newsletter",
      blog: "blog_post",
      video: "ad_creative",
      graphic: "ad_creative",
      template: "ad_creative",
      ad_creative: "ad_creative",
      podcast: "ad_creative",
      qr: "ad_creative",
    }

    const result = await predictPerformanceAction({
      brokerageId: resolvedBrokerageId,
      userId: resolvedUserId,
      contentType: (contentTypeMap[asset.asset_type] || "ad_creative") as any,
      sourceTable: "marketing_assets",
      sourceId: asset.id,
      contentText: asset.preview_text || asset.asset_name,
    })

    if (result.success && result.prediction) {
      setCurrentPrediction(result.prediction)
    }
    setIsPredicting(false)
  }

  // ─── OMNICHANNEL HANDLER ─────────────────────────────────────────────────────

  function addOmnichannelStep() {
    const newStep: OmnichannelStep = {
      id: Math.random().toString(36).slice(2),
      type: "email",
      name: "",
      delay_days: 0,
      delay_hours: 0,
      subject: "",
      body: "",
    }
    setOmnichannelSteps((prev) => [...prev, newStep])
  }

  function updateOmnichannelStep(id: string, patch: Partial<OmnichannelStep>) {
    setOmnichannelSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function removeOmnichannelStep(id: string) {
    setOmnichannelSteps((prev) => prev.filter((s) => s.id !== id))
  }

  async function handleCreateOmnichannelSequence() {
    if (!omnichannelName.trim()) {
      toast({ title: "Sequence name required", variant: "destructive" })
      return
    }
    setIsCreatingOmnichannel(true)
    setOmnichannelSuccess(null)
    try {
      const resolvedBrokerageId = brokerageIdProp || brokerageId
      if (!resolvedBrokerageId) {
        toast({ title: "Brokerage context missing", variant: "destructive" })
        return
      }
      const { sequence, error: seqError } = await createCampaignSequence({
        brokerageId: resolvedBrokerageId,
        name: omnichannelName.trim(),
        description: omnichannelDescription.trim() || undefined,
        sequence_type: "omnichannel",
      })
      if (!sequence || seqError) {
        toast({ title: "Failed to create sequence", description: seqError, variant: "destructive" })
        return
      }
      const stepErrors: string[] = []
      for (let i = 0; i < omnichannelSteps.length; i++) {
        const step = omnichannelSteps[i]
        const stepResult = await createSequenceStep({
          sequence_id: sequence.id,
          step_number: i + 1,
          step_name: step.name || `Step ${i + 1}`,
          channel: step.type,
          delay_days: step.delay_days,
          delay_hours: step.delay_hours,
          subject: step.type === "email" ? step.subject : undefined,
          body: step.body || undefined,
        })
        if (stepResult.error || !stepResult.step) {
          stepErrors.push(`Step ${i + 1}: ${stepResult?.error ?? "Unknown error"}`)
        }
      }
      if (stepErrors.length > 0) {
        // Roll back the partially-created sequence to avoid orphaned records
        const rollback = await deleteCampaignSequence(sequence.id).catch((e) => ({ error: String(e) }))
        const rollbackFailed = rollback && "error" in rollback
        toast({
          title: rollbackFailed
            ? "Failed to create sequence steps — sequence may be partially saved"
            : "Failed to create sequence steps — sequence rolled back",
          description: stepErrors.join("; "),
          variant: "destructive",
        })
        return
      }
      setOmnichannelName("")
      setOmnichannelDescription("")
      setOmnichannelSteps([])
      setOmnichannelSuccess(`Sequence "${sequence.name}" created with ${omnichannelSteps.length} step${omnichannelSteps.length !== 1 ? "s" : ""}.`)
    } catch (err) {
      toast({ title: "Error creating sequence", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    } finally {
      setIsCreatingOmnichannel(false)
    }
  }

  // ─── STATUS HELPERS ───────────────────────────────────────────────────────────

  function getStatusColor(status: string) {
    const colors: Record<string, string> = {
      draft: "bg-gray-100 text-gray-700",
      pending_approval: "bg-yellow-100 text-yellow-700",
      approved: "bg-blue-100 text-blue-700",
      live: "bg-green-100 text-green-700",
      paused: "bg-orange-100 text-orange-700",
      ended: "bg-gray-100 text-gray-600",
      pending: "bg-yellow-100 text-yellow-700",
      rejected: "bg-red-100 text-red-700",
    }
    return colors[status] || "bg-gray-100 text-gray-700"
  }

  function getStatusIcon(status: string) {
    const icons: Record<string, React.ReactNode> = {
      draft: <Edit className="h-3 w-3" />,
      pending_approval: <Clock className="h-3 w-3" />,
      approved: <CheckCircle className="h-3 w-3" />,
      live: <Play className="h-3 w-3" />,
      paused: <Pause className="h-3 w-3" />,
      ended: <CheckCircle className="h-3 w-3" />,
      pending: <Clock className="h-3 w-3" />,
      rejected: <AlertCircle className="h-3 w-3" />,
    }
    return icons[status] || null
  }

  // ─── RENDER ───────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-16 w-16 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground text-lg">Loading Marketing Studio...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="p-6 lg:p-8 max-w-[1600px] mx-auto space-y-6">
        {/* Banner — surfaces a fresh email campaign staged via voice/Copilot
            stage_email_campaign tool. Reads `?email_draft=<uuid>`. */}
        <StagedDraftBanner
          paramKey="email_draft"
          label="Email campaign draft"
          hint="Find your new draft in the Campaigns tab — refine the body, run brand-voice + compliance checks, then send."
        />
        {/* Header */}
        <Card className="border-2 shadow-lg bg-gradient-to-r from-violet-50 to-fuchsia-50 dark:from-violet-950/20 dark:to-fuchsia-950/20">
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4">
                <div className="rounded-2xl bg-violet-600 p-3">
                  <Megaphone className="h-8 w-8 text-white" />
                </div>
                <div>
                  <h1 className="text-3xl lg:text-4xl font-bold text-foreground">Marketing Studio</h1>
                  <p className="text-muted-foreground">
                    Unified command center for campaigns, assets, and content scheduling
                  </p>
                  {cadence && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {describeCadence("Newsletter", cadence.newsletter)} ·{" "}
                      {describeCadence("Social", cadence.social)}{" "}
                      <a href="/settings/blog-cadence" className="text-violet-700 hover:underline">
                        Change
                      </a>
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Dialog open={isCreateCampaignOpen} onOpenChange={setIsCreateCampaignOpen}>
                  <DialogTrigger asChild>
                    <Button className="bg-violet-600 hover:bg-violet-700">
                      <Plus className="mr-2 h-4 w-4" />
                      New Campaign
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[500px]">
                    <DialogHeader>
                      <DialogTitle>Create New Campaign</DialogTitle>
                      <DialogDescription>Set up a new marketing campaign</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Campaign Name</Label>
                        <Input
                          value={newCampaign.campaignName}
                          onChange={(e) => setNewCampaign({ ...newCampaign, campaignName: e.target.value })}
                          placeholder="Spring Listing Campaign"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Campaign Type</Label>
                        <Select
                          value={newCampaign.campaignType}
                          onValueChange={(v) => setNewCampaign({ ...newCampaign, campaignType: v as any })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="listing">Listing</SelectItem>
                            <SelectItem value="brand">Brand</SelectItem>
                            <SelectItem value="recruitment">Recruitment</SelectItem>
                            <SelectItem value="event">Event</SelectItem>
                            <SelectItem value="seasonal">Seasonal</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Budget</Label>
                          <Input
                            type="number"
                            value={newCampaign.budgetTotal}
                            onChange={(e) => setNewCampaign({ ...newCampaign, budgetTotal: Number(e.target.value) })}
                            placeholder="0"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Visibility</Label>
                          <Select
                            value={newCampaign.visibilityScope}
                            onValueChange={(v) => setNewCampaign({ ...newCampaign, visibilityScope: v as VisibilityScope })}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="agent">Just Me</SelectItem>
                              <SelectItem value="team">My Team</SelectItem>
                              <SelectItem value="brokerage">Brokerage</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <Button onClick={handleCreateCampaign} className="w-full bg-violet-600 hover:bg-violet-700">
                        Create Campaign
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </CardHeader>
        </Card>

        {/* Quick Stats */}
        {dashboardError && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 dark:bg-yellow-950/20 dark:border-yellow-800 px-4 py-3 flex items-center gap-3 text-sm text-yellow-800 dark:text-yellow-200">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>Dashboard metrics could not be loaded: {dashboardError}. Other Studio features are still available.</span>
          </div>
        )}
        {dashboard && (() => {
          const activeCampaigns = dashboard.campaignsByStatus.live ?? 0
          const pendingApproval = dashboard.assetsByApproval.pending ?? 0
          const totalAssets = dashboard.totalAssets
          const upcomingEventsCount = dashboard.upcomingEvents.length
          const isEmpty = dashboard.totalCampaigns === 0 && totalAssets === 0

          return (
            <>
              {isEmpty && (
                <div className="rounded-xl border-2 border-dashed border-violet-200 dark:border-violet-800 bg-violet-50/50 dark:bg-violet-950/10 p-8 text-center space-y-3">
                  <Rocket className="h-10 w-10 text-violet-400 mx-auto" />
                  <h3 className="font-semibold text-lg text-foreground">Your studio is ready for launch</h3>
                  <p className="text-muted-foreground text-sm max-w-sm mx-auto">
                    Create your first campaign and upload assets to start tracking performance here.
                  </p>
                  <Button
                    className="bg-violet-600 hover:bg-violet-700 mt-2"
                    onClick={() => setIsCreateCampaignOpen(true)}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Create First Campaign
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Active Campaigns</p>
                        <p className="text-2xl font-bold">{activeCampaigns}</p>
                        {dashboard.totalCampaigns > 0 && activeCampaigns === 0 && (
                          <p className="text-xs text-muted-foreground mt-0.5">{dashboard.totalCampaigns} total</p>
                        )}
                      </div>
                      <div className="h-12 w-12 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                        <Play className="h-6 w-6 text-green-600" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Pending Approval</p>
                        <p className="text-2xl font-bold">{pendingApproval}</p>
                      </div>
                      <div className="h-12 w-12 rounded-lg bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center">
                        <Clock className="h-6 w-6 text-yellow-600" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Total Assets</p>
                        <p className="text-2xl font-bold">{totalAssets}</p>
                      </div>
                      <div className="h-12 w-12 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                        <Image className="h-6 w-6 text-blue-600" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Upcoming Events</p>
                        <p className="text-2xl font-bold">{upcomingEventsCount}</p>
                      </div>
                      <div className="h-12 w-12 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                        <CalendarIcon className="h-6 w-6 text-violet-600" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </>
          )
        })()}

        {/* Main Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-4 md:grid-cols-7 lg:grid-cols-7 gap-1 h-auto bg-muted p-2 rounded-xl">
            <TabsTrigger
              value="ad-os"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Rocket className="h-4 w-4" />
              <span className="text-xs">Ad OS</span>
            </TabsTrigger>
            <TabsTrigger
              value="overview"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <LayoutDashboard className="h-4 w-4" />
              <span className="text-xs">Overview</span>
            </TabsTrigger>
            <TabsTrigger
              value="campaigns"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Megaphone className="h-4 w-4" />
              <span className="text-xs">Campaigns</span>
            </TabsTrigger>
            <TabsTrigger
              value="assets"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Image className="h-4 w-4" />
              <span className="text-xs">Assets</span>
            </TabsTrigger>
            <TabsTrigger
              value="calendar"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <CalendarIcon className="h-4 w-4" />
              <span className="text-xs">Calendar</span>
            </TabsTrigger>
            <TabsTrigger
              value="newsletters"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Mail className="h-4 w-4" />
              <span className="text-xs">Newsletters</span>
            </TabsTrigger>
            <TabsTrigger
              value="registry"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Link2 className="h-4 w-4" />
              <span className="text-xs">Registry</span>
            </TabsTrigger>
            <TabsTrigger
              value="qr"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <QrCode className="h-4 w-4" />
              <span className="text-xs">QR Links</span>
            </TabsTrigger>
            <TabsTrigger
              value="mail"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Truck className="h-4 w-4" />
              <span className="text-xs">Direct Mail</span>
            </TabsTrigger>
            <TabsTrigger
              value="blog"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Newspaper className="h-4 w-4" />
              <span className="text-xs">Blog</span>
            </TabsTrigger>
            <TabsTrigger
              value="podcast"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Mic className="h-4 w-4" />
              <span className="text-xs">Podcast</span>
            </TabsTrigger>
            <TabsTrigger
              value="omnichannel"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Sparkles className="h-4 w-4" />
              <span className="text-xs">Omnichannel</span>
            </TabsTrigger>
            <TabsTrigger
              value="ops"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Activity className="h-4 w-4" />
              <span className="text-xs">Ops</span>
            </TabsTrigger>
          </TabsList>

          {/* Ad OS Tab */}
          <TabsContent value="ad-os" className="space-y-6">
            {/* Row 1: Campaign Launcher + Competitor Watch */}
            <div className="grid lg:grid-cols-2 gap-6">
              <CampaignLauncherPanel
                listings={listings}
                agentId={agentId}
                brokerageId={brokerageId}
                onCampaignCreated={() => {
                  loadCampaigns()
                  loadInitialData()
                }}
              />
              <CompetitorWatchPanel listings={listings} agentId={agentId} />
            </div>

            {/* Row 2: Repurpose Engine + Creative Variations */}
            <div className="grid lg:grid-cols-2 gap-6">
              <RepurposeEnginePanel agentId={agentId} />
              <CreativeVariationsPanel agentId={agentId} />
            </div>

            {/* Row 3: Prelaunch Prediction + Performance Intelligence */}
            <div className="grid lg:grid-cols-2 gap-6">
              <PrelaunchPredictionPanel agentId={agentId} />
              <PerformanceIntelligencePanel brokerageId={brokerageId} />
            </div>

            {/* Row 4: Listing Copy Enhancer (read-only rewrite) */}
            <div className="grid lg:grid-cols-2 gap-6">
              <ListingCopyPanel agentId={agentId} listings={listings} />
            </div>

            {/* Row 5: Seller-Safe Marketing Summary (full width) */}
            <SellerSafeMarketingSummary campaigns={campaigns} />
          </TabsContent>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            <div className="grid md:grid-cols-2 gap-6">
              {/* Upcoming Events */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CalendarIcon className="h-5 w-5 text-violet-600" />
                    Upcoming Events
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[300px]">
                    {dashboard?.upcomingEvents.length === 0 ? (
                      <p className="text-muted-foreground text-center py-8">No upcoming events</p>
                    ) : (
                      <div className="space-y-3">
                        {dashboard?.upcomingEvents.map((event) => (
                          <div key={event.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                            <div>
                              <p className="font-medium">{event.title}</p>
                              <p className="text-sm text-muted-foreground">
                                {format(new Date(event.scheduled_at), "MMM d, yyyy 'at' h:mm a")}
                              </p>
                            </div>
                            <Badge variant="outline">{event.event_type}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>

              {/* Pending Tasks */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CheckSquare className="h-5 w-5 text-violet-600" />
                    Pending Tasks
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[300px]">
                    {dashboard?.pendingTasks.length === 0 ? (
                      <p className="text-muted-foreground text-center py-8">No pending tasks</p>
                    ) : (
                      <div className="space-y-3">
                        {dashboard?.pendingTasks.map((task) => (
                          <div key={task.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                            <div>
                              <p className="font-medium">{task.title}</p>
                              {task.due_at && (
                                <p className="text-sm text-muted-foreground">
                                  Due: {format(new Date(task.due_at), "MMM d, yyyy")}
                                </p>
                              )}
                            </div>
                            <Button size="sm" variant="outline" onClick={() => updateTaskStatus(task.id, "completed")}>
                              <CheckCircle className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>

            {/* Recent Campaigns */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Megaphone className="h-5 w-5 text-violet-600" />
                    Recent Campaigns
                  </CardTitle>
                  <Button variant="ghost" size="sm" onClick={() => setActiveTab("campaigns")}>
                    View All <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid md:grid-cols-3 gap-4">
                  {campaigns.slice(0, 3).map((campaign) => (
                    <Card key={campaign.id} className="bg-muted/30">
                      <CardContent className="pt-4">
                        <div className="flex items-start justify-between mb-2">
                          <Badge className={getStatusColor(campaign.status)}>
                            {getStatusIcon(campaign.status)}
                            <span className="ml-1">{campaign.status}</span>
                          </Badge>
                          <Badge variant="outline">{campaign.campaign_type}</Badge>
                        </div>
                        <h4 className="font-semibold mb-1">{campaign.campaign_name}</h4>
                        {campaign.listing && (
                          <p className="text-sm text-muted-foreground">{campaign.listing.address}</p>
                        )}
                        <div className="flex items-center gap-4 mt-3 text-sm text-muted-foreground">
                          <span>{campaign.assets?.[0]?.count ?? 0} assets</span>
                          <span>{campaign.tasks?.[0]?.count ?? 0} tasks</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Campaigns Tab */}
          <TabsContent value="campaigns" className="space-y-4">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search campaigns..."
                  className="pl-10"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[180px]">
                  <Filter className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Filter status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="pending_approval">Pending Approval</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="live">Live</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="ended">Ended</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {campaigns
                .filter((c) => c.campaign_name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map((campaign) => (
                  <Card key={campaign.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-6">
                      <div className="flex items-start justify-between mb-3">
                        <Badge className={getStatusColor(campaign.status)}>
                          {getStatusIcon(campaign.status)}
                          <span className="ml-1 capitalize">{campaign.status.replace("_", " ")}</span>
                        </Badge>
                        <Badge variant="outline" className="capitalize">
                          {campaign.campaign_type}
                        </Badge>
                      </div>
                      <h3 className="font-semibold text-lg mb-1">{campaign.campaign_name}</h3>
                      {campaign.listing && (
                        <p className="text-sm text-muted-foreground mb-3">
                          {campaign.listing.address}, {campaign.listing.city}
                        </p>
                      )}
                      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                        <span className="flex items-center gap-1">
                          <Image className="h-3 w-3" />
                          {campaign.assets?.[0]?.count ?? 0}
                        </span>
                        <span className="flex items-center gap-1">
                          <CheckSquare className="h-3 w-3" />
                          {campaign.tasks?.[0]?.count ?? 0}
                        </span>
                        {campaign.budget_total > 0 && (
                          <span className="flex items-center gap-1">
                            <TrendingUp className="h-3 w-3" />
                            ${campaign.budget_spent ?? 0}/${campaign.budget_total}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {campaign.status === "draft" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleCampaignStatusChange(campaign.id, "pending_approval")}
                          >
                            Submit for Approval
                          </Button>
                        )}
                        {campaign.status === "approved" && (
                          <Button
                            size="sm"
                            className="bg-green-600 hover:bg-green-700"
                            onClick={() => handleCampaignStatusChange(campaign.id, "live")}
                          >
                            <Play className="h-3 w-3 mr-1" />
                            Launch
                          </Button>
                        )}
                        {campaign.status === "live" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleCampaignStatusChange(campaign.id, "paused")}
                          >
                            <Pause className="h-3 w-3 mr-1" />
                            Pause
                          </Button>
                        )}
                        {campaign.status === "paused" && (
                          <Button
                            size="sm"
                            className="bg-green-600 hover:bg-green-700"
                            onClick={() => handleCampaignStatusChange(campaign.id, "live")}
                          >
                            <Play className="h-3 w-3 mr-1" />
                            Resume
                          </Button>
                        )}
                        {/* Had no handler. getCampaignById was imported at the
                            top of this file and called from nowhere, and the
                            selectedCampaign state below it was never set — the
                            join was simply missing. */}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`View ${campaign.campaign_name}`}
                          onClick={() => handleViewCampaign(campaign)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {/* Correcting a plan is not the same as moving it through
                            its lifecycle — a live campaign's own status gate is
                            handled by transitionCampaignStatus, this only edits
                            the fields. */}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Edit ${campaign.campaign_name}`}
                          onClick={() => {
                            setEditingCampaign(campaign)
                            setEditCampaign({
                              campaignName: campaign.campaign_name ?? "",
                              budgetTotal: campaign.budget_total != null ? String(campaign.budget_total) : "",
                              scheduledStartAt: (campaign.scheduled_start_at ?? "").slice(0, 10),
                              scheduledEndAt: (campaign.scheduled_end_at ?? "").slice(0, 10),
                            })
                          }}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
            </div>
          </TabsContent>

          {/* Assets Tab */}
          <TabsContent value="assets" className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4 flex-1">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search assets..."
                    className="pl-10"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[180px]">
                    <Filter className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Filter approval" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                disabled={isSweepingReadiness || assets.length === 0}
                onClick={sweepAssetReadiness}
              >
                {isSweepingReadiness ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckSquare className="mr-2 h-4 w-4" />
                )}
                Check Readiness
              </Button>
              <Dialog open={isCreateAssetOpen} onOpenChange={setIsCreateAssetOpen}>
                <DialogTrigger asChild>
                  <Button className="bg-violet-600 hover:bg-violet-700">
                    <Plus className="mr-2 h-4 w-4" />
                    Add Asset
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add Marketing Asset</DialogTitle>
                    <DialogDescription>Upload or create a new marketing asset</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label>Asset Name</Label>
                      <Input
                        value={newAsset.assetName}
                        onChange={(e) => setNewAsset({ ...newAsset, assetName: e.target.value })}
                        placeholder="Spring Campaign Banner"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Asset Type</Label>
                      <Select
                        value={newAsset.assetType}
                        onValueChange={(v) => setNewAsset({ ...newAsset, assetType: v as any })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="graphic">Graphic</SelectItem>
                          <SelectItem value="video">Video</SelectItem>
                          <SelectItem value="snippet">Snippet</SelectItem>
                          <SelectItem value="script">Script</SelectItem>
                          <SelectItem value="template">Template</SelectItem>
                          <SelectItem value="social_post">Social Post</SelectItem>
                          <SelectItem value="newsletter">Newsletter</SelectItem>
                          <SelectItem value="blog">Blog</SelectItem>
                          <SelectItem value="podcast">Podcast</SelectItem>
                          <SelectItem value="mailer">Direct Mailer</SelectItem>
                          <SelectItem value="ad_creative">Ad Creative</SelectItem>
                          <SelectItem value="qr">QR Code</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Campaign (Optional)</Label>
                      <Select
                        value={newAsset.campaignId || "none"}
                        onValueChange={(v) => setNewAsset({ ...newAsset, campaignId: v === "none" ? "" : v })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select campaign" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No Campaign</SelectItem>
                          {campaigns.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.campaign_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {newAsset.assetType === "qr" ? (
                      <div className="space-y-2">
                        <Label>Target URL (what the QR code points to)</Label>
                        <Input
                          value={newAsset.qrTargetUrl}
                          onChange={(e) => setNewAsset({ ...newAsset, qrTargetUrl: e.target.value })}
                          placeholder="https://example.com/your-page"
                        />
                        <p className="text-xs text-muted-foreground">A scannable QR image will be auto-generated.</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <Label>Preview Text</Label>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={handleWriteAssetCopy}
                            disabled={isWritingAsset || !newAsset.campaignId}
                            title={
                              newAsset.campaignId
                                ? "Write this in your brand voice, grounded in the campaign"
                                : "Pick a campaign — the copy is written from it"
                            }
                          >
                            {isWritingAsset ? (
                              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                            ) : (
                              <Sparkles className="h-3.5 w-3.5 mr-1" />
                            )}
                            Write with AI
                          </Button>
                        </div>
                        <Input
                          value={assetCopyPrompt}
                          onChange={(e) => setAssetCopyPrompt(e.target.value)}
                          placeholder="What should it say? (optional — e.g. 'lead with the price drop')"
                        />
                        <Textarea
                          value={newAsset.previewText}
                          onChange={(e) => setNewAsset({ ...newAsset, previewText: e.target.value })}
                          placeholder="Brief description..."
                          rows={3}
                        />
                        {assetBrandVoice && (
                          <div className="rounded-md border bg-muted/40 p-2 text-xs space-y-1">
                            {assetBrandVoice.violations.length > 0 && (
                              <p className="text-amber-700">
                                Brand voice: {assetBrandVoice.violations.join("; ")}
                              </p>
                            )}
                            {assetBrandVoice.notes.length > 0 && (
                              <p className="text-muted-foreground">{assetBrandVoice.notes.join("; ")}</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <Button onClick={handleCreateAsset} className="w-full bg-violet-600 hover:bg-violet-700">
                      Create Asset
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>

            {readinessSweepError && (
              <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {readinessSweepError}
              </div>
            )}

            {readinessSweep && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <CheckSquare className="h-4 w-4 text-indigo-600" />
                    Readiness sweep — {readinessSweep.results.filter((r) => r.status === "ready").length} of{" "}
                    {readinessSweep.results.length} ready
                  </CardTitle>
                  <CardDescription>
                    {readinessSweep.loggedCount} verdict{readinessSweep.loggedCount === 1 ? "" : "s"} recorded
                    against the assets — feeds the Readiness Pass Rate on the Ops tab.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  {readinessSweep.logError && (
                    <p className="text-xs text-yellow-800 bg-yellow-50 rounded p-2">
                      Not everything was recorded: {readinessSweep.logError}
                    </p>
                  )}
                  {readinessSweep.results
                    .filter((r) => r.status === "blocked")
                    .map((r) => {
                      const asset = assets.find((a) => a.id === r.contentId)
                      return (
                        <div key={r.contentId} className="text-xs rounded border px-2 py-1.5">
                          <span className="font-medium">{asset?.asset_name ?? r.contentId}</span>
                          <span className="text-muted-foreground"> — {r.blockingReasons.join("; ") || "blocked"}</span>
                        </div>
                      )
                    })}
                </CardContent>
              </Card>
            )}

            <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {assets
                .filter((a) => a.asset_name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map((asset) => (
                  <Card key={asset.id} className="overflow-hidden">
                    <div className="aspect-video bg-muted flex items-center justify-center">
                      {asset.thumbnail_url ? (
                        <img
                          src={asset.thumbnail_url}
                          alt={asset.asset_name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="text-muted-foreground">
                          {asset.asset_type === "video" && <Video className="h-12 w-12" />}
                          {asset.asset_type === "graphic" && <Image className="h-12 w-12" />}
                          {["blog", "snippet", "script", "template"].includes(asset.asset_type) && <FileText className="h-12 w-12" />}
                          {["newsletter", "mailer"].includes(asset.asset_type) && <Newspaper className="h-12 w-12" />}
                          {asset.asset_type === "podcast" && <Mic className="h-12 w-12" />}
                          {asset.asset_type === "qr" && <QrCode className="h-12 w-12" />}
                          {!["video", "graphic", "blog", "snippet", "script", "template", "newsletter", "mailer", "podcast", "qr"].includes(asset.asset_type) && (
                            <Sparkles className="h-12 w-12" />
                          )}
                        </div>
                      )}
                    </div>
                    <CardContent className="pt-4">
                      <div className="flex items-start justify-between mb-2">
                        <Badge className={getStatusColor(asset.approval_status)}>
                          {getStatusIcon(asset.approval_status)}
                          <span className="ml-1 capitalize">{asset.approval_status}</span>
                        </Badge>
                        <Badge variant="outline" className="capitalize">
                          {asset.asset_type.replace("_", " ")}
                        </Badge>
                      </div>
                      <h4 className="font-medium mb-1 line-clamp-1">{asset.asset_name}</h4>
                      {asset.preview_text && (
                        <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{asset.preview_text}</p>
                      )}
                      <div className="flex items-center gap-2">
                        {asset.approval_status === "pending" && (
                          <>
                            <Button
                              size="sm"
                              className="bg-green-600 hover:bg-green-700"
                              onClick={() => handleApproveAsset(asset.id)}
                            >
                              Approve
                            </Button>
                            <Button size="sm" variant="destructive" onClick={() => handleRejectAsset(asset.id)}>
                              Reject
                            </Button>
                          </>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSelectedAssetForQr(asset.id)
                            loadQrCodes()
                            setIsQrLinkOpen(true)
                          }}
                        >
                          <QrCode className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handlePredictPerformance(asset)}
                          title="Predict Performance"
                        >
                          <TrendingUp className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
            </div>
          </TabsContent>

          {/* Calendar Tab */}
          <TabsContent value="calendar" className="space-y-6">
            {/* ── Calendar Grid ──────────────────────────────────────────────── */}
            {(() => {
              // Build month grid entirely in-component — no calendar library needed.
              const today = new Date()
              const viewYear = calendarViewDate.getFullYear()
              const viewMonth = calendarViewDate.getMonth()

              // First day of the month (0=Sun … 6=Sat) and total days
              const firstOfMonth = new Date(viewYear, viewMonth, 1)
              const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
              const startDow = firstOfMonth.getDay() // 0-6

              // Build a Set of "YYYY-MM-DD" strings that have events
              const eventDateSet = new Set<string>()
              for (const key of Object.keys(eventsByDate)) {
                eventDateSet.add(key)
              }

              // Also mark scheduled sends from newsletter state
              for (const s of scheduledSends) {
                const sentAt = s.sent_time || s.scheduled_time
                if (sentAt) {
                  const key = format(new Date(sentAt), "yyyy-MM-dd")
                  eventDateSet.add(key)
                }
              }

              const prevMonth = () => {
                const d = new Date(viewYear, viewMonth - 1, 1)
                setCalendarViewDate(d)
                setSelectedDate(undefined)
              }
              const nextMonth = () => {
                const d = new Date(viewYear, viewMonth + 1, 1)
                setCalendarViewDate(d)
                setSelectedDate(undefined)
              }

              const selectedKey = selectedDate ? format(selectedDate, "yyyy-MM-dd") : null
              const todayKey = format(today, "yyyy-MM-dd")

              // Build cell array: nulls for leading blanks, then 1..daysInMonth
              const cells: (number | null)[] = [
                ...Array(startDow).fill(null),
                ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
              ]
              // Pad to full weeks
              while (cells.length % 7 !== 0) cells.push(null)

              const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

              // Determine which events to show in the list below:
              // If a date is selected, show only events on that date; else all.
              const filteredEvents = selectedKey && eventsByDate[selectedKey]
                ? eventsByDate[selectedKey]
                : calendarEvents

              return (
                <Card className="overflow-hidden shadow-sm">
                  <CardHeader className="pb-3 border-b">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={prevMonth}
                          aria-label="Previous month"
                        >
                          <ChevronRight className="h-4 w-4 rotate-180" />
                        </Button>
                        <h2 className="text-lg font-semibold min-w-[160px] text-center">
                          {format(firstOfMonth, "MMMM yyyy")}
                        </h2>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={nextMonth}
                          aria-label="Next month"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs h-7"
                          onClick={() => { setCalendarViewDate(new Date()); setSelectedDate(undefined) }}
                        >
                          Today
                        </Button>
                      </div>

                      {/* Add Event inline button */}
                      <Dialog open={isCreateEventOpen} onOpenChange={setIsCreateEventOpen}>
                        <DialogTrigger asChild>
                          <Button size="sm" className="bg-violet-600 hover:bg-violet-700">
                            <Plus className="mr-1.5 h-3.5 w-3.5" />
                            Add Event
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Create Calendar Event</DialogTitle>
                            <DialogDescription>Schedule a marketing event</DialogDescription>
                          </DialogHeader>
                          <div className="space-y-4 py-4">
                            <div className="space-y-2">
                              <Label>Event Title</Label>
                              <Input
                                value={newEvent.title}
                                onChange={(e) => setNewEvent({ ...newEvent, title: e.target.value })}
                                placeholder="Social Post Go-Live"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Event Type</Label>
                              <Select
                                value={newEvent.eventType}
                                onValueChange={(v) => setNewEvent({ ...newEvent, eventType: v as any })}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="publish">Publish</SelectItem>
                                  <SelectItem value="send">Send</SelectItem>
                                  <SelectItem value="launch">Launch</SelectItem>
                                  <SelectItem value="review">Review</SelectItem>
                                  <SelectItem value="deadline">Deadline</SelectItem>
                                  <SelectItem value="podcast_release">Podcast Release</SelectItem>
                                  <SelectItem value="mail_drop">Mail Drop</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <Label>Date & Time</Label>
                              <Input
                                type="datetime-local"
                                value={newEvent.scheduledAt}
                                onChange={(e) => setNewEvent({ ...newEvent, scheduledAt: e.target.value })}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Notes</Label>
                              <Textarea
                                value={newEvent.notes}
                                onChange={(e) => setNewEvent({ ...newEvent, notes: e.target.value })}
                                placeholder="Additional details..."
                                rows={3}
                              />
                            </div>
                            <Button onClick={handleCreateCalendarEvent} className="w-full bg-violet-600 hover:bg-violet-700">
                              Create Event
                            </Button>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </div>
                  </CardHeader>

                  <CardContent className="p-0">
                    {/* Day-of-week header */}
                    <div className="grid grid-cols-7 border-b">
                      {DOW_LABELS.map((d) => (
                        <div
                          key={d}
                          className="py-2 text-center text-xs font-semibold text-muted-foreground tracking-wide uppercase"
                        >
                          {d}
                        </div>
                      ))}
                    </div>

                    {/* Date cells grid */}
                    <div className="grid grid-cols-7">
                      {cells.map((day, idx) => {
                        if (day === null) {
                          return (
                            <div
                              key={`blank-${idx}`}
                              className="h-20 border-b border-r last:border-r-0 bg-muted/20"
                            />
                          )
                        }

                        const cellKey = format(new Date(viewYear, viewMonth, day), "yyyy-MM-dd")
                        const isToday = cellKey === todayKey
                        const isSelected = cellKey === selectedKey
                        const hasEvents = eventDateSet.has(cellKey)
                        const cellEvents = eventsByDate[cellKey] ?? []

                        return (
                          <button
                            key={cellKey}
                            type="button"
                            onClick={() => {
                              setSelectedDate(new Date(viewYear, viewMonth, day))
                            }}
                            className={cn(
                              "h-20 border-b border-r last:border-r-0 p-1.5 text-left align-top transition-colors hover:bg-violet-50 dark:hover:bg-violet-950/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                              isSelected && "bg-violet-100 dark:bg-violet-900/30",
                              idx % 7 === 6 && "border-r-0", // last column no right border
                            )}
                          >
                            {/* Day number */}
                            <span
                              className={cn(
                                "inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-medium",
                                isToday && "bg-violet-600 text-white font-bold",
                                isSelected && !isToday && "ring-2 ring-violet-500 text-violet-700 dark:text-violet-300",
                                !isToday && !isSelected && "text-foreground",
                              )}
                            >
                              {day}
                            </span>

                            {/* Event dots / pills */}
                            {hasEvents && (
                              <div className="mt-1 flex flex-wrap gap-0.5">
                                {cellEvents.slice(0, 2).map((ev) => {
                                  const dotColor =
                                    ev.event_type === "deadline" ? "bg-red-500" :
                                    ev.event_type === "go_live" ? "bg-green-500" :
                                    ev.event_type === "meeting" ? "bg-blue-500" :
                                    ev.event_type === "review" ? "bg-yellow-500" :
                                    "bg-violet-500"
                                  return (
                                    <span
                                      key={ev.id}
                                      className={cn("block truncate rounded px-1 text-[10px] leading-4 font-medium text-white max-w-full", dotColor)}
                                      title={ev.title}
                                    >
                                      {ev.title.length > 10 ? ev.title.slice(0, 9) + "…" : ev.title}
                                    </span>
                                  )
                                })}
                                {cellEvents.length > 2 && (
                                  <span className="text-[10px] text-muted-foreground leading-4">
                                    +{cellEvents.length - 2} more
                                  </span>
                                )}
                              </div>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </CardContent>
                </Card>
              )
            })()}

            {/* ── Event cards below the grid ────────────────────────────────── */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-base">
                  {selectedDate
                    ? `Events on ${format(selectedDate, "MMMM d, yyyy")}`
                    : "All Scheduled Events"}
                </h3>
                {selectedDate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => setSelectedDate(undefined)}
                  >
                    Clear filter
                  </Button>
                )}
              </div>

              {(() => {
                const selectedKey = selectedDate ? format(selectedDate, "yyyy-MM-dd") : null
                const filtered = selectedKey
                  ? (eventsByDate[selectedKey] ?? [])
                  : calendarEvents

                if (filtered.length === 0) {
                  return (
                    <div className="rounded-xl border-2 border-dashed border-muted py-12 text-center text-muted-foreground">
                      <CalendarIcon className="h-8 w-8 mx-auto mb-3 opacity-40" />
                      <p className="font-medium">
                        {selectedDate ? "No events on this date" : "No scheduled events yet"}
                      </p>
                      <p className="text-sm mt-1">Click Add Event to schedule a marketing activity</p>
                    </div>
                  )
                }

                return (
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filtered.map((event) => (
                      <Card key={event.id}>
                        <CardContent className="pt-6">
                          <div className="flex items-start justify-between mb-2">
                            <Badge variant="outline" className="capitalize">
                              {event.event_type.replace(/_/g, " ")}
                            </Badge>
                            <Badge className={event.status === "scheduled" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}>
                              {event.status}
                            </Badge>
                          </div>
                          <h4 className="font-semibold mb-1">{event.title}</h4>
                          <p className="text-sm text-muted-foreground mb-2">
                            {format(new Date(event.scheduled_at), "MMM d, yyyy 'at' h:mm a")}
                          </p>
                          {event.campaign && (
                            <p className="text-sm text-muted-foreground">Campaign: {event.campaign.campaign_name}</p>
                          )}
                          {event.notes && <p className="text-sm text-muted-foreground mt-2">{event.notes}</p>}
                          {event.status === "scheduled" && (
                            <div className="flex gap-2 mt-4">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => updateCalendarEventStatus(event.id, "completed")}
                              >
                                <CheckCircle className="h-4 w-4 mr-1" />
                                Complete
                              </Button>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )
              })()}
            </div>
          </TabsContent>

          {/* Newsletters Tab */}
          <TabsContent value="newsletters" className="space-y-6">
            {newsletterError && (
              <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                Newsletter data could not be loaded: {newsletterError}
              </div>
            )}

            {/* ── EMAIL CAMPAIGNS (email_campaigns) ────────────────────────────
                The rows the "New Campaign" button on this tab actually creates.
                Deliberately OUTSIDE the newsletter-template gate below: an
                email blast does not require an approved newsletter template. */}
            {!isNewsletterLoading && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Mail className="h-5 w-5 text-violet-600" />
                        Email Campaigns
                      </CardTitle>
                      {/* This used to read "send or schedule from the newsletter
                          manager". That manager works on newsletter_campaigns and
                          could never reach these rows — the instruction sent people
                          to a screen that would answer "Campaign not found". */}
                      <CardDescription>
                        Drafts you create here. Compose with AI, then schedule the send —
                        the delivery cron sends it through the consent-gated dispatcher.
                      </CardDescription>
                    </div>
                    <Button
                      size="sm"
                      className="bg-violet-600 hover:bg-violet-700"
                      onClick={() => setIsCreateNewsletterOpen(true)}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1.5" />
                      New Campaign
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {emailCampaignsError && (
                    <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      {emailCampaignsError}
                    </div>
                  )}

                  {emailStats && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="rounded-lg border px-3 py-2">
                        <p className="text-xs text-muted-foreground">Total Campaigns</p>
                        <p className="text-xl font-bold">{emailStats.totalCampaigns}</p>
                      </div>
                      <div className="rounded-lg border px-3 py-2">
                        <p className="text-xs text-muted-foreground">Scheduled</p>
                        <p className="text-xl font-bold">{emailStats.activeCampaigns}</p>
                      </div>
                      <div className="rounded-lg border px-3 py-2">
                        <p className="text-xs text-muted-foreground">Subscribers</p>
                        <p className="text-xl font-bold">{emailStats.totalSubscribers.toLocaleString()}</p>
                      </div>
                      <div className="rounded-lg border px-3 py-2">
                        <p className="text-xs text-muted-foreground">Avg Open Rate</p>
                        <p className="text-xl font-bold">
                          {emailStats.avgOpenRate != null ? `${(emailStats.avgOpenRate * 100).toFixed(1)}%` : "—"}
                        </p>
                      </div>
                    </div>
                  )}

                  {emailCampaigns.length === 0 ? (
                    <p className="text-muted-foreground text-center py-6 text-sm">
                      No email campaigns yet — create one to get started.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {emailCampaigns.map((c) => {
                        // A campaign already sent or mid-send is not editable,
                        // reschedulable or deletable — rewinding it would hand it
                        // back to the cron and send it twice.
                        const inFlight = c.status === "sent" || c.status === "sending"
                        return (
                          <div key={c.id} className="p-3 rounded-lg bg-muted/50 space-y-2">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-medium truncate">{c.campaign_name}</p>
                                <p className="text-sm text-muted-foreground truncate">
                                  {c.subject_line}
                                  {c.send_date ? ` · ${format(new Date(c.send_date), "MMM d, yyyy")}` : ""}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <Badge className={getStatusColor(c.status || "draft")}>{c.status || "draft"}</Badge>
                                <Badge variant="outline" className="text-xs capitalize">
                                  {(c.approval_status || "pending").replace("_", " ")}
                                </Badge>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Edit ${c.campaign_name}`}
                                  disabled={isLoadingEmailCampaign || inFlight}
                                  onClick={() => openEmailCampaignEditor(c.id)}
                                >
                                  <Edit className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Delete ${c.campaign_name}`}
                                  disabled={deletingEmailCampaignId === c.id || inFlight}
                                  onClick={() => deleteEmailCampaignRow(c.id)}
                                >
                                  {deletingEmailCampaignId === c.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                            </div>
                            {!inFlight && (
                              <div className="flex flex-wrap items-center gap-2">
                                <Input
                                  type="datetime-local"
                                  aria-label={`Send date and time for ${c.campaign_name}`}
                                  className="h-8 w-auto text-xs"
                                  value={emailScheduleDrafts[c.id] ?? ""}
                                  onChange={(e) =>
                                    setEmailScheduleDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))
                                  }
                                />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8"
                                  disabled={
                                    schedulingEmailCampaignId === c.id || !emailScheduleDrafts[c.id]
                                  }
                                  onClick={() => scheduleEmailCampaignRow(c.id)}
                                >
                                  {schedulingEmailCampaignId === c.id ? (
                                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                  ) : (
                                    <Clock className="h-3.5 w-3.5 mr-1.5" />
                                  )}
                                  {c.status === "scheduled" ? "Reschedule" : "Schedule"}
                                </Button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {isNewsletterLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : newsletterTemplates.length === 0 ? (
              /* Prerequisite gate: no templates → empty state */
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-4">
                  <div className="h-14 w-14 rounded-full bg-violet-100 flex items-center justify-center">
                    <Mail className="h-7 w-7 text-violet-600" />
                  </div>
                  <div>
                    <p className="text-lg font-semibold">No newsletter templates yet</p>
                    <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                      Create at least one approved newsletter template before scheduling campaigns.
                      Templates let you define layout, branding, and reusable sections — then the
                      AI fills in dynamic content at send time.
                    </p>
                  </div>
                  <Button asChild>
                    <a href="/newsletters">
                      Create Newsletter Template
                    </a>
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Already have templates? Ask your broker to approve them so they appear here.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {/* Subscriber Count Card */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">Total Subscribers</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-2">
                      <span className="text-3xl font-bold">{subscriberCount.toLocaleString()}</span>
                      <Badge variant="outline" className="text-green-600">Active</Badge>
                    </div>
                  </CardContent>
                </Card>

                {/* Recent Campaigns */}
                <Card className="md:col-span-2">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2">
                        <Newspaper className="h-5 w-5 text-violet-600" />
                        Newsletter Campaigns
                      </CardTitle>
                      {/* The "New Campaign" button used to sit here, but it
                          creates an email_campaigns row while this list reads
                          newsletter_campaigns — so nothing it made ever showed
                          up. It now lives on the Email Campaigns card above,
                          next to the list it actually populates. */}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          className="bg-violet-600 hover:bg-violet-700"
                          onClick={() => setIsAiNewsletterOpen(true)}
                        >
                          <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                          AI Newsletter
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <a href="/newsletters">Manage</a>
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {newsletterCampaigns.length === 0 ? (
                      <p className="text-muted-foreground text-center py-8">No newsletter campaigns yet</p>
                    ) : (
                      <div className="space-y-3">
                        {newsletterCampaigns.map((campaign) => (
                          <div key={campaign.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                            <div>
                              <p className="font-medium">{campaign.campaign_name || campaign.subject_line}</p>
                              <p className="text-sm text-muted-foreground">
                                {campaign.send_date
                                  ? format(new Date(campaign.send_date), "MMM d, yyyy")
                                  : "Not scheduled"}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge className={getStatusColor(campaign.status || "draft")}>
                                {campaign.status || "draft"}
                              </Badge>
                              {campaign.open_rate && (
                                <span className="text-xs text-muted-foreground">
                                  {(campaign.open_rate * 100).toFixed(1)}% open
                                </span>
                              )}
                              {campaign.click_rate && (
                                <span className="text-xs text-muted-foreground">
                                  {(campaign.click_rate * 100).toFixed(1)}% CTR
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Scheduled Sends */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Clock className="h-5 w-5 text-violet-600" />
                      Scheduled Sends
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {scheduledSends.length === 0 ? (
                      <p className="text-muted-foreground text-center py-4">No scheduled sends</p>
                    ) : (
                      <ScrollArea className="h-[200px]">
                        <div className="space-y-2">
                          {scheduledSends.map((send) => (
                            <div key={send.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/30 text-sm">
                              <div>
                                <p className="font-medium truncate max-w-[150px]">
                                  {send.newsletter?.campaign_name || "Newsletter"}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {send.sent_time
                                    ? format(new Date(send.sent_time), "MMM d, h:mm a")
                                    : "Pending"}
                                </p>
                              </div>
                              <Badge variant="outline" className="text-xs">
                                {send.recipient_count} recipients
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </CardContent>
                </Card>

                {/* Templates */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <FileText className="h-5 w-5 text-violet-600" />
                      Templates
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {newsletterTemplates.length === 0 ? (
                      <p className="text-muted-foreground text-center py-4">No templates available</p>
                    ) : (
                      <div className="space-y-2">
                        {newsletterTemplates.map((template) => (
                          <div key={template.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/30">
                            <span className="text-sm font-medium">{template.template_name || template.name}</span>
                            {/* Had no handler — the only way into a template was
                                a chevron that did nothing. Opens the template
                                that was already loaded on this row. */}
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Preview ${template.template_name || template.name}`}
                              onClick={() => setPreviewTemplate(template)}
                            >
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Local Content Blocks */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Sparkles className="h-5 w-5 text-violet-600" />
                      Local Content
                    </CardTitle>
                    <CardDescription>Recent local content blocks for newsletters</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {localContent.length === 0 ? (
                      <p className="text-muted-foreground text-center py-4">No local content</p>
                    ) : (
                      <div className="space-y-2">
                        {localContent.map((content) => (
                          <div key={content.id} className="p-2 rounded-lg bg-muted/30">
                            <p className="text-sm font-medium">{content.content_type || "Content"}</p>
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {content.content_text || content.description}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          {/* Registry Tab */}
          <TabsContent value="registry" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Link2 className="h-5 w-5 text-violet-600" />
                  Content Registry
                </CardTitle>
                <CardDescription>
                  Link existing content (newsletters, social posts, videos) to campaigns
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 mb-6">
                  <Input
                    placeholder="Search registry..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="max-w-xs h-9 text-sm"
                  />
                  <Button onClick={loadRegistry} variant="outline" size="sm">
                    <Search className="mr-2 h-4 w-4" />
                    {registryItems.length === 0 ? "Load Registry" : "Refresh"}
                  </Button>
                </div>
                {registryItems.length > 0 && (
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {registryItems.filter((item) => {
                      if (!searchQuery.trim()) return true
                      const q = searchQuery.toLowerCase()
                      return item.title?.toLowerCase().includes(q) || item.previewText?.toLowerCase().includes(q) || item.sourceTable?.toLowerCase().includes(q)
                    }).map((item) => (
                      <Card key={`${item.sourceTable}-${item.id}`} className="bg-muted/30">
                        <CardContent className="pt-4">
                          <div className="flex items-start justify-between mb-2">
                            <Badge variant="outline" className="capitalize text-xs">
                              {item.sourceTable.replace("_", " ")}
                            </Badge>
                            <Badge className={getStatusColor(item.status)}>{item.status}</Badge>
                          </div>
                          <h4 className="font-medium mb-1 line-clamp-1">{item.title}</h4>
                          {item.previewText && (
                            <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{item.previewText}</p>
                          )}
                          <Select onValueChange={(campaignId) => handleRegisterSource(item, campaignId)}>
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue placeholder="Link to campaign" />
                            </SelectTrigger>
                            <SelectContent>
                              {campaigns.map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                  {c.campaign_name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* QR Links Tab */}
          <TabsContent value="qr" className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <QrCode className="h-5 w-5 text-violet-600" />
                      QR Code Management
                    </CardTitle>
                    <CardDescription>Link QR codes to marketing assets for tracking</CardDescription>
                  </div>
                  <Button
                    size="sm"
                    className="bg-violet-600 hover:bg-violet-700"
                    onClick={() => setIsCreateQrOpen(true)}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    New QR Code
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 mb-6">
                  <Button onClick={loadQrCodes} variant="outline">
                    <Search className="mr-2 h-4 w-4" />
                    Load Available QR Codes
                  </Button>
                </div>
                {availableQrCodes.length > 0 && (
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {availableQrCodes.map((qr) => (
                      <Card key={qr.id} className="bg-muted/30">
                        <CardContent className="pt-4">
                          <div className="flex items-center gap-4">
                            <div className="h-16 w-16 bg-white rounded-lg flex items-center justify-center border">
                              <QrCode className="h-10 w-10 text-gray-700" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h4 className="font-medium truncate">{qr.label}</h4>
                              <p className="text-sm text-muted-foreground">
                                {qr.purpose}
                                {qr.destinationType ? ` · ${qr.destinationType.replace(/_/g, " ")}` : ""}
                              </p>
                              <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                                <span>{qr.scanCount} scans</span>
                                <span>{qr.leadCount} leads</span>
                                <span>{qr.linkedAssetCount} linked</span>
                              </div>
                            </div>
                          </div>
                          {/* getQrCodePerformance is the ONLY reader of per-code scan DETAIL
                              (unique scans + the recent-scan list off qr_scan_events); the list
                              above shows only the rolled-up counters. It was an orphan export —
                              a real capability with no caller — so it is wired here rather than
                              deleted. */}
                          <div className="mt-3 border-t pt-3">
                            {!qrPerformance[qr.id] ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                disabled={loadingQrPerformanceId === qr.id}
                                onClick={() => handleLoadQrPerformance(qr.id)}
                              >
                                {loadingQrPerformanceId === qr.id
                                  ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                                  : <Eye className="h-3 w-3 mr-1.5" />}
                                Scan detail
                              </Button>
                            ) : qrPerformance[qr.id].error ? (
                              <p className="text-xs text-red-600">{qrPerformance[qr.id].error}</p>
                            ) : (
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-3 text-xs">
                                  <span className="font-medium">{qrPerformance[qr.id].uniqueScans} unique</span>
                                  <span className="text-muted-foreground">
                                    {qrPerformance[qr.id].conversionRate}% converted
                                  </span>
                                </div>
                                {qrPerformance[qr.id].recentScans?.length ? (
                                  <ul className="text-[11px] text-muted-foreground space-y-0.5">
                                    {qrPerformance[qr.id].recentScans.slice(0, 5).map((s: any, i: number) => (
                                      <li key={i}>
                                        {format(new Date(s.scannedAt), "MMM d, h:mm a")}
                                        {s.isFirstScan ? " · first scan" : ""}
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="text-[11px] text-muted-foreground">No scans recorded yet.</p>
                                )}
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
          {/* Direct Mail Tab */}
          <TabsContent value="mail" className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold">Direct Mail Campaigns</h3>
                <p className="text-sm text-muted-foreground">Create, manage, and track postal mail campaigns</p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href="/dashboard/campaigns/mail" target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Full Manager
                  </a>
                </Button>
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                  <a href="/dashboard/campaigns/mail">
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    New Campaign
                  </a>
                </Button>
              </div>
            </div>

            {isMailLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : mailCampaigns.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <Truck className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="font-medium text-muted-foreground">No direct mail campaigns yet</p>
                  <Button size="sm" className="mt-4 bg-violet-600 hover:bg-violet-700" asChild>
                    <a href="/dashboard/campaigns/mail">Create Your First Campaign</a>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {mailCampaigns.map((campaign: any) => (
                  <Card key={campaign.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-5">
                      <div className="flex items-start justify-between mb-2">
                        <Badge variant="outline" className="capitalize">{campaign.status}</Badge>
                        {campaign.quantity && (
                          <span className="text-xs text-muted-foreground">{campaign.quantity} pieces</span>
                        )}
                      </div>
                      <h4 className="font-semibold mb-1">{campaign.campaign_name}</h4>
                      <p className="text-sm text-muted-foreground mb-3">{campaign.target_audience}</p>
                      {campaign.mailing_date && (
                        <p className="text-xs text-muted-foreground">
                          Mail date: {format(new Date(campaign.mailing_date), "MMM d, yyyy")}
                        </p>
                      )}
                      <div className="flex gap-2 mt-4">
                        <Button size="sm" variant="outline" className="flex-1" asChild>
                          <a href="/dashboard/campaigns/mail">
                            <Eye className="h-3.5 w-3.5 mr-1.5" />
                            Preview
                          </a>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Blog Tab */}
          <TabsContent value="blog" className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold">Blog Posts</h3>
                <p className="text-sm text-muted-foreground">Create, edit, and publish SEO-optimized blog content</p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href="/dashboard/marketing/blog">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Blog Manager
                  </a>
                </Button>
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                  <a href="/dashboard/marketing/blog">
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    New Post
                  </a>
                </Button>
              </div>
            </div>

            {isBlogLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : blogPosts.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <Newspaper className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="font-medium text-muted-foreground">No blog posts yet</p>
                  <Button size="sm" className="mt-4 bg-violet-600 hover:bg-violet-700" asChild>
                    <a href="/dashboard/marketing/blog">Create Your First Post</a>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {blogPosts.map((post: any) => (
                  <Card key={post.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-5">
                      <div className="flex items-start justify-between mb-2">
                        <Badge
                          className={
                            post.publish_status === "published"
                              ? "bg-green-100 text-green-700"
                              : post.publish_status === "pending_review"
                              ? "bg-yellow-100 text-yellow-700"
                              : "bg-gray-100 text-gray-700"
                          }
                        >
                          {post.publish_status}
                        </Badge>
                        {post.seo_score != null && (
                          <span className="text-xs font-medium text-violet-600">SEO {post.seo_score}</span>
                        )}
                      </div>
                      <h4 className="font-semibold line-clamp-2 mb-2">{post.title}</h4>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(post.created_at), "MMM d, yyyy")}
                      </p>
                      <div className="flex gap-2 mt-4">
                        <Button size="sm" variant="outline" className="flex-1" asChild>
                          <a href={`/dashboard/marketing/blog/${post.id}`}>
                            <Edit className="h-3.5 w-3.5 mr-1.5" />
                            Edit
                          </a>
                        </Button>
                        {post.publish_status !== "published" && (
                          <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                            <a href={`/dashboard/marketing/blog/${post.id}`}>
                              Preview &amp; Publish
                            </a>
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Podcast Tab */}
          <TabsContent value="podcast" className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold">Podcast Episodes</h3>
                <p className="text-sm text-muted-foreground">Create and distribute AI-powered podcast episodes</p>
              </div>
              <div className="flex items-center gap-2">
                {/* One entry point — the Podcast Studio is where episodes are
                    created; a second "New Episode" button here just navigated to
                    the same place (duplicate). */}
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                  <a href="/dashboard/marketing/podcast">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Open Podcast Studio
                  </a>
                </Button>
              </div>
            </div>

            {isPodcastLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : podcastEpisodes.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <Mic className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="font-medium text-muted-foreground">No podcast episodes yet</p>
                  <Button size="sm" className="mt-4 bg-violet-600 hover:bg-violet-700" asChild>
                    <a href="/dashboard/marketing/podcast">Create Your First Episode</a>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {podcastEpisodes.map((ep: any) => (
                  <Card key={ep.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-5">
                      <div className="flex items-start justify-between mb-2">
                        <Badge
                          className={
                            ep.status === "completed"
                              ? "bg-green-100 text-green-700"
                              : ep.status === "generating"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-700"
                          }
                        >
                          {ep.status}
                        </Badge>
                        {ep.category && (
                          <Badge variant="outline" className="capitalize text-xs">{ep.category}</Badge>
                        )}
                      </div>
                      <h4 className="font-semibold line-clamp-2 mb-1">{ep.title}</h4>
                      {ep.duration_seconds && (
                        <p className="text-xs text-muted-foreground mb-1">
                          {Math.round(ep.duration_seconds / 60)} min
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(ep.created_at), "MMM d, yyyy")}
                      </p>
                      <div className="flex gap-2 mt-4">
                        <Button size="sm" variant="outline" className="flex-1" asChild>
                          <a href="/dashboard/marketing/podcast">
                            <Eye className="h-3.5 w-3.5 mr-1.5" />
                            View
                          </a>
                        </Button>
                        {ep.status === "draft" && (
                          <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                            <a href="/dashboard/marketing/podcast">
                              Publish
                            </a>
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Omnichannel Tab */}
          <TabsContent value="omnichannel" className="space-y-6">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold">Omnichannel Sequence Builder</h3>
                <p className="text-sm text-muted-foreground">Create multi-step automated sequences combining email, SMS, social, video, direct mail, and wait steps.</p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <a href="/dashboard/campaigns/sequences">
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                  All Sequences
                </a>
              </Button>
            </div>

            {omnichannelSuccess && (
              <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/20 px-4 py-3 flex items-center gap-3 text-sm text-green-800 dark:text-green-200">
                <CheckCircle className="h-4 w-4 shrink-0" />
                {omnichannelSuccess}
              </div>
            )}

            <div className="grid lg:grid-cols-2 gap-6">
              {/* Sequence config */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Sequence Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Sequence Name</Label>
                    <Input
                      value={omnichannelName}
                      onChange={(e) => setOmnichannelName(e.target.value)}
                      placeholder="e.g. New Buyer 30-Day Nurture"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Description (optional)</Label>
                    <Textarea
                      value={omnichannelDescription}
                      onChange={(e) => setOmnichannelDescription(e.target.value)}
                      placeholder="What this sequence does…"
                      rows={3}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={addOmnichannelStep}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add Step
                    </Button>
                    <Button
                      className="flex-1 bg-violet-600 hover:bg-violet-700"
                      onClick={handleCreateOmnichannelSequence}
                      disabled={isCreatingOmnichannel || !omnichannelName.trim()}
                    >
                      {isCreatingOmnichannel ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />}
                      {isCreatingOmnichannel ? "Creating…" : "Create Sequence"}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Step builder */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center justify-between">
                    Steps
                    <Badge variant="secondary">{omnichannelSteps.length}</Badge>
                  </CardTitle>
                  <CardDescription>
                    Define the order and timing of each touchpoint.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {omnichannelSteps.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">No steps yet. Click "Add Step" to begin building.</p>
                    </div>
                  ) : (
                    <ScrollArea className="h-[400px] pr-2">
                      <div className="space-y-4">
                        {omnichannelSteps.map((step, idx) => (
                          <div key={step.id} className="border rounded-lg p-3 space-y-3 bg-muted/30">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-muted-foreground">STEP {idx + 1}</span>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                                onClick={() => removeOmnichannelStep(step.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <Label className="text-xs">Type</Label>
                                <Select
                                  value={step.type}
                                  onValueChange={(v) => updateOmnichannelStep(step.id, { type: v as OmnichannelStep["type"] })}
                                >
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="email">Email</SelectItem>
                                    <SelectItem value="sms">SMS</SelectItem>
                                    <SelectItem value="social_post">Social Post</SelectItem>
                                    <SelectItem value="video">Video</SelectItem>
                                    <SelectItem value="direct_mail">Direct Mail</SelectItem>
                                    <SelectItem value="wait">Wait / Delay</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">Step Name</Label>
                                <Input
                                  className="h-8 text-xs"
                                  value={step.name}
                                  onChange={(e) => updateOmnichannelStep(step.id, { name: e.target.value })}
                                  placeholder={`Step ${idx + 1}`}
                                />
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <Label className="text-xs">Delay (days)</Label>
                                <Input
                                  className="h-8 text-xs"
                                  type="number"
                                  min={0}
                                  value={step.delay_days}
                                  onChange={(e) => updateOmnichannelStep(step.id, { delay_days: Number(e.target.value) })}
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">Delay (hours)</Label>
                                <Input
                                  className="h-8 text-xs"
                                  type="number"
                                  min={0}
                                  max={23}
                                  value={step.delay_hours}
                                  onChange={(e) => updateOmnichannelStep(step.id, { delay_hours: Number(e.target.value) })}
                                />
                              </div>
                            </div>
                            {step.type === "email" && (
                              <div className="space-y-1">
                                <Label className="text-xs">Subject Line</Label>
                                <Input
                                  className="h-8 text-xs"
                                  value={step.subject}
                                  onChange={(e) => updateOmnichannelStep(step.id, { subject: e.target.value })}
                                  placeholder="Email subject…"
                                />
                              </div>
                            )}
                            {step.type !== "wait" && (
                              <div className="space-y-1">
                                <Label className="text-xs">{step.type === "email" ? "Body" : "Message / Content"}</Label>
                                <Textarea
                                  className="text-xs"
                                  rows={2}
                                  value={step.body}
                                  onChange={(e) => updateOmnichannelStep(step.id, { body: e.target.value })}
                                  placeholder="Content for this step…"
                                />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Ops — brokerage marketing health (consolidated from the retired Ops Center page) */}
          <TabsContent value="ops" className="space-y-6">
            <MarketingOpsPanel />
            {/* The trend behind the pass-rate tile — brokerage-scoped in
                app/actions/marketing-ops.ts::getReadinessTrendSnapshot. */}
            <ReadinessTrendsPanel />
          </TabsContent>

        </Tabs>

        {/* Performance Prediction Dialog */}
        <Dialog open={isPredictionDialogOpen} onOpenChange={setIsPredictionDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Performance Prediction</DialogTitle>
              <DialogDescription>
                AI-powered analysis of your content&apos;s potential performance
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              {selectedAssetForPrediction && (
                <div className="mb-4 p-3 bg-muted rounded-lg">
                  <p className="font-medium">{selectedAssetForPrediction.asset_name}</p>
                  {selectedAssetForPrediction.preview_text && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                      {selectedAssetForPrediction.preview_text}
                    </p>
                  )}
                  <Badge variant="outline" className="mt-2 text-xs capitalize">
                    {selectedAssetForPrediction.asset_type.replace("_", " ")}
                  </Badge>
                </div>
              )}
              <PredictionWidget
                prediction={currentPrediction}
                isLoading={isPredicting}
                onPredict={() => selectedAssetForPrediction && handlePredictPerformance(selectedAssetForPrediction)}
                showPredictButton={!!currentPrediction}
              />
            </div>
          </DialogContent>
        </Dialog>

        {/* Create Newsletter Campaign Dialog */}
        <Dialog
          open={isCreateNewsletterOpen}
          onOpenChange={(open) => {
            setIsCreateNewsletterOpen(open)
            // Segments are loaded on OPEN rather than at mount: the list is
            // derived by scanning live memberships, so it is worth one query at
            // the moment an agent is actually choosing an audience and not on
            // every visit to the studio.
            if (open) void loadAudienceSegments()
          }}
        >
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>New Newsletter Campaign</DialogTitle>
              <DialogDescription>
                Create a newsletter campaign. You can compose content and schedule after saving.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="nl-name">Campaign Name</Label>
                <Input
                  id="nl-name"
                  placeholder="e.g. May Market Update"
                  value={newNewsletter.campaignName}
                  onChange={(e) => setNewNewsletter((prev) => ({ ...prev, campaignName: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nl-subject">Subject Line</Label>
                <Input
                  id="nl-subject"
                  placeholder="e.g. What's happening in your neighborhood this month"
                  value={newNewsletter.subjectLine}
                  onChange={(e) => setNewNewsletter((prev) => ({ ...prev, subjectLine: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nl-content">Content (optional — save draft and edit later)</Label>
                <Textarea
                  id="nl-content"
                  rows={5}
                  placeholder="Write your newsletter content here, or leave blank to compose later..."
                  value={newNewsletter.content}
                  onChange={(e) => setNewNewsletter((prev) => ({ ...prev, content: e.target.value }))}
                />
              </div>
              {/* ★ THE UMBRELLA LINK ★ email_campaigns.marketing_campaign_id.
                  The column is read by the campaign ROI measurer and by the
                  video/image fan-out that embeds a finished render into every
                  asset under the same campaign — and NOTHING wrote it, so an
                  email created here could never be measured with its campaign
                  or receive its campaign's video. The campaigns list is already
                  in state on this page; this is the control that was missing. */}
              <div className="space-y-1.5">
                <Label htmlFor="nl-campaign">Part of a campaign (optional)</Label>
                <Select
                  value={newNewsletter.marketingCampaignId || "none"}
                  onValueChange={(v) =>
                    setNewNewsletter((prev) => ({ ...prev, marketingCampaignId: v === "none" ? "" : v }))
                  }
                >
                  <SelectTrigger id="nl-campaign">
                    <SelectValue placeholder="Standalone email" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Standalone email</SelectItem>
                    {campaigns.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.campaign_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* ★ THE AUDIENCE ★ email_campaigns.audience_segment_id. The
                  sender resolves a segmented campaign's recipients from active
                  contact_segments memberships — a path that could never run,
                  because nothing wrote this column. Segments are shown by id
                  prefix and live member count: contact_segments.segment_id has
                  no FK and this schema has no segment catalogue to name them
                  from, and a made-up label would be worse than an honest id. */}
              <div className="space-y-1.5">
                <Label htmlFor="nl-segment">Audience segment (optional)</Label>
                <Select
                  value={newNewsletter.audienceSegmentId || "all"}
                  onValueChange={(v) =>
                    setNewNewsletter((prev) => ({ ...prev, audienceSegmentId: v === "all" ? "" : v }))
                  }
                >
                  <SelectTrigger id="nl-segment">
                    <SelectValue placeholder="All subscribers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All subscribers</SelectItem>
                    {audienceSegments.map((sg) => (
                      <SelectItem key={sg.segmentId} value={sg.segmentId}>
                        {`Segment ${sg.segmentId.slice(0, 8)} — ${sg.memberCount} member${sg.memberCount === 1 ? "" : "s"}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {audienceSegmentsError ? (
                  <p className="text-xs text-red-600">{audienceSegmentsError}</p>
                ) : null}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsCreateNewsletterOpen(false)}>
                Cancel
              </Button>
              <Button
                className="bg-violet-600 hover:bg-violet-700"
                disabled={isCreatingNewsletter || !newNewsletter.campaignName.trim()}
                onClick={async () => {
                  setIsCreatingNewsletter(true)
                  try {
                    const { createEmailCampaign } = await import("@/app/actions/email-campaigns")
                    const resolvedBrokerageId = brokerageIdProp || brokerageId
                    const resolvedAgentId = agentId
                    const result = await createEmailCampaign({
                      brokerageId: resolvedBrokerageId,
                      agentId: resolvedAgentId || undefined,
                      campaignName: newNewsletter.campaignName.trim(),
                      subjectLine: newNewsletter.subjectLine.trim() || newNewsletter.campaignName.trim(),
                      content: newNewsletter.content.trim() || "",
                      // email_campaigns.created_by FKs users — the actor, not
                      // the agent record. It was passed the same id as agentId.
                      createdBy: userIdProp ?? "",
                      marketingCampaignId: newNewsletter.marketingCampaignId || undefined,
                      audienceSegmentId: newNewsletter.audienceSegmentId || undefined,
                    })
                    if (result.success) {
                      setIsCreateNewsletterOpen(false)
                      setNewNewsletter({ campaignName: "", subjectLine: "", content: "", marketingCampaignId: "", audienceSegmentId: "" })
                      await loadNewsletterData()
                    } else {
                      toast({ title: "Failed to create newsletter", description: (result as any).error ?? "Unknown error", variant: "destructive" })
                    }
                  } catch (err) {
                    toast({ title: "Failed to create newsletter", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
                  } finally {
                    setIsCreatingNewsletter(false)
                  }
                }}
              >
                {isCreatingNewsletter ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save Draft
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* AI Newsletter Dialog — generateAINewsletter + generateNewsletterSubjectVariants */}
        <Dialog
          open={isAiNewsletterOpen}
          onOpenChange={(open) => {
            setIsAiNewsletterOpen(open)
            if (!open) {
              setAiNewsletterError(null)
              setSubjectVariants(null)
            }
          }}
        >
          <DialogContent className="sm:max-w-[560px] max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Generate Newsletter with AI</DialogTitle>
              <DialogDescription>
                Writes a them-first newsletter from your brand voice, your brokerage&apos;s
                market data and your active listings, and saves it as a DRAFT newsletter
                campaign. Nothing is sent.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="ain-topic">Topic</Label>
                <Input
                  id="ain-topic"
                  placeholder="e.g. Spring market outlook for our neighbourhood"
                  value={aiNewsletter.topic}
                  onChange={(e) => setAiNewsletter((p) => ({ ...p, topic: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Audience</Label>
                  <Select
                    value={aiNewsletter.audienceSegment}
                    onValueChange={(v) =>
                      setAiNewsletter((p) => ({ ...p, audienceSegment: v as typeof p.audienceSegment }))
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Everyone</SelectItem>
                      <SelectItem value="buyers">Buyers</SelectItem>
                      <SelectItem value="sellers">Sellers</SelectItem>
                      <SelectItem value="investors">Investors</SelectItem>
                      <SelectItem value="lifetime_customers">Lifetime customers</SelectItem>
                      <SelectItem value="sphere">Sphere</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Tone</Label>
                  <Select
                    value={aiNewsletter.tone}
                    onValueChange={(v) => setAiNewsletter((p) => ({ ...p, tone: v as typeof p.tone }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="friendly">Friendly</SelectItem>
                      <SelectItem value="professional">Professional</SelectItem>
                      <SelectItem value="educational">Educational</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={aiNewsletter.includeMarketData}
                    onChange={(e) => setAiNewsletter((p) => ({ ...p, includeMarketData: e.target.checked }))}
                  />
                  Include market data
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={aiNewsletter.includeListings}
                    onChange={(e) => setAiNewsletter((p) => ({ ...p, includeListings: e.target.checked }))}
                  />
                  Include my active listings
                </label>
              </div>

              {/* Subject-line A/B variants */}
              <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isGeneratingVariants || !aiNewsletter.topic.trim() || !agentId}
                  onClick={generateSubjectVariants}
                >
                  {isGeneratingVariants ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Generate 5 A/B subject lines
                </Button>
                {subjectVariants && (
                  subjectVariants.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No variants returned.</p>
                  ) : (
                    <ol className="list-decimal pl-5 space-y-0.5 text-sm">
                      {subjectVariants.map((v, i) => <li key={i}>{v}</li>)}
                    </ol>
                  )
                )}
              </div>

              {aiNewsletterError && (
                <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {aiNewsletterError}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsAiNewsletterOpen(false)}>
                Cancel
              </Button>
              <Button
                className="bg-violet-600 hover:bg-violet-700"
                disabled={isGeneratingNewsletter || !agentId}
                onClick={generateNewsletterWithAI}
              >
                {isGeneratingNewsletter ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Generate Draft
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Edit Email Campaign Dialog — getEmailCampaign → aiComposeEmail → updateEmailCampaign */}
        <Dialog
          open={!!editingEmailCampaign}
          onOpenChange={(open) => {
            if (!open) {
              setEditingEmailCampaign(null)
              setEmailEditorError(null)
            }
          }}
        >
          <DialogContent className="sm:max-w-[640px] max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Email Campaign</DialogTitle>
              <DialogDescription>
                Compose the draft. Saving does NOT send — sending and scheduling stay on the
                consent-gated dispatcher in the newsletter manager.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              {/* AI compose */}
              <div className="rounded-lg border p-3 space-y-3 bg-muted/30">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles className="h-4 w-4 text-violet-600" />
                  Compose with AI
                </div>
                <div className="grid sm:grid-cols-[1fr_180px] gap-2">
                  <Input
                    placeholder="What should this email be about?"
                    value={aiComposeTopic}
                    onChange={(e) => setAiComposeTopic(e.target.value)}
                  />
                  <Select
                    value={aiComposeAudience}
                    onValueChange={(v) => setAiComposeAudience(v as typeof aiComposeAudience)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All contacts</SelectItem>
                      <SelectItem value="buyers">Buyers</SelectItem>
                      <SelectItem value="sellers">Sellers</SelectItem>
                      <SelectItem value="investors">Investors</SelectItem>
                      <SelectItem value="lifetime_customers">Lifetime customers</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isComposingEmail || !aiComposeTopic.trim()}
                  onClick={composeEmailWithAI}
                >
                  {isComposingEmail ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Draft subject, preheader &amp; body
                </Button>
                <p className="text-xs text-muted-foreground">
                  Fills the fields below with a draft in your brand voice. Nothing is saved until you press Save.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ec-name">Campaign Name</Label>
                <Input
                  id="ec-name"
                  value={emailEditorDraft.campaignName}
                  onChange={(e) => setEmailEditorDraft((p) => ({ ...p, campaignName: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ec-subject">Subject Line</Label>
                <Input
                  id="ec-subject"
                  value={emailEditorDraft.subjectLine}
                  onChange={(e) => setEmailEditorDraft((p) => ({ ...p, subjectLine: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ec-preview">Preview Text</Label>
                <Input
                  id="ec-preview"
                  placeholder="Inbox preheader"
                  value={emailEditorDraft.previewText}
                  onChange={(e) => setEmailEditorDraft((p) => ({ ...p, previewText: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ec-content">Body</Label>
                <Textarea
                  id="ec-content"
                  rows={10}
                  value={emailEditorDraft.content}
                  onChange={(e) => setEmailEditorDraft((p) => ({ ...p, content: e.target.value }))}
                />
              </div>

              {emailEditorError && (
                <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {emailEditorError}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditingEmailCampaign(null)}>
                Cancel
              </Button>
              <Button
                className="bg-violet-600 hover:bg-violet-700"
                disabled={isSavingEmailCampaign || !emailEditorDraft.campaignName.trim() || !emailEditorDraft.subjectLine.trim()}
                onClick={saveEmailCampaign}
              >
                {isSavingEmailCampaign ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Create QR Code Dialog */}
        <Dialog open={isCreateQrOpen} onOpenChange={(open) => { setIsCreateQrOpen(open); if (!open) setQrError(null) }}>
          <DialogContent className="sm:max-w-[440px]">
            <DialogHeader>
              <DialogTitle>New QR Code</DialogTitle>
              <DialogDescription>
                Create a trackable QR code linked to a URL of your choice.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="qr-label">Label</Label>
                <Input
                  id="qr-label"
                  placeholder="e.g. Open House Flyer — 123 Main St"
                  value={newQr.label}
                  onChange={(e) => setNewQr((prev) => ({ ...prev, label: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qr-url">Target URL</Label>
                <Input
                  id="qr-url"
                  placeholder="https://..."
                  type="url"
                  value={newQr.targetUrl}
                  onChange={(e) => setNewQr((prev) => ({ ...prev, targetUrl: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qr-purpose">Purpose</Label>
                <select
                  id="qr-purpose"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={newQr.purpose}
                  onChange={(e) => setNewQr((prev) => ({ ...prev, purpose: e.target.value as QrPurpose }))}
                >
                  {QR_PURPOSE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qr-destination">Destination Type</Label>
                <select
                  id="qr-destination"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={newQr.destinationType}
                  onChange={(e) => setNewQr((prev) => ({ ...prev, destinationType: e.target.value as QrDestinationType | "" }))}
                >
                  <option value="">Not specified</option>
                  {QR_DESTINATION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  How analytics buckets this code&apos;s scans. Codes created here never set it before,
                  so they were invisible in every destination breakdown.
                </p>
              </div>
              {/* ★ TRACKING LINKED TO CAMPAIGN ★ — the write side of the campaign link.
                  qr_codes.marketing_campaign_id is an FK to marketing_campaigns that had ZERO
                  writers, which is why the campaign measurer reported 0 QR scans for every
                  campaign no matter how many codes it had. Attaching the code here is what makes
                  its scans roll up. */}
              <div className="space-y-1.5">
                <Label htmlFor="qr-campaign">Campaign</Label>
                <select
                  id="qr-campaign"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={newQr.campaignId}
                  onChange={(e) => setNewQr((prev) => ({ ...prev, campaignId: e.target.value }))}
                >
                  <option value="">No campaign (standalone code)</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>{c.campaign_name}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Attach the code to a campaign and its scans, leads and conversions roll up into
                  that campaign&apos;s results.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qr-expires">Expires (optional)</Label>
                <Input
                  id="qr-expires"
                  type="date"
                  value={newQr.expiresAt}
                  onChange={(e) => setNewQr((prev) => ({ ...prev, expiresAt: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  After this date a scan is refused with an explanation instead of routing.
                </p>
              </div>
              {qrError && (
                <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {qrError}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsCreateQrOpen(false)}>
                Cancel
              </Button>
              <Button
                className="bg-violet-600 hover:bg-violet-700"
                disabled={isCreatingQr || !newQr.label.trim() || !newQr.targetUrl.trim()}
                onClick={async () => {
                  setIsCreatingQr(true)
                  setQrError(null)
                  try {
                    const { createQrCodeAction } = await import("@/app/actions/marketing-studio")
                    // Resolve brokerageId from user context when the prop is absent.
                    // IDENTITY CLASS: agentId is NOT recoverable the same way.
                    // qr_codes.agent_id FKs agents(id) and ctx.userId is a users
                    // id, so the old `resolvedAgentId || ctx.userId` fallback sent
                    // a users id into an agents foreign key and every QR code
                    // created down that path was rejected. Refuse instead.
                    let resolvedBrokerageId = brokerageIdProp || brokerageId
                    const resolvedAgentId = agentId
                    if (!resolvedBrokerageId) {
                      const { getUserContextForPrediction } = await import("@/app/actions/content-prediction")
                      const ctx = await getUserContextForPrediction()
                      if (ctx.success && ctx.brokerageId) resolvedBrokerageId = ctx.brokerageId
                    }
                    if (!resolvedBrokerageId || !resolvedAgentId) {
                      setQrError("Could not determine your agent profile. Finish Settings → Profile, then refresh and try again.")
                      return
                    }
                    const result = await createQrCodeAction({
                      brokerageId: resolvedBrokerageId,
                      agentId: resolvedAgentId,
                      label: newQr.label.trim(),
                      targetUrl: newQr.targetUrl.trim(),
                      purpose: newQr.purpose,
                      destinationType: newQr.destinationType || undefined,
                      // ★ TRACKING LINKED TO CAMPAIGN ★ — stamps qr_codes.marketing_campaign_id.
                      campaignId: newQr.campaignId || undefined,
                      expiresAt: newQr.expiresAt ? new Date(newQr.expiresAt).toISOString() : undefined,
                    })
                    if (result.success) {
                      setIsCreateQrOpen(false)
                      setNewQr({ label: "", targetUrl: "", purpose: "general", destinationType: "", campaignId: "", expiresAt: "" })
                      setQrError(null)
                      await loadQrCodes()
                    } else {
                      setQrError((result as any).error ?? "Failed to create QR code.")
                    }
                  } catch (err) {
                    setQrError(err instanceof Error ? err.message : "Failed to create QR code.")
                  } finally {
                    setIsCreatingQr(false)
                  }
                }}
              >
                {isCreatingQr ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Create QR Code
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* QR Link Dialog */}
        <Dialog
          open={isQrLinkOpen}
          onOpenChange={(open) => {
            setIsQrLinkOpen(open)
            if (!open) { setQrLinkError(null); setAssetQrLinks([]) }
            else if (selectedAssetForQr) loadAssetQrLinks(selectedAssetForQr)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Link QR Code to Asset</DialogTitle>
              <DialogDescription>Select a QR code and placement type</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              {/* ALREADY LINKED — the other half of the flow. Without this the studio could
                  attach a QR to an asset and then had no way to see or remove what it attached. */}
              {isLoadingQrLinks ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading linked codes…
                </div>
              ) : assetQrLinks.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Already linked
                  </p>
                  {assetQrLinks.map((link) => (
                    <div key={link.id} className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/30">
                      <div className="flex items-center gap-3 min-w-0">
                        <QrCode className="h-6 w-6 text-gray-600 shrink-0" />
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{link.qrCode?.label ?? "QR code"}</p>
                          <p className="text-xs text-muted-foreground">
                            {link.placementType} · {link.qrCode?.scanCount ?? 0} scans
                          </p>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600 hover:text-red-700"
                        onClick={() => selectedAssetForQr && handleUnlinkQr(link.id, selectedAssetForQr)}
                      >
                        Unlink
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {availableQrCodes.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No QR codes available yet. Create one from the QR Codes tab first.
                </p>
              )}
              {availableQrCodes.map((qr) => (
                <div
                  key={qr.id}
                  className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 cursor-pointer"
                  onClick={() => selectedAssetForQr && handleLinkQr(selectedAssetForQr, qr.id, "flyer")}
                >
                  <div className="flex items-center gap-3">
                    <QrCode className="h-8 w-8 text-gray-600" />
                    <div>
                      <p className="font-medium">{qr.label}</p>
                      <p className="text-sm text-muted-foreground">{qr.scanCount} scans</p>
                    </div>
                  </div>
                  {/* The row carried the only onClick; this button was decoration
                      sitting on top of it and did nothing when it was the thing
                      the user actually aimed at (a click on the button bubbled,
                      but only by accident of layout). Give it the same call and
                      stop the row handler from firing it twice. */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (selectedAssetForQr) handleLinkQr(selectedAssetForQr, qr.id, "flyer")
                    }}
                  >
                    Link
                  </Button>
                </div>
              ))}
              {qrLinkError && (
                <p className="text-sm text-red-600 bg-red-50 rounded-md p-2">{qrLinkError}</p>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Campaign detail — what the eye control on every campaign card opens */}
        <Dialog
          open={isCampaignDetailOpen}
          onOpenChange={(open) => {
            setIsCampaignDetailOpen(open)
            if (!open) { setCampaignDetail(null); setCampaignDetailError(null); setSelectedCampaign(null) }
          }}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {campaignDetail?.campaign_name ?? selectedCampaign?.campaign_name ?? "Campaign"}
              </DialogTitle>
              <DialogDescription>
                {campaignDetail?.listing
                  ? `${campaignDetail.listing.address}, ${campaignDetail.listing.city}`
                  : "Assets, tasks and comments on this campaign"}
              </DialogDescription>
            </DialogHeader>
            {isLoadingCampaignDetail ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : campaignDetailError ? (
              <p className="text-sm text-red-600 bg-red-50 rounded-md p-3">{campaignDetailError}</p>
            ) : campaignDetail ? (
              <ScrollArea className="max-h-[60vh]">
                <div className="space-y-5 pr-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={getStatusColor(campaignDetail.status)}>
                      <span className="capitalize">{String(campaignDetail.status).replace("_", " ")}</span>
                    </Badge>
                    <Badge variant="outline" className="capitalize">{campaignDetail.campaign_type}</Badge>
                    {Number(campaignDetail.budget_total) > 0 && (
                      <Badge variant="outline">
                        ${campaignDetail.budget_spent ?? 0} / ${campaignDetail.budget_total} spent
                      </Badge>
                    )}
                  </div>

                  <div>
                    <p className="text-sm font-semibold mb-2">
                      Assets ({campaignDetail.assets?.length ?? 0})
                    </p>
                    {(campaignDetail.assets ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No assets on this campaign yet.</p>
                    ) : (
                      <div className="space-y-1">
                        {campaignDetail.assets.map((a: any) => (
                          <div key={a.id} className="flex items-center justify-between text-sm rounded-md bg-muted/30 px-2 py-1.5">
                            <span className="truncate">{a.asset_name}</span>
                            <Badge variant="outline" className="capitalize text-xs">{a.approval_status}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-semibold">
                        Tasks ({campaignDetail.tasks?.length ?? 0})
                      </p>
                      {/* THE MISSING WRITER. createCampaignTask existed with no caller. */}
                      <Popover open={isTaskComposerOpen} onOpenChange={setIsTaskComposerOpen}>
                        <PopoverTrigger asChild>
                          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs">
                            <Plus className="h-3 w-3" /> Add task
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-72 space-y-3">
                          <div className="space-y-1">
                            <Label htmlFor="campaign-task-title" className="text-xs">Task</Label>
                            <Input
                              id="campaign-task-title"
                              value={newTaskTitle}
                              onChange={(e) => setNewTaskTitle(e.target.value)}
                              placeholder="e.g. Approve the postcard proof"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="campaign-task-due" className="text-xs">Due (optional)</Label>
                            <Input
                              id="campaign-task-due"
                              type="date"
                              value={newTaskDueAt}
                              onChange={(e) => setNewTaskDueAt(e.target.value)}
                            />
                          </div>
                          <Button
                            size="sm"
                            className="w-full"
                            disabled={isCreatingTask || newTaskTitle.trim().length === 0}
                            onClick={handleCreateCampaignTask}
                          >
                            {isCreatingTask ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckSquare className="h-3 w-3" />}
                            <span className="ml-1">Create task</span>
                          </Button>
                        </PopoverContent>
                      </Popover>
                    </div>
                    {(campaignDetail.tasks ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No tasks on this campaign yet.</p>
                    ) : (
                      <div className="space-y-1">
                        {campaignDetail.tasks.map((t: any) => (
                          <div key={t.id} className="flex items-center justify-between text-sm rounded-md bg-muted/30 px-2 py-1.5">
                            {/* `title` is the column (NOT NULL). `task_name` was a
                                spelling this table has never had. */}
                            <span className="truncate">{t.title}</span>
                            <Badge variant="outline" className="capitalize text-xs">{t.status}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-sm font-semibold mb-2">
                      Comments ({campaignDetail.comments?.length ?? 0})
                    </p>
                    {(campaignDetail.comments ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No comments yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {campaignDetail.comments.map((c: any) => (
                          <div key={c.id} className="rounded-md bg-muted/30 px-2 py-1.5">
                            <p className="text-xs text-muted-foreground">
                              {[c.author?.first_name, c.author?.last_name].filter(Boolean).join(" ") || "Team member"}
                              {c.created_at ? ` · ${format(new Date(c.created_at), "MMM d, h:mm a")}` : ""}
                            </p>
                            {/* `comment_body` IS THE COLUMN — the only text column on
                                marketing_campaign_comments (verified against the live
                                schema). This read was `c.comment_text ?? c.body ??
                                c.content`: three spellings, none of which exists, so
                                every comment would have rendered as a blank line under
                                its author's name. It never showed because nothing could
                                write a comment either — the two halves were missing
                                together, which is why neither was visible. */}
                            <p className="text-sm">{c.comment_body}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* THE MISSING WRITER. addCampaignComment existed with no caller. */}
                    <div className="mt-2 space-y-2">
                      <Textarea
                        value={newCommentBody}
                        onChange={(e) => setNewCommentBody(e.target.value)}
                        placeholder="Leave a note for the team on this campaign…"
                        rows={2}
                      />
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          disabled={isPostingComment || newCommentBody.trim().length === 0}
                          onClick={handleAddCampaignComment}
                        >
                          {isPostingComment ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
                          <span className="ml-1">Post comment</span>
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* A refused write must SAY SO. Both writers return
                      `{ success:false, error }` on an access refusal or a
                      database error, and a silent failure here would look
                      exactly like the "nothing to show" this whole panel used
                      to be. */}
                  {collabError && (
                    <p className="text-sm text-destructive">{collabError}</p>
                  )}
                </div>
              </ScrollArea>
            ) : null}
          </DialogContent>
        </Dialog>

        {/* Newsletter template preview — what the chevron on a template row opens */}
        <Dialog open={!!previewTemplate} onOpenChange={(open) => { if (!open) setPreviewTemplate(null) }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{previewTemplate?.template_name || previewTemplate?.name || "Template"}</DialogTitle>
              <DialogDescription>
                {previewTemplate?.template_description || "Broker newsletter template"}
              </DialogDescription>
            </DialogHeader>
            {previewTemplate && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="capitalize">
                    {previewTemplate.approval_status ?? previewTemplate.status ?? "unknown"}
                  </Badge>
                  {previewTemplate.is_default && <Badge variant="outline">Default</Badge>}
                  {previewTemplate.version_number != null && (
                    <Badge variant="outline">v{previewTemplate.version_number}</Badge>
                  )}
                </div>
                <ScrollArea className="h-[45vh] rounded-md border p-3">
                  {previewTemplate.content ? (
                    <pre className="text-xs whitespace-pre-wrap break-words font-sans">
                      {previewTemplate.content}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      This template row has no saved content.
                    </p>
                  )}
                </ScrollArea>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* ── EDIT CAMPAIGN ─────────────────────────────────────────────────── */}
        <Dialog open={!!editingCampaign} onOpenChange={(open) => !open && setEditingCampaign(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Campaign</DialogTitle>
              <DialogDescription>
                Name, budget and schedule. Status changes go through the lifecycle buttons on the card.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>Campaign Name</Label>
                <Input
                  value={editCampaign.campaignName}
                  onChange={(e) => setEditCampaign({ ...editCampaign, campaignName: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Total Budget ($)</Label>
                <Input
                  type="number"
                  min={0}
                  value={editCampaign.budgetTotal}
                  onChange={(e) => setEditCampaign({ ...editCampaign, budgetTotal: e.target.value })}
                  placeholder="Leave blank to keep as is"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Starts</Label>
                  <Input
                    type="date"
                    value={editCampaign.scheduledStartAt}
                    onChange={(e) => setEditCampaign({ ...editCampaign, scheduledStartAt: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Ends</Label>
                  <Input
                    type="date"
                    value={editCampaign.scheduledEndAt}
                    onChange={(e) => setEditCampaign({ ...editCampaign, scheduledEndAt: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditingCampaign(null)} disabled={isSavingCampaign}>
                  Cancel
                </Button>
                <Button onClick={handleSaveCampaignEdits} disabled={isSavingCampaign}>
                  {isSavingCampaign && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Save Changes
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
