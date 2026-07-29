"use client"

import { useEffect, useState, useCallback, useTransition, useRef } from "react"
import { useAuth } from "@/lib/auth/client"
import { useSearchParams, useRouter } from "next/navigation"
import { getContacts, getContactById, createContact, addContactNote } from "@/app/actions/contacts"
import {
  getContactCreditAccounts,
  getContactVideoEngagement,
  getContactTransactions,
  getContactActivity,
} from "@/app/actions/contact-details"
import { getContactIntelligence, toggleAIISA, type ContactIntelligence } from "@/app/actions/contact-intelligence"
import { FinancialVerificationPanel } from "@/app/crm/components/financial-verification-panel"
import { ListingConsultationScheduler } from "@/app/crm/components/listing-consultation-scheduler"
import { ClosingWorkflowTab } from "@/app/crm/components/closing-workflow-tab"
import { AIPilotControl } from "@/app/crm/components/ai-pilot-control"
import { ContactHeaderCard } from "@/app/crm/components/contact-header-card"
import { getActiveAutoPilotPlans, detectClientChurn, getConversationIntelligence } from "@/app/actions/ai-predictions"
import { generateContactInsights, draftSmartEmail } from "@/app/actions/ai-insights"
import type { ContactInsight } from "@/app/actions/ai-insights"
import { aiSuggestFollowUp } from "@/app/actions/ai-lead-nurturing"
import { getUnifiedLeadProfiles, getSocialIntelligence } from "@/app/actions/lead-intelligence"
import { LIFETIME_CUSTOMER_TYPE } from "@/lib/contact-types"
import { listCampaignSequences, enrollContactInSequence } from "@/app/actions/campaign-sequences"
import { aiOptimizeReferralAsk } from "@/app/actions/ai-sphere-management"
import { generateAIDraft, shareSocialPostWithSeller } from "@/app/actions/portal-messages"
import { generateCopilotPlan } from "@/app/actions/workflows"
import { GratitudeGiftingPanel } from "@/app/dashboard/referrals/components/os/gratitude-gifting-panel"
import { getBuyerInsights } from "@/app/actions/buyer-insights"
import { getBuyerFatigueScore } from "@/app/actions/buyer-fatigue"
import { scoreLeadWithAI } from "@/app/actions/ai-lead-scoring"
import { createPortalInviteForContact } from "@/app/actions/portal-invites"
import { sendSMS, scheduleAppointment } from "@/app/actions/communications"
import { analyzeCallTranscript, generateCallSummaryEmail } from "@/app/actions/ai-voice-transcription"
import { AddressAutocomplete } from "@/app/components/ui/address-autocomplete"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import SendBuyerIntakeButton from "@/app/crm/components/workflow-actions/send-buyer-intake-button"
import {
  Users,
  Search,
  Plus,
  Mail,
  Phone,
  MapPin,
  Loader2,
  RefreshCw,
  ArrowLeft,
  Brain,
  MessageSquare,
  TrendingUp,
  AlertTriangle,
  Sparkles,
  Building2,
  ExternalLink,
  Home,
  Globe,
  FileText,
  UserCircle,
  LayoutDashboard,
  Network,
  Send,
  Star,
  MessageCircle,
  CalendarPlus,
  Workflow,
  CreditCard,
  Video,
  Activity,
  DollarSign,
  CheckSquare,
} from "lucide-react"
import Link from "next/link"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { FormWizard } from "@/app/components/form-wizard/FormWizard"

// Import all 10 Contact OS components
import {
  ContactPulsePanel,
  CommunicationHealthPanel,
  NextBestActionPanel,
  ValueDeliveredPanel,
  TimelineContextPanel,
  RelationshipAiChatPanel,
  SmartNoteComposer,
  BuyerMatchPanel,
  QualificationSummaryCard,
  type IsaHandoffBriefShape,
} from "./components/os"

interface Contact {
  id: string
  first_name: string
  last_name: string
  email: string
  phone?: string | null
  contact_type?: string | null
  contact_persona?: string | null
  buyer_stage?: string | null
  status?: string | null
  city?: string | null
  state?: string | null
  zip_code?: string | null
  lead_source?: string | null
  created_at?: string | null
  engagement_score?: number | null
  /** DB column: last_contacted_at */
  last_contacted_at?: string | null
  referral_potential?: "high" | "medium" | "low" | null
  // Communication opt-out / DNC fields (selected by getContacts)
  dnc_status?: boolean | null
  email_opt_out?: boolean | null
  sms_opt_out?: boolean | null
  phone_opt_out?: boolean | null
  direct_mail_opt_out?: boolean | null
  source?: string | null
  source_family?: string | null
}

const STATUS_COLORS: Record<string, string> = {
  new: "bg-slate-100 text-slate-700",
  contacted: "bg-blue-100 text-blue-700",
  qualified: "bg-indigo-100 text-indigo-700",
  appointment_booked: "bg-purple-100 text-purple-700",
  signed_agreement: "bg-yellow-100 text-yellow-700",
  active_listing: "bg-orange-100 text-orange-700",
  pending: "bg-amber-100 text-amber-700",
  sold: "bg-green-100 text-green-700",
  lifetime_customer: "bg-emerald-100 text-emerald-700",
}

const TYPE_COLORS: Record<string, string> = {
  buyer: "bg-blue-50 text-blue-700",
  seller: "bg-green-50 text-green-700",
  investor: "bg-purple-50 text-purple-700",
  lifetime_customer: "bg-emerald-50 text-emerald-700",
  other: "bg-gray-50 text-gray-600",
}

const TYPE_AVATAR_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  buyer:             { bg: "bg-blue-100",    text: "text-blue-700",    border: "border-l-blue-400" },
  seller:            { bg: "bg-green-100",   text: "text-green-700",   border: "border-l-green-400" },
  investor:          { bg: "bg-purple-100",  text: "text-purple-700",  border: "border-l-purple-400" },
  lifetime_customer: { bg: "bg-emerald-100", text: "text-emerald-700", border: "border-l-emerald-400" },
  other:             { bg: "bg-gray-100",    text: "text-gray-600",    border: "border-l-gray-300" },
}

export default function CRMPage() {
  const { user, role, loading: authLoading } = useAuth()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Contact list state
  const [contacts, setContacts] = useState<Contact[]>([])
  const [filtered, setFiltered] = useState<Contact[]>([])
  const [search, setSearch] = useState("")
  // Seed the type tab from ?contact_type= (or legacy ?type=) so deep-links from
  // elsewhere (e.g. the former /dashboard/buyers lane) land on the right tab of
  // the single chronological CRM rather than spawning a separate dashboard.
  const [typeFilter, setTypeFilter] = useState<"all" | "buyer" | "seller" | "investor" | "lifetime_customer">(() => {
    const p = (searchParams.get("contact_type") ?? searchParams.get("type") ?? "").toLowerCase()
    if (p === "buyer" || p === "seller" || p === "investor" || p === "lifetime_customer") return p
    if (p === "lifetime") return "lifetime_customer"
    return "all"
  })
  const [loading, setLoading] = useState(true)
  const [searchLoading, setSearchLoading] = useState(false)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchGenRef = useRef(0)
  const searchQueryRef = useRef("")
  const activitiesGenRef = useRef(0)
  const [error, setError] = useState<string | null>(null)

  // Selected contact detail state.
  // Reader accepts BOTH ?contact= (canonical, preferred) AND ?contactId= (legacy alias).
  // 18 writers across the app previously used the longer form; the alias here keeps
  // every old URL, bookmark, and email-deeplink working while writers migrate.
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    searchParams.get("contact") ?? searchParams.get("contactId")
  )
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Brief-driven action: when the morning brief deep-links here with
  // ?action=draft_followup or ?action=schedule_appointment, auto-open the
  // matching sheet so the agent can act in one click.
  const briefAction = searchParams.get("action")
  const [pendingBriefAction, setPendingBriefAction] = useState<string | null>(briefAction)

  // Agent context (resolved from agents table, not users table)
  // contacts.agent_id = agents.id — must resolve via agents.user_id = auth user.id
  const [agentId, setAgentId] = useState<string | null>(null)
  const [brokerageId, setBrokerageId] = useState<string | null>(null)

  // Contact OS data
  const [churnRisk, setChurnRisk] = useState<any>(null)
  const [autopilotPlans, setAutopilotPlans] = useState<any[]>([])
  const [copilotPlan, setCopilotPlan] = useState<any>(null)
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [conversationIntelligence, setConversationIntelligence] = useState<any>(null)
  const [buyerInsights, setBuyerInsights] = useState<any>(null)
  const [fatigueData, setFatigueData] = useState<any>(null)
  const [relatedListing, setRelatedListing] = useState<any>(null)
  const [relatedTransaction, setRelatedTransaction] = useState<any>(null)
  const [referralGenerating, setReferralGenerating] = useState(false)
  const [noteSaving, setNoteSaving] = useState(false)
  /** Lifted AI draft text — passed to CommunicationHealthPanel to pre-fill compose */
  const [pendingDraftText, setPendingDraftText] = useState<string | null>(null)

  // Contact activity feed (notes, calls, etc.) — shown in the Communications tab
  const [contactActivities, setContactActivities] = useState<any[]>([])
  const [callAnalyses, setCallAnalyses] = useState<Record<string, any>>({})

  // Contact-detail data for the Credit / Videos / Transactions / Activity tabs
  // (these tabs were previously only available on the deprecated /crm/contacts/[id] route)
  const [creditAccounts, setCreditAccounts] = useState<any[]>([])
  const [contactVideos, setContactVideos] = useState<any[]>([])
  const [contactTransactions, setContactTransactions] = useState<any[]>([])
  const [contactActivityTimeline, setContactActivityTimeline] = useState<any[]>([])
  const [contactIntelligence, setContactIntelligence] = useState<ContactIntelligence | null>(null)
  const [unifiedLeadProfile, setUnifiedLeadProfile] = useState<any>(null)
  const [socialSignals, setSocialSignals] = useState<any[]>([])
  const [analyzingCallId, setAnalyzingCallId] = useState<string | null>(null)

  // Lead conversion scores — populated async after contacts load (best-effort, never blocks render)
  const [leadScores, setLeadScores] = useState<Record<string, { label: "High" | "Medium"; score: number }>>({})

  // Communications hub dialog states
  const [smsDialogOpen, setSmsDialogOpen] = useState(false)
  const [smsText, setSmsText] = useState("")
  const [smsSending, setSmsSending] = useState(false)
  const [apptDialogOpen, setApptDialogOpen] = useState(false)
  const [apptTitle, setApptTitle] = useState("")
  const [apptDate, setApptDate] = useState("")
  const [apptTime, setApptTime] = useState("")
  const [apptSending, setApptSending] = useState(false)
  const [autoDialogOpen, setAutoDialogOpen] = useState(false)
  const [autoWorkflowId, setAutoWorkflowId] = useState("")
  const [autoSending, setAutoSending] = useState(false)

  // Suggested follow-up actions for the selected contact
  const [suggestedActions, setSuggestedActions] = useState<any[]>([])

  // Conversation threads for the selected contact (loaded by CommunicationHealthPanel internally;
  // we hold a local copy here so RelationshipRadar can count open threads)
  const [conversations, setConversations] = useState<any[]>([])

  // AI Priority Insights state
  const [contactInsights, setContactInsights] = useState<ContactInsight[]>([])
  const [loadingInsights, setLoadingInsights] = useState(false)
  const [draftingFor, setDraftingFor] = useState<string | null>(null)
  const [offerWizardOpen, setOfferWizardOpen] = useState(false)

  // Portal invite status for selected contact
  const [portalInviteStatus, setPortalInviteStatus] = useState<string | null>(null)
  // Richer portal invite data for the Portal tab
  const [portalInviteData, setPortalInviteData] = useState<{
    status: string | null
    accepted_at: string | null
    invited_at: string | null
    lastAccessed: string | null
  } | null>(null)

  // Journey & Team tab — lazy loaded on first tab activation
  const [journeyTeamData, setJourneyTeamData] = useState<{
    transactionId: string | null
    milestones:   any[]
    dealTeam:     any[]
    lenders:      any[]
    vendors:      any[]
    timeline:     any[]
  } | null>(null)
  const [journeyTeamLoading, setJourneyTeamLoading] = useState(false)
  const [journeyTeamLoaded, setJourneyTeamLoaded] = useState(false)
  const [journeyTeamError, setJourneyTeamError] = useState<string | null>(null)

  // Active CRM tab
  const [activeTab, setActiveTab] = useState("overview")

  // Bulk select + Enroll in Campaign
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set())
  const [enrollDialogOpen, setEnrollDialogOpen] = useState(false)
  const [availableSequences, setAvailableSequences] = useState<{ id: string; name: string; sequence_type: string }[]>([])
  const [selectedSequenceId, setSelectedSequenceId] = useState<string>("")
  const [enrolling, setEnrolling] = useState(false)

  // AI Copilot Plan state (copilotPlan and loadingPlan already declared above)
  const [generatingPlan, setGeneratingPlan] = useState(false)
  const [isaHandoffContext, setIsaHandoffContext] = useState<{
    qualificationScore?: number
    qualificationResult?: string
    qualificationSignals?: Record<string, any>
    assignedAt?: string
  } | null>(null)

  // Resolve agents.id and brokerage_id from the agents table via user.id
  // contacts.agent_id = agents.id (FK) — NEVER users.id
  useEffect(() => {
    if (!user?.id) return
    const supabase = createClient()
    supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }: { data: { id: string; brokerage_id: string } | null }) => {
        if (data) {
          setAgentId(data.id)
          setBrokerageId(data.brokerage_id)
        } else {
          // Fallback: resolve brokerage_id from users table for broker/admin roles
          supabase
            .from("users")
            .select("brokerage_id")
            .eq("id", user.id)
            .maybeSingle()
            .then(({ data: userData }: { data: { brokerage_id: string } | null }) => {
              if (userData?.brokerage_id) setBrokerageId(userData.brokerage_id)
            })
            .catch(() => {})
        }
      })
      .catch(() => {})
  }, [user])

  const loadContacts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getContacts({ limit: 100 })
      if (result.success) {
        setContacts(result.contacts)
        if (searchQueryRef.current) {
          // Search is active — re-fetch with current term so filtered reflects fresh data
          getContacts({ search: searchQueryRef.current, limit: 100 })
            .then((r) => { if (r.success) setFiltered(r.contacts) })
            .catch(() => {/* non-blocking */})
        } else {
          setFiltered(result.contacts)
        }
        // Lead scores are loaded lazily per-contact when a contact is selected
        // to avoid firing 20 simultaneous AI/DB server actions that crash the browser.
      } else {
        setError(result.error ?? "Failed to load contacts")
      }
    } catch (err) {
      setError("Failed to load contacts")
    } finally {
      setLoading(false)
    }
  }, [])

  // Load contact detail and OS data
  const loadContactDetail = useCallback(
    async (contactId: string) => {
      // agentId may still be resolving — don't block; the server action resolves identity itself
      setDetailLoading(true)
      setIsaHandoffContext(null)
      setBuyerInsights(null)
      setFatigueData(null)
      try {
        // Core data loads — contact + churn + autopilot + followup + conv intel + tab data in parallel
        const [
          contactResult,
          churnResult,
          autopilotResult,
          followUpResult,
          convIntelResult,
          creditResult,
          videosResult,
          transactionsResult,
          activityResult,
        ] = await Promise.all([
          getContactById(contactId),
          detectClientChurn(contactId).catch(() => null),
          getActiveAutoPilotPlans(agentId ?? "").catch(() => []),
          aiSuggestFollowUp({ contactId, agentId: agentId ?? "" }).catch(() => ({ suggestions: [] })),
          getConversationIntelligence(contactId).catch(() => null),
          getContactCreditAccounts(contactId).catch(() => ({ accounts: [] })),
          getContactVideoEngagement(contactId).catch(() => ({ videos: [] })),
          getContactTransactions(contactId).catch(() => ({ transactions: [] })),
          getContactActivity(contactId).catch(() => ({ activity: [] })),
        ])

        setCreditAccounts(creditResult?.accounts ?? [])
        setContactVideos(videosResult?.videos ?? [])
        setContactTransactions(transactionsResult?.transactions ?? [])
        setContactActivityTimeline(activityResult?.activity ?? [])

        // Intelligence loads independently — non-blocking
        getContactIntelligence(contactId)
          .then((res) => {
            if (res.success && res.intelligence) setContactIntelligence(res.intelligence)
            else setContactIntelligence(null)
          })
          .catch(() => setContactIntelligence(null))

        // Unified lead profile + social intelligence signals — non-blocking
        getUnifiedLeadProfiles({ contact_id: contactId })
          .then((res) => setUnifiedLeadProfile(res.profiles?.[0] ?? null))
          .catch(() => setUnifiedLeadProfile(null))
        getSocialIntelligence()
          .then((res) => setSocialSignals(res.signals ?? []))
          .catch(() => setSocialSignals([]))

        if (contactResult?.success && contactResult.contact) {
          setSelectedContact(contactResult.contact)

          // Non-blocking buyer intelligence load — fires after UI is already shown
          const ct = contactResult.contact.contact_type?.toLowerCase() ?? ""
          if (ct === "buyer" || ct === "renter" || !!contactResult.contact.buyer_stage) {
            setTimeout(() => {
              Promise.all([
                getBuyerInsights(contactId).catch(() => null),
                getBuyerFatigueScore(contactId).catch(() => null),
              ]).then(([insights, fatigue]) => {
                setBuyerInsights(insights ?? null)
                setFatigueData(fatigue ?? null)
              })
            }, 0)
          }
        }

        // Fetch ISA qualification data — non-blocking
        const supabase = createClient()
        supabase
          .from("ai_isa_qualifications")
          .select("qualification_score, qualification_result, qualification_signals, qualified_at, assigned_at")
          .eq("contact_id", contactId)
          .order("qualified_at", { ascending: false })
          .limit(1)
          .maybeSingle()
          .then(({ data }: { data: { qualification_score: any; qualification_result: any; qualification_signals: any; qualified_at: any; assigned_at: any } | null }) => {
            if (data) {
              setIsaHandoffContext({
                qualificationScore: data.qualification_score ?? undefined,
                qualificationResult: data.qualification_result ?? undefined,
                qualificationSignals: data.qualification_signals ?? undefined,
                // qualified_at = when ISA completed qualification; assigned_at = when agent was assigned
                assignedAt: data.assigned_at ?? undefined,
              })
            }
          })
          .catch(() => {/* non-blocking */})

        setChurnRisk(churnResult)
        setAutopilotPlans(Array.isArray(autopilotResult) ? autopilotResult : [])
        setSuggestedActions(followUpResult?.suggestions || [])
        setConversationIntelligence(Array.isArray(convIntelResult) && convIntelResult.length > 0 ? convIntelResult[0] : null)
      } catch (err) {
        console.error("Failed to load contact detail:", err)
      } finally {
        setDetailLoading(false)
      }
    },
    [agentId]
  )

  useEffect(() => {
    if (!authLoading && user) {
      loadContacts()
    }
  }, [authLoading, user, loadContacts])

  useEffect(() => {
    if (!authLoading && user?.id) {
      setLoadingInsights(true)
      generateContactInsights(user.id, role)
        .then((insights) => setContactInsights(insights.slice(0, 5)))
        .catch(() => {/* non-blocking */})
        .finally(() => setLoadingInsights(false))
    }
  }, [authLoading, user?.id, role])

  useEffect(() => {
    if (selectedContactId) {
      loadContactDetail(selectedContactId)
      // Brief-driven action handling: when the morning brief deep-linked the
      // agent here with ?action=draft_followup or ?action=schedule_appointment,
      // jump to the right tab + surface a guiding toast so the agent acts
      // in one click.
      if (pendingBriefAction) {
        const actionMap: Record<string, { tab: string; message: string }> = {
          draft_followup: { tab: "comms", message: "Morning brief: draft a follow-up message" },
          schedule_appointment: { tab: "comms", message: "Morning brief: schedule an appointment" },
        }
        const handler = actionMap[pendingBriefAction]
        if (handler) {
          setActiveTab(handler.tab)
          toast.info(handler.message, { duration: 4000 })
        }
        setPendingBriefAction(null)
      }
    }
  }, [selectedContactId, loadContactDetail])

  // Fetch portal invite status when a contact is selected — non-blocking
  useEffect(() => {
    if (!selectedContactId) {
      setPortalInviteStatus(null)
      setPortalInviteData(null)
      setJourneyTeamData(null)
      setJourneyTeamLoaded(false)
      setJourneyTeamError(null)
      setActiveTab("overview")
      return
    }
    const supabase = createClient()
    // Fetch invite + last access in parallel
    Promise.all([
      supabase
        .from("portal_contact_invites")
        .select("status, accepted_at, invited_at")
        .eq("contact_id", selectedContactId)
        .order("invited_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("portal_access_logs")
        .select("accessed_at")
        .eq("contact_id", selectedContactId)
        .order("accessed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
      .then(([inviteRes, accessRes]) => {
        setPortalInviteStatus(inviteRes.data?.status ?? null)
        setPortalInviteData({
          status:       inviteRes.data?.status ?? null,
          accepted_at:  inviteRes.data?.accepted_at ?? null,
          invited_at:   inviteRes.data?.invited_at ?? null,
          lastAccessed: accessRes.data?.accessed_at ?? null,
        })
      })
      .catch(() => {/* non-blocking */})
  }, [selectedContactId])

  // Load conversations for the selected contact so RelationshipRadar and
  // CommunicationHealthPanel both have accurate thread counts / history.
  useEffect(() => {
    if (!selectedContactId) {
      setConversations([])
      return
    }
    const supabase = createClient()
    supabase
      .from("conversations")
      .select("*")
      .eq("contact_id", selectedContactId)
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data }: { data: any[] | null }) => setConversations(data || []))
      .catch(() => setConversations([]))
  }, [selectedContactId])

  // Load recent activities (notes, calls, etc.) for the selected contact
  useEffect(() => {
    if (!selectedContactId) {
      setContactActivities([])
      return
    }
    setContactActivities([])
    activitiesGenRef.current += 1
    const gen = activitiesGenRef.current
    const supabase = createClient()
    // Notes live in contact_notes (the store of record), everything else in
    // activities. Read both and merge, or saved notes vanish from this pane.
    Promise.all([
      supabase
        .from("activities")
        .select("id, activity_type, title, description, notes, created_at, contact_id")
        .eq("contact_id", selectedContactId)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("contact_notes")
        .select("id, body, created_at, contact_id")
        .eq("contact_id", selectedContactId)
        .order("created_at", { ascending: false })
        .limit(20),
    ])
      .then(([acts, notes]: [{ data: any[] | null }, { data: any[] | null }]) => {
        if (gen !== activitiesGenRef.current) return  // stale
        const noteRows = (notes.data ?? []).map((n: any) => ({
          id: n.id,
          activity_type: "note",
          title: "Note",
          description: n.body,
          notes: n.body,
          created_at: n.created_at,
          contact_id: n.contact_id,
        }))
        setContactActivities(
          [...(acts.data ?? []), ...noteRows]
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .slice(0, 20)
        )
      })
      .catch(() => {
        if (gen !== activitiesGenRef.current) return
        setContactActivities([])
      })
  }, [selectedContactId])

  // Lazy-load Journey & Team tab data
  const loadJourneyTeam = useCallback(async (contactId: string, force = false) => {
    if (!force && (journeyTeamLoaded || journeyTeamLoading)) return
    setJourneyTeamError(null)
    setJourneyTeamLoading(true)
    const supabase = createClient()
    try {
      // Find the most recent transaction for this contact
      const { data: tx } = await supabase
        .from("transactions")
        .select("id")
        .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId},contact_id.eq.${contactId}`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      const txId = tx?.id ?? null

      const [milestonesRes, dealTeamRes, lendersRes, vendorsRes, timelineRes] = await Promise.all([
        txId
          ? supabase
              .from("transaction_milestones")
              .select("id, milestone_name, milestone_type, status, target_date, completed_at, description")
              .eq("transaction_id", txId)
              .order("target_date", { ascending: true })
              .limit(20)
          : Promise.resolve({ data: [] }),
        txId
          ? supabase
              .from("deal_team_members")
              .select("id, name, email, phone, company, member_type, portal_access")
              .eq("transaction_id", txId)
              .limit(20)
          : Promise.resolve({ data: [] }),
        txId
          ? supabase
              .from("transaction_lenders")
              .select("id, lender_name, loan_officer_name, loan_officer_phone, loan_officer_email, loan_type, underwriting_status")
              .eq("transaction_id", txId)
              .limit(5)
          : Promise.resolve({ data: [] }),
        supabase
          .from("contact_vendors")
          .select("id, role, status, vendors(id, name, category, phone, email)")
          .eq("contact_id", contactId)
          .limit(10),
        txId
          ? supabase
              .from("transaction_timeline")
              .select("id, activity_type, description, created_at")
              .eq("transaction_id", txId)
              .order("created_at", { ascending: false })
              .limit(10)
          : Promise.resolve({ data: [] }),
      ])

      setJourneyTeamData({
        transactionId: txId,
        milestones:  milestonesRes.data ?? [],
        dealTeam:    dealTeamRes.data ?? [],
        lenders:     lendersRes.data ?? [],
        vendors:     vendorsRes.data ?? [],
        timeline:    timelineRes.data ?? [],
      })
    } catch (e: any) {
      console.error("[CRM] loadJourneyTeam error:", e)
      setJourneyTeamError("Failed to load deal data. Please try again.")
    } finally {
      setJourneyTeamLoading(false)
      setJourneyTeamLoaded(true)
    }
  }, [journeyTeamLoaded, journeyTeamLoading])

  // Fetch active copilot plan when a contact is selected
  useEffect(() => {
    if (!selectedContactId) {
      setCopilotPlan(null)
      return
    }
    setLoadingPlan(true)
    const supabase = createClient()
    supabase
      .from("copilot_plans")
      .select("id, plan_name, status, next_action, next_action_date, updated_at")
      .eq("contact_id", selectedContactId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }: { data: any | null }) => {
        setCopilotPlan(data ?? null)
        setLoadingPlan(false)
      })
      .catch(() => setLoadingPlan(false))
  }, [selectedContactId])

  // Load seller's listing or buyer's transaction
  useEffect(() => {
    if (!selectedContactId || !selectedContact) {
      setRelatedListing(null)
      setRelatedTransaction(null)
      return
    }

    const supabase = createClient()

    // Load related listing for any seller-type contact (was previously gated on
    // exact persona "Listing Seller" which most sellers don't have).
    // Schema: listings.zip (NOT zipcode) — old query failed silently.
    const isSellerType =
      (selectedContact.contact_type ?? "").toLowerCase().includes("seller") ||
      (selectedContact.contact_persona ?? "").toLowerCase().includes("seller")

    if (isSellerType) {
      supabase
        .from("listings")
        .select("id, address, city, state, zip, status, list_price")
        .eq("seller_contact_id", selectedContactId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(({ data }: { data: any | null }) => setRelatedListing(data ?? null))
        .catch(() => setRelatedListing(null))
    } else {
      setRelatedListing(null)
    }

    // Related transaction — buyer or seller side.
    // Schema: transactions.purchase_price + close_date (NOT total_value /
    // expected_close_date — old query failed silently and always set null).
    supabase
      .from("transactions")
      .select("id, property_address, stage, status, purchase_price, close_date")
      .or(`buyer_contact_id.eq.${selectedContactId},seller_contact_id.eq.${selectedContactId}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }: { data: any | null }) => setRelatedTransaction(data ?? null))
      .catch(() => setRelatedTransaction(null))
  }, [selectedContactId, selectedContact])

  // Server-side search: debounce input and call getContacts with the search term.
  // This replaces the old client-side .filter() that was capped at the 100 loaded records.
  const handleSearchChange = useCallback((query: string) => {
    setSearch(query)
    searchQueryRef.current = query

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current)
    }

    searchGenRef.current += 1
    const gen = searchGenRef.current

    searchDebounceRef.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const result = await getContacts({ search: query || undefined, limit: 100 })
        if (gen !== searchGenRef.current) return  // stale — ignore
        if (result.success) {
          setFiltered(result.contacts)
        }
      } catch {
        // non-blocking — leave current list intact on error
      } finally {
        if (gen === searchGenRef.current) setSearchLoading(false)
      }
    }, 300)
  }, [])

  // ── Add Contact dialog state ────────────────────────────────────────────────
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addForm, setAddForm] = useState({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    city: "",
    state: "",
    zip_code: "",
    contact_type: "buyer" as "buyer" | "seller" | "both" | "investor",
    status: "new",
  })
  const [addFormError, setAddFormError] = useState<string | null>(null)
  const [addFormSubmitting, setAddFormSubmitting] = useState(false)

  const handleOpenAddDialog = () => {
    setAddForm({ first_name: "", last_name: "", email: "", phone: "", city: "", state: "", zip_code: "", contact_type: "buyer", status: "new" })
    setAddFormError(null)
    setAddDialogOpen(true)
  }

  const handleSubmitAddContact = async () => {
    setAddFormError(null)
    if (!addForm.first_name.trim()) { setAddFormError("First name is required"); return }
    if (!addForm.last_name.trim()) { setAddFormError("Last name is required"); return }
    setAddFormSubmitting(true)
    try {
      const result = await createContact({
        first_name: addForm.first_name.trim(),
        last_name: addForm.last_name.trim(),
        email: addForm.email.trim() || undefined,
        phone: addForm.phone.trim() || undefined,
        city: addForm.city.trim() || undefined,
        state: addForm.state.trim() || undefined,
        zip_code: addForm.zip_code.trim() || undefined,
        contact_type: addForm.contact_type,
        status: addForm.status,
      })
      if (!result.success) {
        setAddFormError(result.error ?? "Failed to create contact")
        return
      }
      setAddDialogOpen(false)
      toast.success(`${addForm.first_name} ${addForm.last_name} added`)
      await loadContacts()
      if (result.contact?.id) handleSelectContact(result.contact.id as string)
    } catch {
      setAddFormError("Unexpected error. Please try again.")
    } finally {
      setAddFormSubmitting(false)
    }
  }

  // Note: legacy handleEnableAutopilot / handleToggleAutopilot were removed.
  // AI engagement is now controlled exclusively through AIPilotControl ->
  // setContactAIPilot(), which writes contacts.ai_autopilot_level (single
  // source of truth). The old enableAIPilot() action wrote to a separate
  // ai_autopilot_plans table that never synced and always returned
  // Unauthorized due to a user.id vs agents.id comparison mismatch.


  const handleShareSocialPost = async () => {
    if (!selectedContactId) return
    
    try {
      const result = await shareSocialPostWithSeller(selectedContactId)
      if (result.success) {
        toast.success("Social post shared with seller via portal")
      } else {
        toast.error(result.error || "Failed to share social post")
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to share social post")
    }
  }

  const handleLoadDraft = async (conversationId?: string) => {
    if (!selectedContactId || !agentId) return
    const result = await generateAIDraft({
      contactId: selectedContactId,
      agentId,
      conversationId,
    })
    if (result.success && result.draft) {
      setPendingDraftText(result.draft)
    } else if (result.error) {
      toast.error(result.error)
    }
  }

  const handleGenerateReferralAsk = async () => {
    if (!selectedContactId || !agentId) return
    setReferralGenerating(true)
    try {
      const result = await aiOptimizeReferralAsk({ contactId: selectedContactId, agentId })
      if (result?.success) {
        toast.success("Referral ask strategy generated")
      } else {
        toast.error((result as any)?.error ?? "Failed to generate referral ask")
      }
    } catch {
      toast.error("Failed to generate referral ask")
    } finally {
      setReferralGenerating(false)
    }
  }

  const handleSaveNote = async (note: string) => {
    if (!selectedContactId) return
    const noteContactId = selectedContactId
    setNoteSaving(true)
    try {
      const result = await addContactNote(noteContactId, note)
      if (result.success) {
        toast.success("Note saved")
        // Only update activity feed if the same contact is still selected
        if (selectedContactId !== noteContactId) return
        setContactActivities(prev => [{
          id: Date.now().toString(),
          activity_type: "note",
          title: "Note",
          description: note,
          notes: note,
          created_at: new Date().toISOString(),
          contact_id: noteContactId,
        }, ...prev])
      } else {
        toast.error(result.error ?? "Failed to save note")
      }
    } catch {
      toast.error("Failed to save note")
    } finally {
      setNoteSaving(false)
    }
  }

  const handleSelectContact = (contactId: string) => {
    setSelectedContactId(contactId)
    router.push(`/crm?contact=${contactId}`, { scroll: false })
  }

  const handleBackToList = () => {
    setSelectedContactId(null)
    setSelectedContact(null)
    router.push("/crm", { scroll: false })
  }

  const handleAnalyzeCall = async (activity: any) => {
    if (!selectedContactId || !user) return
    setAnalyzingCallId(activity.id)
    try {
      const result = await analyzeCallTranscript({
        transcript: activity.description || activity.notes || activity.title || "Call activity",
        contactId: selectedContactId,
        agentId: agentId ?? user.id,
        callType: activity.direction === "inbound" ? "inbound" : "outbound",
      })
      if (result.success && result.analysis) {
        setCallAnalyses(prev => ({ ...prev, [activity.id]: result.analysis }))
      } else {
        toast.error("Could not analyze call")
      }
    } finally {
      setAnalyzingCallId(null)
    }
  }

  const handleCallSummaryEmail = async (activity: any) => {
    if (!user) return
    const analysis = callAnalyses[activity.id]
    if (!analysis?.id) return
    const result = await generateCallSummaryEmail({
      analysisId: analysis.id,
      recipientType: "client",
      agentId: agentId ?? user.id,
    })
    if ((result as any).success) {
      toast.success("Summary email drafted")
    } else {
      toast.error("Could not generate summary email")
    }
  }

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    )
  }

  // Contact Detail View — show spinner immediately when a contact is selected, even before data loads
  if (selectedContactId && !selectedContact && detailLoading) {
    return (
      <div className="p-6">
        <Button variant="ghost" size="sm" onClick={handleBackToList} className="mb-6">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Contacts
        </Button>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      </div>
    )
  }

  if (selectedContactId && selectedContact) {
    const isBuyerContact =
      selectedContact.contact_type?.toLowerCase().includes("buyer") ||
      !!selectedContact.buyer_stage

    // A contact is a candidate for a listing consultation if they are a seller
    // OR a generic 'contact' (no specific type assigned yet) — not a confirmed
    // buyer. The plan keeps this scheduler on the contact card because no
    // listing record exists yet at this stage.
    const ct = selectedContact.contact_type?.toLowerCase() ?? ""
    const isListingCandidate =
      ct.includes("seller") ||
      ct === "" ||
      ct === "contact" ||
      ct === "lead" ||
      ct === "both"

    const daysSinceContact = selectedContact.last_contacted_at
      ? Math.floor(
          (Date.now() - new Date(selectedContact.last_contacted_at).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : null

    // Derived: message temperature from conversation sentiment for RelationshipRadar
    const messageTemperature: "hot" | "warm" | "cold" | null =
      conversationIntelligence?.sentiment_score != null
        ? conversationIntelligence.sentiment_score >= 0.6
          ? "hot"
          : conversationIntelligence.sentiment_score >= 0.4
          ? "warm"
          : "cold"
        : null

    // Derived: value metrics from contact activities for ValueDeliveredPanel
    const valueMetrics = {
      milestonesCompleted: contactActivities.filter(
        (a: any) =>
          a.activity_type === "milestone_completed" ||
          a.activity_type === "transaction_closed"
      ).length,
      contentSent: contactActivities.filter(
        (a: any) =>
          a.activity_type === "video_sent" ||
          a.activity_type === "email_sent" ||
          a.activity_type === "content_shared"
      ).length,
      showingsArranged: contactActivities.filter(
        (a: any) => a.activity_type === "showing" || a.activity_type === "showing_scheduled"
      ).length,
      offersSubmitted: contactActivities.filter(
        (a: any) => a.activity_type === "offer_submitted"
      ).length,
      trustCapitalScore: selectedContact.engagement_score ?? undefined,
    }

    return (
      <div className="flex flex-col h-full min-h-0">
        {/* Back button */}
        <div className="px-4 pt-3 pb-2 border-b shrink-0">
          <Button variant="ghost" size="sm" onClick={handleBackToList}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Contacts
          </Button>
        </div>

        {detailLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* Consolidated Contact Header — replaces the old gradient
                ContactCommandStrip and absorbs the redundant sidebar identity
                area. Single home for: identity, contact info, source/last touch,
                action buttons (Call/SMS/Email/Portal/Note), AI Pilot dropdown,
                channel suppression toggles. */}
            <div className="shrink-0 px-4 pt-3">
              <ContactHeaderCard
                contact={selectedContact}
                agentId={agentId || ""}
                brokerageId={brokerageId || ""}
                daysSinceContact={daysSinceContact}
                churnRisk={churnRisk}
                aiPilotLevel={
                  ((contactIntelligence as any)?.ai_autopilot_level ?? null) ||
                  (contactIntelligence?.ai_isa_enabled ? "moderate" : "off")
                }
                onAIPilotChange={(level) => {
                  setContactIntelligence((prev: any) =>
                    prev
                      ? { ...prev, ai_autopilot_level: level, ai_isa_enabled: level !== "off" }
                      : prev
                  )
                }}
                onAddNote={() => setActiveTab("comms")}
                onSendSMS={() => { setSmsText(""); setSmsDialogOpen(true) }}
                onSendEmail={() => setActiveTab("comms")}
                onShareSocialPost={handleShareSocialPost}
                onChannelToggle={async (channel, optOut) => {
                  const supabase = createClient()
                  const col =
                    channel === "email"       ? "email_opt_out" :
                    channel === "sms"         ? "sms_opt_out" :
                    channel === "phone"       ? "phone_opt_out" :
                                                "direct_mail_opt_out"
                  await supabase.from("contacts").update({ [col]: optOut }).eq("id", selectedContactId)
                  if (selectedContactId) loadContactDetail(selectedContactId)
                }}
              />
            </div>

            {/* Two-panel body: sticky sidebar + scrollable tab area */}
            <div className="flex flex-1 min-h-0 overflow-hidden mt-4">

              {/* ── LEFT SIDEBAR — slim deep-link rail.
                   Identity, contact info, portal link, AI Pilot, channel toggles,
                   and the Call/SMS/Email/Note buttons all live in the
                   ContactHeaderCard above. This sidebar only holds:
                     - Active Deal (related listing/transaction)
                     - Quick deep-links that open dialogs or other routes
                ── */}
              <aside className="w-64 shrink-0 border-r bg-muted/20 flex flex-col overflow-y-auto px-4 py-4 gap-4">
                {/* Portal invite status — small banner at top */}
                {portalInviteData?.status && (
                  <div className="rounded-md border bg-background px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Portal</p>
                    <p className="text-xs font-medium capitalize text-foreground">
                      {portalInviteData.status === "not_invited" ? "Not invited yet" : portalInviteData.status}
                    </p>
                  </div>
                )}

                {/* Quick Actions */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Quick Actions</p>
                  <Link href={
                    `/dashboard/listings?action=new` +
                    `&contactId=${encodeURIComponent(selectedContactId ?? "")}` +
                    `&firstName=${encodeURIComponent(selectedContact?.first_name ?? "")}` +
                    `&lastName=${encodeURIComponent(selectedContact?.last_name ?? "")}` +
                    `&email=${encodeURIComponent(selectedContact?.email ?? "")}` +
                    `&phone=${encodeURIComponent(selectedContact?.phone ?? "")}`
                  }>
                    <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs justify-start">
                      <Home className="h-3.5 w-3.5" />
                      Create Listing
                    </Button>
                  </Link>
                  <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs justify-start" onClick={() => setOfferWizardOpen(true)}>
                    <TrendingUp className="h-3.5 w-3.5" />
                    Create Offer
                  </Button>
                  {relatedTransaction ? (
                    <Link href={`/dashboard/transactions/${relatedTransaction.id}`}>
                      <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs justify-start">
                        <ExternalLink className="h-3.5 w-3.5" />
                        View Transaction
                      </Button>
                    </Link>
                  ) : (
                    <Link href={`/dashboard/transactions?contact=${selectedContactId}`}>
                      <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs justify-start">
                        <Building2 className="h-3.5 w-3.5" />
                        Start Transaction
                      </Button>
                    </Link>
                  )}
                  <Link href={`/dashboard/inbox?contact=${selectedContactId}`}>
                    <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs justify-start">
                      <MessageSquare className="h-3.5 w-3.5" />
                      Full Inbox
                    </Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full gap-1.5 text-xs justify-start"
                    onClick={async () => {
                      if (!selectedContactId || !user) return
                      // Agent-triggered scoring: mode='override' lets AI overwrite the lead_score baseline
                      const result = await scoreLeadWithAI({ contactId: selectedContactId, agentId: agentId ?? user.id, mode: "override" })
                      if (result.success && (result as any).scores) {
                        const overall = (result as any).scores.overallScore ?? 0
                        setLeadScores(prev => ({
                          ...prev,
                          [selectedContactId]: {
                            label: overall >= 60 ? "High" : "Medium",
                            score: overall,
                          },
                        }))
                        toast.success(`AI Score: ${overall}/100`)
                      } else {
                        toast.error("Scoring failed")
                      }
                    }}
                  >
                    <Star className="h-3.5 w-3.5" />
                    Run AI Score
                  </Button>
                  {(!portalInviteData?.status || portalInviteData.status === "not_invited") && brokerageId && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full gap-1.5 text-xs justify-start"
                      onClick={async () => {
                        if (!selectedContactId || !brokerageId || !user) return
                        // Suppression check — do not send magic link to opted-out or DNC contacts
                        if (
                          selectedContact?.dnc_status ||
                          selectedContact?.email_opt_out
                        ) {
                          toast.error("Cannot send portal invite: contact has opted out or is on the Do Not Contact list")
                          return
                        }
                        const result = await createPortalInviteForContact({
                          contactId: selectedContactId,
                          brokerageId,
                          invitedByUserId: user.id,
                          sendMagicLink: true,
                        })
                        if (result.success) {
                          setPortalInviteStatus("invited")
                          setPortalInviteData(prev => ({ ...prev, status: "invited", invited_at: new Date().toISOString() } as any))
                          toast.success("Portal invite sent")
                        } else {
                          toast.error(result.error ?? "Invite failed")
                        }
                      }}
                    >
                      <Send className="h-3.5 w-3.5" />
                      Send Portal Invite
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full gap-1.5 text-xs justify-start"
                    onClick={() => { setApptTitle(""); setApptDate(""); setApptTime(""); setApptDialogOpen(true) }}
                  >
                    <CalendarPlus className="h-3.5 w-3.5" />
                    Schedule Appointment
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full gap-1.5 text-xs justify-start"
                    onClick={async () => {
                      // Lazy-load sequences only when the agent opens the dialog
                      if (availableSequences.length === 0 && brokerageId) {
                        const res = await listCampaignSequences(brokerageId)
                        if (res.sequences) {
                          setAvailableSequences(res.sequences.map((s: any) => ({
                            id: s.id,
                            name: s.name,
                            sequence_type: s.sequence_type,
                          })))
                        }
                      }
                      setAutoDialogOpen(true)
                    }}
                  >
                    <Workflow className="h-3.5 w-3.5" />
                    Enroll in Workflow
                  </Button>
                </div>

                {/* SMS Dialog */}
                <Dialog open={smsDialogOpen} onOpenChange={setSmsDialogOpen}>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Send SMS</DialogTitle>
                    </DialogHeader>
                    <Textarea
                      placeholder="Type your SMS message (160 chars)"
                      maxLength={160}
                      value={smsText}
                      onChange={e => setSmsText(e.target.value)}
                      rows={3}
                    />
                    <p className="text-xs text-muted-foreground text-right">{smsText.length}/160</p>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setSmsDialogOpen(false)}>Cancel</Button>
                      <Button
                        disabled={!smsText.trim() || smsSending}
                        onClick={async () => {
                          if (!selectedContactId) return
                          setSmsSending(true)
                          const result = await sendSMS({ contactId: selectedContactId, message: smsText })
                          setSmsSending(false)
                          if (result.success) { toast.success("SMS sent"); setSmsDialogOpen(false) }
                          else toast.error((result as any).error ?? "SMS failed")
                        }}
                      >
                        {smsSending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                        Send
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Schedule Appointment Dialog */}
                <Dialog open={apptDialogOpen} onOpenChange={setApptDialogOpen}>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Schedule Appointment</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                      <div>
                        <Label className="text-xs">Title</Label>
                        <Input value={apptTitle} onChange={e => setApptTitle(e.target.value)} placeholder="Listing consultation" className="mt-1" />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs">Date</Label>
                          <Input type="date" value={apptDate} onChange={e => setApptDate(e.target.value)} className="mt-1" />
                        </div>
                        <div>
                          <Label className="text-xs">Time</Label>
                          <Input type="time" value={apptTime} onChange={e => setApptTime(e.target.value)} className="mt-1" />
                        </div>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setApptDialogOpen(false)}>Cancel</Button>
                      <Button
                        disabled={!apptTitle || !apptDate || !apptTime || apptSending}
                        onClick={async () => {
                          if (!selectedContactId) return
                          setApptSending(true)
                          const startIso = new Date(`${apptDate}T${apptTime}`).toISOString()
                          const endIso = new Date(new Date(`${apptDate}T${apptTime}`).getTime() + 60 * 60 * 1000).toISOString()
                          const result = await scheduleAppointment({
                            contactId: selectedContactId,
                            calendarId: "default",
                            title: apptTitle,
                            startTime: startIso,
                            endTime: endIso,
                            meetingType: "in_person",
                          })
                          setApptSending(false)
                          if (result.success) { toast.success("Appointment scheduled"); setApptDialogOpen(false) }
                          else toast.error((result as any).error ?? "Scheduling failed")
                        }}
                      >
                        {apptSending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                        Schedule
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Enroll in Workflow Dialog — picks an existing campaign sequence
                    built in the Workflow Builder and enrolls THIS contact. Replaces
                    the old free-text "GHL Workflow ID" dialog (legacy code; we no
                    longer trigger GHL workflows from the contact card). */}
                <Dialog open={autoDialogOpen} onOpenChange={setAutoDialogOpen}>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Enroll in Workflow</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        Pick a workflow built in the Workflow Builder. The contact will be
                        enrolled and start receiving its first step.
                      </p>
                      {availableSequences.length === 0 ? (
                        <div className="rounded-lg border bg-muted/30 px-3 py-4 text-center space-y-2">
                          <p className="text-sm text-muted-foreground">
                            No workflows built yet for this brokerage.
                          </p>
                          <Link href="/dashboard/campaigns/workflows" target="_blank">
                            <Button size="sm" variant="outline" className="gap-1.5">
                              <Workflow className="h-3.5 w-3.5" />
                              Open Workflow Builder
                            </Button>
                          </Link>
                        </div>
                      ) : (
                        <Select value={autoWorkflowId} onValueChange={setAutoWorkflowId}>
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a workflow" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableSequences.map((s: any) => (
                              <SelectItem key={s.id} value={s.id}>
                                {s.name}
                                {s.sequence_type ? ` · ${s.sequence_type}` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                    <DialogFooter className="gap-2 flex-wrap">
                      <Button variant="outline" onClick={() => setAutoDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Link href="/dashboard/campaigns/workflows" target="_blank">
                        <Button variant="ghost" size="sm" className="gap-1.5">
                          <Workflow className="h-3.5 w-3.5" />
                          Build new workflow
                        </Button>
                      </Link>
                      <Button
                        disabled={!autoWorkflowId || autoSending || availableSequences.length === 0}
                        onClick={async () => {
                          if (!selectedContactId || !autoWorkflowId) return
                          setAutoSending(true)
                          const result = await enrollContactInSequence({
                            contactId: selectedContactId,
                            sequenceId: autoWorkflowId,
                          })
                          setAutoSending(false)
                          if (result.enrollment) {
                            toast.success("Contact enrolled in workflow")
                            setAutoDialogOpen(false)
                            setAutoWorkflowId("")
                          } else {
                            toast.error((result as any).error ?? "Enrollment failed")
                          }
                        }}
                      >
                        {autoSending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                        Enroll
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Related listing/transaction in sidebar */}
                {(relatedListing || relatedTransaction) && (
                  <>
                    <Separator />
                    <div className="space-y-2 text-xs">
                      <p className="font-medium text-muted-foreground uppercase tracking-wide">Active Deal</p>
                      {relatedListing && (
                        <div className="rounded-md border bg-background p-2 space-y-1">
                          <p className="font-medium text-foreground leading-tight">{relatedListing.address}</p>
                          <p className="text-muted-foreground">{relatedListing.city}, {relatedListing.state}</p>
                          {relatedListing.list_price && (
                            <p className="font-semibold text-foreground">${relatedListing.list_price.toLocaleString()}</p>
                          )}
                          <Link href={`/dashboard/listings/${relatedListing.id}`}>
                            <Button size="sm" variant="outline" className="w-full text-xs mt-1">
                              View Listing
                            </Button>
                          </Link>
                        </div>
                      )}
                      {relatedTransaction && (
                        <div className="rounded-md border bg-background p-2 space-y-1">
                          <p className="font-medium text-foreground leading-tight">{relatedTransaction.property_address}</p>
                          <Badge variant="outline" className="text-xs capitalize">
                            {relatedTransaction.stage?.replace(/_/g, " ")}
                          </Badge>
                          <Link href={`/dashboard/transactions/${relatedTransaction.id}`}>
                            <Button size="sm" variant="outline" className="w-full text-xs mt-1">
                              View Transaction
                            </Button>
                          </Link>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </aside>

              {/* ── RIGHT AREA — tabbed content ── */}
              <main className="flex-1 min-w-0 overflow-y-auto px-4 py-4">
                {/* AI ISA Handoff Brief — shown when this contact was qualified
                    and assigned by the AI ISA. Pulled from contacts.isa_handoff_brief. */}
                {(selectedContact as { isa_handoff_brief?: IsaHandoffBriefShape | null })?.isa_handoff_brief && (
                  <div className="mb-4">
                    <QualificationSummaryCard
                      brief={(selectedContact as { isa_handoff_brief?: IsaHandoffBriefShape | null }).isa_handoff_brief}
                      contactName={`${selectedContact.first_name ?? ""} ${selectedContact.last_name ?? ""}`.trim() || "Contact"}
                      handoffAt={(selectedContact as { isa_handoff_at?: string | null }).isa_handoff_at ?? null}
                      onSchedule={() => setActiveTab("comms")}
                      onSendMessage={() => setActiveTab("comms")}
                      onViewFullProfile={() => setActiveTab("overview")}
                    />
                  </div>
                )}
                <Tabs
                  value={activeTab}
                  onValueChange={(tab) => {
                    setActiveTab(tab)
                    if (tab === "journey" && selectedContactId && !journeyTeamLoaded && !journeyTeamLoading) {
                      loadJourneyTeam(selectedContactId)
                    }
                  }}
                >
                  <TabsList className="w-full justify-start mb-4 h-9 bg-muted/50 overflow-x-auto flex-wrap">
                    <TabsTrigger value="overview" className="text-xs gap-1.5">
                      <LayoutDashboard className="h-3.5 w-3.5" />
                      Overview
                    </TabsTrigger>
                    <TabsTrigger value="journey" className="text-xs gap-1.5">
                      <Network className="h-3.5 w-3.5" />
                      Journey &amp; Team
                    </TabsTrigger>
                    <TabsTrigger value="copilot" className="text-xs gap-1.5">
                      <Sparkles className="h-3.5 w-3.5" />
                      AI Copilot
                    </TabsTrigger>
                    <TabsTrigger value="comms" className="text-xs gap-1.5">
                      <MessageSquare className="h-3.5 w-3.5" />
                      Communications
                    </TabsTrigger>
                    <TabsTrigger value="portal" className="text-xs gap-1.5">
                      <Globe className="h-3.5 w-3.5" />
                      Portal
                    </TabsTrigger>
                    <TabsTrigger value="credit" className="text-xs gap-1.5">
                      <CreditCard className="h-3.5 w-3.5" />
                      Credit
                    </TabsTrigger>
                    <TabsTrigger value="videos" className="text-xs gap-1.5">
                      <Video className="h-3.5 w-3.5" />
                      Videos
                    </TabsTrigger>
                    <TabsTrigger value="transactions" className="text-xs gap-1.5">
                      <FileText className="h-3.5 w-3.5" />
                      Transactions
                    </TabsTrigger>
                    {isBuyerContact && (
                      <TabsTrigger value="properties" className="text-xs gap-1.5">
                        <Home className="h-3.5 w-3.5" />
                        Properties
                      </TabsTrigger>
                    )}
                    <TabsTrigger value="activity" className="text-xs gap-1.5">
                      <Activity className="h-3.5 w-3.5" />
                      Activity
                    </TabsTrigger>
                    <TabsTrigger value="intelligence" className="text-xs gap-1.5">
                      <Brain className="h-3.5 w-3.5" />
                      Intelligence
                    </TabsTrigger>
                    {isBuyerContact && (
                      <TabsTrigger value="finance" className="text-xs gap-1.5">
                        <DollarSign className="h-3.5 w-3.5" />
                        Finance
                      </TabsTrigger>
                    )}
                    <TabsTrigger value="closing" className="text-xs gap-1.5">
                      <CheckSquare className="h-3.5 w-3.5" />
                      Closing
                    </TabsTrigger>
                  </TabsList>

                  {/* ── OVERVIEW TAB ── */}
                  <TabsContent value="overview" className="space-y-4 mt-0">
                    {/* Workflow OS quick actions — buyer intake link, etc.
                        Renders as a compact row above existing pulse panel. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <SendBuyerIntakeButton
                        contactId={selectedContact.id}
                        contactName={`${selectedContact.first_name ?? ""} ${selectedContact.last_name ?? ""}`.trim() || null}
                        contactEmail={selectedContact.email ?? null}
                      />
                    </div>
                    {/* Pulse — single consolidated relationship-health card */}
                    <ContactPulsePanel
                      engagementScore={selectedContact.engagement_score}
                      daysSinceContact={daysSinceContact}
                      messageTemperature={messageTemperature}
                      referralPotential={selectedContact.referral_potential}
                      openThreadCount={conversations.length}
                      lastContactedAt={selectedContact.last_contacted_at ?? null}
                      onGenerateReferralAsk={handleGenerateReferralAsk}
                      generatingReferralAsk={referralGenerating}
                      onOpenInbox={() =>
                        router.push(`/dashboard/inbox?contact=${selectedContactId}`)
                      }
                    />

                    {/* Listing consultation CTA when applicable */}
                    {isListingCandidate && agentId && brokerageId && (
                      <div className="flex flex-wrap gap-2">
                        <ListingConsultationScheduler
                          contactId={selectedContactId}
                          contactName={`${selectedContact.first_name ?? ""} ${selectedContact.last_name ?? ""}`.trim()}
                          agentId={agentId}
                          brokerageId={brokerageId}
                        />
                      </div>
                    )}

                    {/* Buyer readiness signals — only when relevant */}
                    {isBuyerContact && (buyerInsights || fatigueData) && (
                      <div className="rounded-lg border bg-blue-50/50 px-3 py-2 space-y-1">
                        {fatigueData && (
                          <div className={cn("rounded px-2 py-1 text-xs",
                            fatigueData.risk_level === "critical" ? "bg-red-100 text-red-800" :
                            fatigueData.risk_level === "high"     ? "bg-orange-100 text-orange-800" :
                            fatigueData.risk_level === "moderate" ? "bg-amber-100 text-amber-800" :
                                                                    "bg-green-100 text-green-800"
                          )}>
                            <p className="font-medium capitalize">{fatigueData.risk_level} Fatigue Risk</p>
                            <p className="mt-0.5">
                              Score: {fatigueData.fatigue_score}/100 &middot; {fatigueData.days_searching}d searching &middot; {fatigueData.total_showings} showings
                            </p>
                          </div>
                        )}
                        {buyerInsights?.prediction && (
                          <div className="space-y-0.5 text-xs">
                            {buyerInsights.prediction.predicted_ready_to_offer && (
                              <p className="text-green-700 font-medium">Ready to make an offer</p>
                            )}
                            {buyerInsights.prediction.predicted_next_action && (
                              <p className="text-blue-700">Predicted next: {buyerInsights.prediction.predicted_next_action}</p>
                            )}
                            {buyerInsights.prediction.engagement_velocity && (
                              <p className="text-muted-foreground capitalize">Engagement: {buyerInsights.prediction.engagement_velocity}</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Next Best Actions — sole authority for suggested actions */}
                    <NextBestActionPanel
                      suggestedActions={suggestedActions}
                      contactId={selectedContactId}
                      contactPhone={selectedContact.phone}
                      contactEmail={selectedContact.email}
                      onSendMessage={(channel) =>
                        router.push(`/dashboard/inbox?contact=${selectedContactId}&channel=${channel}`)
                      }
                      onLogActivity={() =>
                        router.push(`/dashboard/inbox?contact=${selectedContactId}&action=note`)
                      }
                      onOpenPortal={() => router.push(`/portal/${selectedContactId}`)}
                      onCreateOffer={() => setOfferWizardOpen(true)}
                    />

                    {/* Value delivered + Timeline context — combined into a single grid */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <ValueDeliveredPanel
                        contactId={selectedContactId}
                        agentId={agentId || ""}
                        valueMetrics={valueMetrics}
                      />
                      <TimelineContextPanel
                        contactId={selectedContactId}
                        originalLeadSource={selectedContact.lead_source}
                        createdAt={selectedContact.created_at}
                        isaHandoffContext={isaHandoffContext}
                      />
                    </div>
                  </TabsContent>

                  {/* ── JOURNEY & TEAM TAB ── */}
                  <TabsContent value="journey" className="space-y-4 mt-0">
                    {journeyTeamLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                        <span className="ml-2 text-sm text-muted-foreground">Loading deal data...</span>
                      </div>
                    ) : journeyTeamError ? (
                      <div className="py-8 text-center space-y-2">
                        <p className="text-sm text-destructive">{journeyTeamError}</p>
                        <Button size="sm" variant="outline" onClick={() => { if (selectedContactId) loadJourneyTeam(selectedContactId, true) }}>
                          Retry
                        </Button>
                      </div>
                    ) : !journeyTeamData || journeyTeamData.transactionId === null ? (
                      <div className="py-8 text-center space-y-3">
                        <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mx-auto">
                          <Users className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div className="space-y-1">
                          <p className="text-sm font-medium">No active transaction</p>
                          <p className="text-xs text-muted-foreground max-w-xs mx-auto">
                            Journey &amp; team details will appear here once a transaction is started for this contact — milestones, deal team, lenders, and vendors.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (selectedContactId) router.push(`/dashboard/transactions?contactId=${encodeURIComponent(selectedContactId)}`)
                          }}
                        >
                          Start a Transaction
                        </Button>
                      </div>
                    ) : journeyTeamData.milestones.length === 0 && journeyTeamData.dealTeam.length === 0 && journeyTeamData.lenders.length === 0 && journeyTeamData.vendors.length === 0 && journeyTeamData.timeline.length === 0 ? (
                      <div className="py-8 text-center space-y-2">
                        <p className="text-sm font-medium">Transaction in progress</p>
                        <p className="text-xs text-muted-foreground">Milestones and team details will appear here as the deal progresses.</p>
                      </div>
                    ) : (
                      <>
                        {/* Milestone progress */}
                        {journeyTeamData.milestones.length > 0 && (
                          <Card>
                            <CardHeader className="pb-2">
                              <CardTitle className="text-sm">Transaction Milestones</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2">
                              {journeyTeamData.milestones.map((m: any) => (
                                <div key={m.id} className="flex items-center gap-3 text-sm">
                                  <div className={cn("w-2 h-2 rounded-full shrink-0",
                                    m.status === "completed" ? "bg-green-500" :
                                    m.status === "in_progress" ? "bg-blue-500" :
                                    "bg-muted-foreground/30"
                                  )} />
                                  <span className={cn("flex-1 truncate", m.status === "completed" && "line-through text-muted-foreground")}>
                                    {m.milestone_name}
                                  </span>
                                  {m.target_date && (
                                    <span className="text-xs text-muted-foreground shrink-0">
                                      {format(new Date(m.target_date), "MMM d")}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </CardContent>
                          </Card>
                        )}

                        {/* Who's on This Deal */}
                        {(journeyTeamData.dealTeam.length > 0 || journeyTeamData.lenders.length > 0 || journeyTeamData.vendors.length > 0) && (
                          <Card>
                            <CardHeader className="pb-2">
                              <CardTitle className="text-sm flex items-center gap-2">
                                <Users className="h-4 w-4 text-primary" />
                                {"Who's on This Deal"}
                              </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-3">
                              {journeyTeamData.lenders.map((l: any) => (
                                <div key={l.id} className="flex items-start justify-between gap-3 p-2 rounded-lg border bg-muted/20">
                                  <div className="space-y-0.5">
                                    <div className="flex items-center gap-1.5">
                                      <Badge variant="outline" className="text-xs">Lender</Badge>
                                      <span className="text-sm font-medium">{l.loan_officer_name ?? l.lender_name}</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">{l.lender_name}</p>
                                    {l.underwriting_status && (
                                      <p className="text-xs text-blue-600 capitalize">{l.underwriting_status.replace(/_/g, " ")}</p>
                                    )}
                                  </div>
                                  <div className="flex gap-1.5 shrink-0">
                                    {l.loan_officer_phone && (
                                      <a href={`tel:${l.loan_officer_phone}`}>
                                        <Button size="icon" variant="ghost" className="h-7 w-7">
                                          <Phone className="h-3.5 w-3.5" />
                                        </Button>
                                      </a>
                                    )}
                                    {l.loan_officer_email && (
                                      <a href={`mailto:${l.loan_officer_email}`}>
                                        <Button size="icon" variant="ghost" className="h-7 w-7">
                                          <Mail className="h-3.5 w-3.5" />
                                        </Button>
                                      </a>
                                    )}
                                  </div>
                                </div>
                              ))}
                              {journeyTeamData.dealTeam.map((m: any) => (
                                <div key={m.id} className="flex items-start justify-between gap-3 p-2 rounded-lg border bg-muted/20">
                                  <div className="space-y-0.5">
                                    <div className="flex items-center gap-1.5">
                                      <Badge variant="outline" className="text-xs capitalize">{m.member_type?.replace(/_/g, " ") ?? "Team"}</Badge>
                                      <span className="text-sm font-medium">{m.name}</span>
                                    </div>
                                    {m.company && <p className="text-xs text-muted-foreground">{m.company}</p>}
                                  </div>
                                  <div className="flex gap-1.5 shrink-0">
                                    {m.phone && (
                                      <a href={`tel:${m.phone}`}>
                                        <Button size="icon" variant="ghost" className="h-7 w-7">
                                          <Phone className="h-3.5 w-3.5" />
                                        </Button>
                                      </a>
                                    )}
                                    {m.email && (
                                      <a href={`mailto:${m.email}`}>
                                        <Button size="icon" variant="ghost" className="h-7 w-7">
                                          <Mail className="h-3.5 w-3.5" />
                                        </Button>
                                      </a>
                                    )}
                                  </div>
                                </div>
                              ))}
                              {journeyTeamData.vendors.map((v: any) => {
                                const vendor = (v as any).vendors
                                return (
                                  <div key={v.id} className="flex items-start justify-between gap-3 p-2 rounded-lg border bg-muted/20">
                                    <div className="space-y-0.5">
                                      <div className="flex items-center gap-1.5">
                                        <Badge variant="outline" className="text-xs capitalize">{v.role ?? vendor?.category ?? "Vendor"}</Badge>
                                        <span className="text-sm font-medium">{vendor?.name}</span>
                                      </div>
                                      {vendor?.category && <p className="text-xs text-muted-foreground capitalize">{vendor.category}</p>}
                                    </div>
                                    <div className="flex gap-1.5 shrink-0">
                                      {vendor?.phone && (
                                        <a href={`tel:${vendor.phone}`}>
                                          <Button size="icon" variant="ghost" className="h-7 w-7">
                                            <Phone className="h-3.5 w-3.5" />
                                          </Button>
                                        </a>
                                      )}
                                      {vendor?.email && (
                                        <a href={`mailto:${vendor.email}`}>
                                          <Button size="icon" variant="ghost" className="h-7 w-7">
                                            <Mail className="h-3.5 w-3.5" />
                                          </Button>
                                        </a>
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                            </CardContent>
                          </Card>
                        )}

                        {/* Recent activity */}
                        {journeyTeamData.timeline.length > 0 && (
                          <Card>
                            <CardHeader className="pb-2">
                              <CardTitle className="text-sm">Recent Activity</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2">
                              {journeyTeamData.timeline.map((e: any) => (
                                <div key={e.id} className="flex gap-2 text-sm">
                                  <div className="w-1.5 h-1.5 rounded-full bg-primary/50 mt-2 shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium capitalize">{e.activity_type?.replace(/_/g, " ")}</p>
                                    {e.description && <p className="text-xs text-muted-foreground truncate">{e.description}</p>}
                                    <p className="text-xs text-muted-foreground">{e.created_at ? format(new Date(e.created_at), "MMM d, h:mm a") : ""}</p>
                                  </div>
                                </div>
                              ))}
                            </CardContent>
                          </Card>
                        )}
                      </>
                    )}
                  </TabsContent>

                  {/* ── AI COPILOT TAB ── */}
                  <TabsContent value="copilot" className="space-y-4 mt-0">
                    {/* Conversation Intelligence */}
                    {conversationIntelligence && (
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Brain className="h-4 w-4 text-violet-500" />
                            Conversation Intelligence
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {conversationIntelligence.sentiment_score != null && (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-muted-foreground">Sentiment</span>
                                <span className={cn("font-medium",
                                  conversationIntelligence.sentiment_score >= 0.6 ? "text-green-600" :
                                  conversationIntelligence.sentiment_score >= 0.4 ? "text-amber-600" :
                                  "text-red-600"
                                )}>
                                  {conversationIntelligence.sentiment_label ?? (
                                    conversationIntelligence.sentiment_score >= 0.6 ? "Positive" :
                                    conversationIntelligence.sentiment_score >= 0.4 ? "Neutral" : "Negative"
                                  )}
                                </span>
                              </div>
                              <Progress value={Math.round(conversationIntelligence.sentiment_score * 100)} className="h-1.5" />
                            </div>
                          )}
                          {conversationIntelligence.key_topics?.length > 0 && (
                            <div>
                              <p className="text-xs text-muted-foreground mb-1.5">Key Topics</p>
                              <div className="flex flex-wrap gap-1">
                                {conversationIntelligence.key_topics.slice(0, 4).map((t: string, i: number) => (
                                  <Badge key={i} variant="secondary" className="text-xs">{t}</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {conversationIntelligence.next_step_suggestion && (
                            <p className="text-xs bg-violet-50 border border-violet-100 text-violet-700 rounded px-2 py-1.5">
                              {conversationIntelligence.next_step_suggestion}
                            </p>
                          )}
                          {conversationIntelligence.buying_signals?.length > 0 && (
                            <div className="flex items-start gap-1.5 text-xs text-green-700">
                              <TrendingUp className="h-3 w-3 mt-0.5 shrink-0" />
                              <span>{conversationIntelligence.buying_signals[0]}</span>
                            </div>
                          )}
                          {conversationIntelligence.objections?.length > 0 && (
                            <div className="flex items-start gap-1.5 text-xs text-amber-700">
                              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                              <span>{conversationIntelligence.objections[0]}</span>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    {/* AI Copilot Plan */}
                    <Card className="border-indigo-200">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Brain className="h-4 w-4 text-indigo-600" />
                          AI Copilot Plan
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        {loadingPlan ? (
                          <Skeleton className="h-16 w-full" />
                        ) : copilotPlan ? (
                          <div className="space-y-3">
                            <div className="rounded-lg bg-indigo-50 border border-indigo-200 p-3">
                              <p className="text-xs font-semibold text-indigo-700 mb-1">Next Action</p>
                              <p className="text-sm text-indigo-900">{copilotPlan.next_action}</p>
                              {copilotPlan.next_action_date && (
                                <p className="text-xs text-indigo-600 mt-1">
                                  Due: {format(new Date(copilotPlan.next_action_date), "EEE, MMM d")}
                                </p>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <Button size="sm" variant="outline" disabled={generatingPlan}
                                onClick={async () => {
                                  const supabase = createClient()
                                  await supabase.from("copilot_plans").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", copilotPlan.id)
                                  toast.success("Action marked done — generating next plan...")
                                  setGeneratingPlan(true)
                                  const result = await generateCopilotPlan(selectedContactId, agentId ?? "")
                                  if (result.success) { setCopilotPlan(result.plan ?? null) } else { toast.error("Failed to generate next plan") }
                                  setGeneratingPlan(false)
                                }}>Done</Button>
                              <Button size="sm" variant="ghost"
                                onClick={async () => {
                                  const supabase = createClient()
                                  const newDate = new Date(copilotPlan.next_action_date || new Date())
                                  newDate.setDate(newDate.getDate() + 3)
                                  await supabase.from("copilot_plans").update({ next_action_date: newDate.toISOString().split("T")[0] }).eq("id", copilotPlan.id)
                                  toast.success("Snoozed 3 days")
                                  setCopilotPlan({ ...copilotPlan, next_action_date: newDate.toISOString().split("T")[0] })
                                }}>Snooze 3d</Button>
                              <Button size="sm" variant="ghost" disabled={generatingPlan}
                                onClick={async () => {
                                  setGeneratingPlan(true)
                                  const result = await generateCopilotPlan(selectedContactId, agentId ?? "")
                                  if (result.success) { setCopilotPlan(result.plan ?? null); toast.success("Plan updated") } else { toast.error("Failed to generate plan") }
                                  setGeneratingPlan(false)
                                }}>
                                {generatingPlan ? <Loader2 className="h-3 w-3 animate-spin" /> : "Refresh"}</Button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <p className="text-sm text-muted-foreground">No active plan for this contact</p>
                            <Button size="sm" disabled={generatingPlan}
                              onClick={async () => {
                                setGeneratingPlan(true)
                                const result = await generateCopilotPlan(selectedContactId, agentId ?? "")
                                if (result.success) {
                                  setCopilotPlan(result.plan ?? null)
                                  if (brokerageId) {
                                    const supabase = createClient()
                                    const startDate = new Date(); const endDate = new Date(); endDate.setDate(endDate.getDate() + 7)
                                    await supabase.from("marketing_campaigns").insert({
                                      campaign_name: result.plan?.plan_name ?? `7-Day Follow-Up — ${selectedContact?.first_name ?? "Contact"}`,
                                      campaign_type: "omni", status: "live", brokerage_id: brokerageId,
                                      agent_user_id: user?.id ?? null, created_by: user?.id ?? null, visibility_scope: "agent",
                                      scheduled_start_at: startDate.toISOString(), scheduled_end_at: endDate.toISOString(),
                                      launched_at: startDate.toISOString(), target_audience: { contact_id: selectedContactId },
                                    }).select().maybeSingle()
                                  }
                                  toast.success("7-day plan created — check Campaigns tab")
                                } else { toast.error(result.error ?? "Failed to generate plan") }
                                setGeneratingPlan(false)
                              }}>
                              {generatingPlan ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Generating...</> : <><Sparkles className="h-4 w-4 mr-2" />Generate 7-Day Plan</>}
                            </Button>
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {/* AI-ISA stale contact takeover — uses unified pilot control */}
                    {(() => {
                      const daysSince = selectedContact.last_contacted_at
                        ? Math.floor((Date.now() - new Date(selectedContact.last_contacted_at).getTime()) / (1000 * 60 * 60 * 24))
                        : null
                      if (daysSince == null || daysSince <= 14) return null
                      const currentLevel: any =
                        (contactIntelligence as any)?.ai_autopilot_level ??
                        (contactIntelligence?.ai_isa_enabled ? "moderate" : "off")
                      return (
                        <Card className="border-orange-200 bg-orange-50">
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm flex items-center gap-2 text-orange-800">
                              <AlertTriangle className="h-4 w-4 text-orange-500" />
                              AI-ISA Available
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <p className="text-sm text-orange-700">
                              This contact has not been touched in {daysSince} day{daysSince !== 1 ? "s" : ""}.
                            </p>
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium text-orange-800">Enable AI follow-up</span>
                              <AIPilotControl
                                contactId={selectedContactId}
                                initialLevel={currentLevel}
                                compact
                                onChange={(level) => {
                                  setContactIntelligence((prev: any) =>
                                    prev
                                      ? { ...prev, ai_autopilot_level: level, ai_isa_enabled: level !== "off" }
                                      : prev
                                  )
                                }}
                              />
                            </div>
                            {currentLevel !== "off" && <p className="text-xs text-orange-600">AI follow-up is active on this contact</p>}
                          </CardContent>
                        </Card>
                      )
                    })()}

                    <RelationshipAiChatPanel
                      contactId={selectedContactId}
                      agentId={agentId || ""}
                      contactName={`${selectedContact.first_name} ${selectedContact.last_name}`}
                      contactPersona={selectedContact.contact_persona}
                    />

                    {agentId && (
                      <GratitudeGiftingPanel
                        agentId={agentId}
                        contactId={selectedContactId}
                        contactName={`${selectedContact.first_name} ${selectedContact.last_name}`}
                      />
                    )}
                  </TabsContent>

                  {/* ── COMMUNICATIONS TAB ── */}
                  <TabsContent value="comms" className="space-y-4 mt-0">
                    <CommunicationHealthPanel
                      conversations={conversations}
                      agentId={agentId || ""}
                      contactId={selectedContactId}
                      onLoadDraft={handleLoadDraft}
                      initialDraft={pendingDraftText}
                      onDraftConsumed={() => setPendingDraftText(null)}
                    />
                    <SmartNoteComposer
                      contactId={selectedContactId}
                      agentId={agentId || ""}
                      contactName={`${selectedContact.first_name} ${selectedContact.last_name}`}
                      onSaveNote={handleSaveNote}
                      saving={noteSaving}
                    />

                    {/* Activity feed — updates optimistically after note save */}
                    {contactActivities.length > 0 && (
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <FileText className="h-4 w-4 text-gray-500" />
                            Recent Activity
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {contactActivities.map((item: any) => {
                            const isCall = item.activity_type === "phone_call" || item.activity_type === "call" || item.activity_type === "outbound_call" || item.activity_type === "inbound_call"
                            const callAnalysis = callAnalyses[item.id]
                            return (
                              <div key={item.id} className="flex gap-3 pb-3 border-b last:border-0">
                                <div className="flex-shrink-0 w-2 h-2 mt-2 rounded-full bg-primary" />
                                <div className="flex-1 space-y-0.5">
                                  <div className="flex items-center justify-between">
                                    <span className="font-medium text-xs capitalize text-foreground">
                                      {(item.activity_type ?? "activity").replace(/_/g, " ")}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      {item.created_at ? format(new Date(item.created_at), "MMM d, h:mm a") : ""}
                                    </span>
                                  </div>
                                  {(item.description || item.notes || item.title) && (
                                    <p className="text-xs text-muted-foreground line-clamp-2">
                                      {item.description || item.notes || item.title}
                                    </p>
                                  )}
                                  {isCall && !callAnalysis && (
                                    <button
                                      onClick={() => handleAnalyzeCall(item)}
                                      disabled={analyzingCallId === item.id}
                                      className="text-[10px] mt-1 flex items-center gap-1 text-primary hover:underline disabled:opacity-60"
                                    >
                                      {analyzingCallId === item.id ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : (
                                        <Sparkles className="h-3 w-3" />
                                      )}
                                      Analyze Call
                                    </button>
                                  )}
                                  {callAnalysis && (
                                    <div className="mt-2 rounded-md bg-blue-50 border border-blue-200 p-2 text-xs space-y-1">
                                      <p className="font-medium text-blue-800">AI Call Summary</p>
                                      {callAnalysis.overall_summary && (
                                        <p className="text-blue-700">{callAnalysis.overall_summary}</p>
                                      )}
                                      {callAnalysis.action_items?.length > 0 && (
                                        <div>
                                          <p className="font-medium text-blue-800 mt-1">Action Items:</p>
                                          <ul className="list-disc list-inside space-y-0.5">
                                            {callAnalysis.action_items.slice(0, 3).map((a: any, i: number) => (
                                              <li key={i} className="text-blue-700">{typeof a === "string" ? a : a.action}</li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
                                      <button
                                        onClick={() => handleCallSummaryEmail(item)}
                                        className="mt-1 text-[10px] flex items-center gap-1 text-blue-700 hover:underline"
                                      >
                                        <MessageCircle className="h-3 w-3" />
                                        Send Summary Email
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </CardContent>
                      </Card>
                    )}
                  </TabsContent>

                  {/* ── PORTAL TAB ── */}
                  <TabsContent value="portal" className="space-y-4 mt-0">
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Globe className="h-4 w-4 text-primary" />
                          Client Portal
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                          Every contact has their own private portal. As the assigned agent, you have direct access.
                        </p>
                        <div className="grid grid-cols-2 gap-3 text-xs">
                          <div className="rounded-lg border bg-muted/20 p-3 space-y-1">
                            <p className="font-medium text-muted-foreground">Portal Status</p>
                            <p className={cn("font-semibold capitalize",
                              portalInviteData?.status === "accepted" ? "text-green-600" :
                              portalInviteData?.status === "invited"  ? "text-blue-600"  :
                              "text-muted-foreground"
                            )}>
                              {portalInviteData?.status ?? "Not yet invited"}
                            </p>
                          </div>
                          <div className="rounded-lg border bg-muted/20 p-3 space-y-1">
                            <p className="font-medium text-muted-foreground">Last Accessed</p>
                            <p className="font-semibold text-foreground">
                              {portalInviteData?.lastAccessed
                                ? format(new Date(portalInviteData.lastAccessed), "MMM d, yyyy")
                                : "Never"}
                            </p>
                          </div>
                          {portalInviteData?.invited_at && (
                            <div className="rounded-lg border bg-muted/20 p-3 space-y-1">
                              <p className="font-medium text-muted-foreground">Invite Sent</p>
                              <p className="font-semibold text-foreground">
                                {format(new Date(portalInviteData.invited_at), "MMM d, yyyy")}
                              </p>
                            </div>
                          )}
                          {portalInviteData?.accepted_at && (
                            <div className="rounded-lg border bg-muted/20 p-3 space-y-1">
                              <p className="font-medium text-muted-foreground">Accepted</p>
                              <p className="font-semibold text-green-600">
                                {format(new Date(portalInviteData.accepted_at), "MMM d, yyyy")}
                              </p>
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <Link href={`/portal/${selectedContactId}`} target="_blank" className="flex-1">
                            <Button className="w-full gap-1.5">
                              <Globe className="h-4 w-4" />
                              Open Client Portal
                            </Button>
                          </Link>
                          <Link href={`/portal/${selectedContactId}/documents`} target="_blank">
                            <Button variant="outline" className="gap-1.5">
                              <FileText className="h-4 w-4" />
                              Documents
                            </Button>
                          </Link>
                        </div>
                      </CardContent>
                    </Card>
                  </TabsContent>

                  {/* ── CREDIT TAB ── */}
                  <TabsContent value="credit" className="space-y-4 mt-0">
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm">Credit Pipeline Status</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {creditAccounts.length === 0 ? (
                          <div className="p-4 border rounded-lg text-center">
                            <p className="text-sm text-muted-foreground mb-2">No active credit accounts</p>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => router.push(`/dashboard/credit-pipeline?contactId=${selectedContactId}`)}
                            >
                              Add to Credit Pipeline
                            </Button>
                          </div>
                        ) : (
                          creditAccounts.map((account: any) => (
                            <div key={account.id} className="rounded-lg border p-3 flex items-center justify-between">
                              <div>
                                <p className="font-medium text-sm">{account.lender_name || "Lender"}</p>
                                <p className="text-xs text-muted-foreground capitalize">
                                  {(account.credit_pipeline_stage || "Lead").replace(/_/g, " ")}
                                </p>
                              </div>
                              <div className="text-right">
                                <p className="font-semibold text-sm">
                                  ${Number(account.loan_amount || 0).toLocaleString()}
                                </p>
                                <Badge variant="secondary" className="text-xs">
                                  {account.status || "active"}
                                </Badge>
                              </div>
                            </div>
                          ))
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>

                  {/* ── VIDEOS TAB ── */}
                  <TabsContent value="videos" className="space-y-4 mt-0">
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm">Video Engagement</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {contactVideos.length === 0 ? (
                          <p className="text-sm text-muted-foreground text-center py-8">No videos sent yet</p>
                        ) : (
                          contactVideos.map((video: any) => (
                            <div key={video.id} className="rounded-lg border p-3">
                              <div className="flex items-center justify-between mb-2">
                                <p className="font-medium text-sm">{video.script_title || "Video"}</p>
                                <span className="text-xs text-muted-foreground">
                                  Sent {new Date(video.created_at).toLocaleDateString()}
                                </span>
                              </div>
                              <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                                <div>
                                  <span className="block font-semibold text-foreground">{video.view_count || 0}</span>
                                  views
                                </div>
                                <div>
                                  <span className="block font-semibold text-foreground">
                                    {Math.round((video.avg_completion_rate || 0) * 100)}%
                                  </span>
                                  completion
                                </div>
                                <div>
                                  <span className="block font-semibold text-foreground">
                                    {video.last_viewed_at
                                      ? new Date(video.last_viewed_at).toLocaleDateString()
                                      : "Never"}
                                  </span>
                                  last viewed
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>

                  {/* ── TRANSACTIONS TAB ── */}
                  <TabsContent value="transactions" className="space-y-4 mt-0">
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm">Transaction History</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {contactTransactions.length === 0 ? (
                          <p className="text-sm text-muted-foreground text-center py-8">No transactions yet</p>
                        ) : (
                          contactTransactions.map((t: any) => (
                            <div key={t.id} className="rounded-lg border p-3 flex items-center justify-between">
                              <div className="min-w-0 flex-1">
                                <p className="font-medium text-sm truncate">
                                  {t.property_address
                                    ? `${t.property_address}${t.city ? `, ${t.city}` : ""}`
                                    : "Property"}
                                </p>
                                <p className="text-xs text-muted-foreground capitalize">
                                  {(t.transaction_type || "Active").replace(/_/g, " ")}
                                </p>
                              </div>
                              <Badge variant="secondary" className="text-xs capitalize">
                                {(t.status || "pending").replace(/_/g, " ")}
                              </Badge>
                            </div>
                          ))
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>

                  {/* ── PROPERTIES TAB (buyers only) ── */}
                  {isBuyerContact && (
                    <TabsContent value="properties" className="space-y-4 mt-0">
                      {/* Search criteria summary row */}
                      {((selectedContact as any).preferred_location || (selectedContact as any).budget_min) && (
                        <div className="rounded-lg border bg-muted/30 px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          {(selectedContact as any).preferred_location && (
                            <div><span className="text-muted-foreground block">Location</span><span className="font-medium">{(selectedContact as any).preferred_location}</span></div>
                          )}
                          {(selectedContact as any).budget_min && (selectedContact as any).budget_max && (
                            <div><span className="text-muted-foreground block">Budget</span><span className="font-medium">${Number((selectedContact as any).budget_min).toLocaleString()} – ${Number((selectedContact as any).budget_max).toLocaleString()}</span></div>
                          )}
                          {(selectedContact as any).preferred_bedrooms && (
                            <div><span className="text-muted-foreground block">Beds</span><span className="font-medium">{(selectedContact as any).preferred_bedrooms}+</span></div>
                          )}
                          {(selectedContact as any).move_timeline && (
                            <div><span className="text-muted-foreground block">Timeline</span><span className="font-medium">{(selectedContact as any).move_timeline}</span></div>
                          )}
                        </div>
                      )}

                      {/* AI property matching — full BuyerMatchPanel with PropertyAlertsPanel inside */}
                      <BuyerMatchPanel
                        contactId={selectedContactId}
                        agentId={agentId || ""}
                        brokerageId={brokerageId || ""}
                        isBuyerContact={isBuyerContact}
                        buyerStage={selectedContact.buyer_stage}
                        contactName={`${selectedContact.first_name} ${selectedContact.last_name}`}
                      />
                    </TabsContent>
                  )}

                  {/* ── ACTIVITY TIMELINE TAB ── */}
                  <TabsContent value="activity" className="space-y-4 mt-0">
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm">Activity Timeline</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {contactActivityTimeline.length === 0 ? (
                          <p className="text-sm text-muted-foreground text-center py-8">
                            No activity recorded yet
                          </p>
                        ) : (
                          <div className="space-y-4">
                            {contactActivityTimeline.map((item: any, idx: number) => (
                              <div
                                key={`${item.activity_type}-${item.id ?? idx}`}
                                className="flex gap-3 pb-4 border-b last:border-0"
                              >
                                <div className="flex-shrink-0 w-2 h-2 mt-2 rounded-full bg-primary" />
                                <div className="flex-1 space-y-1 min-w-0">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium text-sm capitalize">
                                      {(item.activity_type || "event").replace(/_/g, " ")}
                                    </span>
                                    <span className="text-xs text-muted-foreground shrink-0">
                                      {item.activity_date
                                        ? new Date(item.activity_date).toLocaleDateString()
                                        : ""}
                                    </span>
                                  </div>
                                  {(item.notes || item.body || item.title || item.subject) && (
                                    <p className="text-sm text-muted-foreground line-clamp-2">
                                      {item.notes || item.body || item.title || item.subject}
                                    </p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>

                  {/* ── INTELLIGENCE TAB ── */}
                  <TabsContent value="intelligence" className="space-y-4 mt-0">

                    {/* Unified lead profile — intent badge, confidence bar, urgency, motivation */}
                    {unifiedLeadProfile && (
                      <Card>
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm flex items-center gap-2">
                            Lead Profile
                            {unifiedLeadProfile.intent_type && (
                              <Badge className={cn(
                                "text-xs capitalize",
                                unifiedLeadProfile.intent_type === "buyer" ? "bg-blue-100 text-blue-700" :
                                unifiedLeadProfile.intent_type === "seller" ? "bg-amber-100 text-amber-700" :
                                "bg-purple-100 text-purple-700"
                              )}>
                                {unifiedLeadProfile.intent_type}
                              </Badge>
                            )}
                            {unifiedLeadProfile.temperature && (
                              <Badge className={cn(
                                "text-xs capitalize",
                                unifiedLeadProfile.temperature === "hot" ? "bg-red-100 text-red-700" :
                                unifiedLeadProfile.temperature === "warm" ? "bg-orange-100 text-orange-700" :
                                "bg-sky-100 text-sky-700"
                              )}>
                                {unifiedLeadProfile.temperature}
                              </Badge>
                            )}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {unifiedLeadProfile.confidence_score != null && (
                            <div>
                              <div className="flex justify-between text-xs mb-1">
                                <span className="text-muted-foreground">Confidence</span>
                                <span className="font-medium">{Math.round(Number(unifiedLeadProfile.confidence_score) * 100)}%</span>
                              </div>
                              <Progress value={Number(unifiedLeadProfile.confidence_score) * 100} className="h-1.5" />
                            </div>
                          )}
                          <div className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-xs">
                            {unifiedLeadProfile.urgency_level && (
                              <div className="flex justify-between gap-2">
                                <span className="text-muted-foreground">Timeline urgency</span>
                                <span className="font-medium capitalize">{unifiedLeadProfile.urgency_level}</span>
                              </div>
                            )}
                            {unifiedLeadProfile.motivation_signals && (
                              <div className="col-span-2">
                                <p className="text-muted-foreground mb-1">Motivation signals</p>
                                <div className="flex flex-wrap gap-1">
                                  {(Array.isArray(unifiedLeadProfile.motivation_signals)
                                    ? unifiedLeadProfile.motivation_signals
                                    : [unifiedLeadProfile.motivation_signals]
                                  ).map((sig: string, i: number) => (
                                    <Badge key={i} variant="outline" className="text-xs">{sig}</Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                            {unifiedLeadProfile.enrichment_source && (
                              <div className="flex justify-between gap-2">
                                <span className="text-muted-foreground">Enrichment source</span>
                                <Badge variant="outline" className="text-xs">{unifiedLeadProfile.enrichment_source}</Badge>
                              </div>
                            )}
                            {unifiedLeadProfile.ready_for_outreach != null && (
                              <div className="flex justify-between gap-2">
                                <span className="text-muted-foreground">Ready for outreach</span>
                                <span className={cn("text-xs font-medium", unifiedLeadProfile.ready_for_outreach ? "text-emerald-600" : "text-muted-foreground")}>
                                  {unifiedLeadProfile.ready_for_outreach ? "Yes" : "No"}
                                </span>
                              </div>
                            )}
                          </div>
                          {socialSignals.length > 0 && (
                            <div>
                              <p className="text-xs text-muted-foreground mb-1.5">Market social signals</p>
                              <div className="space-y-1">
                                {socialSignals.slice(0, 3).map((s: any) => (
                                  <div key={s.id} className="flex items-center justify-between text-xs rounded border px-2 py-1">
                                    <span className="truncate max-w-[180px]">{s.signal_text || s.source}</span>
                                    {s.ai_intent_score != null && (
                                      <span className="text-muted-foreground ml-2 shrink-0">Score {Math.round(s.ai_intent_score * 100)}%</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    {!contactIntelligence && !unifiedLeadProfile && (
                      <Card>
                        <CardContent className="p-6 text-sm text-muted-foreground text-center">
                          Loading intelligence…
                        </CardContent>
                      </Card>
                    )}
                    {contactIntelligence && (
                      <>
                        {/* Score grid */}
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Lead intelligence scores</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                              <ScoreCell label="Confidence" value={contactIntelligence.confidence_score} suffix="%" />
                              <ScoreCell label="Intent" value={contactIntelligence.intent_score} suffix="%" />
                              <ScoreCell label="Engagement" value={contactIntelligence.engagement_score} suffix="%" />
                              <ScoreCell
                                label="Latest lead score"
                                value={contactIntelligence.latest_lead_score}
                                subText={
                                  contactIntelligence.latest_score_ai_confidence != null
                                    ? `AI conf: ${Math.round(Number(contactIntelligence.latest_score_ai_confidence) * 100)}%`
                                    : undefined
                                }
                              />
                            </div>
                            {contactIntelligence.latest_scored_at && (
                              <p className="text-xs text-muted-foreground mt-3">
                                Last scored {new Date(contactIntelligence.latest_scored_at).toLocaleString()}
                              </p>
                            )}
                          </CardContent>
                        </Card>

                        {/* Source / origin */}
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Lead origin & enrichment</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-y-2 gap-x-4 text-sm">
                              <KV label="Source" value={contactIntelligence.source} />
                              <KV label="Source channel" value={contactIntelligence.source_channel} />
                              <KV label="Source family" value={contactIntelligence.source_family} />
                              <KV label="Source subtype" value={contactIntelligence.source_subtype} />
                              <KV label="Data source" value={contactIntelligence.data_source} />
                              <KV label="Enrichment source" value={contactIntelligence.enrichment_source} />
                              <KV
                                label="Enrichment confidence"
                                value={
                                  contactIntelligence.enrichment_confidence != null
                                    ? `${Math.round(Number(contactIntelligence.enrichment_confidence) * 100)}%`
                                    : null
                                }
                              />
                              <KV
                                label="Last enriched"
                                value={
                                  contactIntelligence.last_enriched_at
                                    ? new Date(contactIntelligence.last_enriched_at).toLocaleString()
                                    : contactIntelligence.enriched_at
                                    ? new Date(contactIntelligence.enriched_at).toLocaleString()
                                    : null
                                }
                              />
                            </div>
                          </CardContent>
                        </Card>

                        {/* Compliance & contact-ability */}
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Contact-ability & compliance</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                              <Flag
                                label="Email verified"
                                ok={contactIntelligence.email_verified === true}
                              />
                              <Flag
                                label="Email opt-out"
                                ok={!contactIntelligence.email_opt_out && !contactIntelligence.email_unsubscribed}
                                negativeLabel={contactIntelligence.email_unsubscribed ? "Unsubscribed" : "Opted out"}
                              />
                              <Flag
                                label="Direct mail opt-out"
                                ok={!contactIntelligence.direct_mail_opt_out}
                                negativeLabel="Opted out"
                              />
                              <Flag
                                label="TCPA consent"
                                ok={!!contactIntelligence.tcpa_consent_source}
                                negativeLabel="No consent"
                                positiveLabel={contactIntelligence.tcpa_consent_source ?? "OK"}
                              />
                              <Flag
                                label="AI outreach paused"
                                ok={!contactIntelligence.ai_outreach_paused}
                                negativeLabel="Paused"
                              />
                            </div>
                          </CardContent>
                        </Card>

                        {/* Score factors */}
                        {contactIntelligence.latest_score_factors && typeof contactIntelligence.latest_score_factors === "object" && (
                          <Card>
                            <CardHeader className="pb-3">
                              <CardTitle className="text-sm">Score factors</CardTitle>
                            </CardHeader>
                            <CardContent>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-y-1.5 gap-x-4 text-xs">
                                {Object.entries(contactIntelligence.latest_score_factors as Record<string, unknown>)
                                  .filter(([, v]) => v !== null && v !== undefined && v !== "")
                                  .map(([k, v]) => (
                                    <div key={k} className="flex justify-between gap-2">
                                      <span className="text-muted-foreground capitalize">{k.replace(/_/g, " ")}</span>
                                      <span className="font-medium text-right max-w-[140px] truncate">
                                        {typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)}
                                      </span>
                                    </div>
                                  ))}
                              </div>
                            </CardContent>
                          </Card>
                        )}
                      </>
                    )}
                  </TabsContent>

                  {/* ── FINANCE TAB (buyers only) ── */}
                  {isBuyerContact && (
                    <TabsContent value="finance" className="space-y-4 mt-0">
                      <FinancialVerificationPanel
                        contactId={selectedContactId}
                        brokerageId={brokerageId ?? ""}
                        agentUserId={agentId ?? ""}
                        buyerName={`${selectedContact.first_name ?? ""} ${selectedContact.last_name ?? ""}`.trim() || undefined}
                      />
                    </TabsContent>
                  )}

                  {/* ── CLOSING WORKFLOW TAB ── */}
                  <TabsContent value="closing" className="space-y-4 mt-0">
                    <ClosingWorkflowTab
                      contactId={selectedContactId}
                      agentId={agentId ?? ""}
                      brokerageId={brokerageId ?? ""}
                    />
                  </TabsContent>

                </Tabs>
              </main>

            </div>
          </div>
        )}
      </div>
    )
  }

  // Apply contact-type filter from the type tabs (Buyer / Seller / Investor / Lifetime)
  const displayedContacts =
    typeFilter === "all"
      ? filtered
      : filtered.filter((c) => {
          const t = (c.contact_type ?? "").toLowerCase()
          const p = (c.contact_persona ?? "").toLowerCase()
          if (typeFilter === "lifetime_customer") {
            return t === "lifetime_customer" || t === LIFETIME_CUSTOMER_TYPE
          }
          return t.includes(typeFilter) || p.includes(typeFilter)
        })

  // Contact List View
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Contacts</h1>
          <p className="text-sm text-gray-500 mt-1">
            {loading
              ? "Loading..."
              : `${displayedContacts.length} contact${displayedContacts.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadContacts}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={handleOpenAddDialog}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Contact
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Search by name, email, phone, or city..."
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="pl-10 pr-10"
        />
        {searchLoading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-gray-400" />
        )}
      </div>

      {/* Contact type filter tabs */}
      <div className="flex items-center gap-1 border-b">
        {(["all", "buyer", "seller", "investor", "lifetime_customer"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTypeFilter(t)}
            className={cn(
              "px-3 py-1.5 text-sm font-medium capitalize border-b-2 transition-colors -mb-px whitespace-nowrap",
              typeFilter === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t === "all" ? "All Contacts"
              : t === "lifetime_customer" ? "Lifetime Customers"
              : t.charAt(0).toUpperCase() + t.slice(1) + "s"}
          </button>
        ))}
        {/* Buyer fatigue analytics — re-homed here from the retired /dashboard/buyers lane. */}
        {typeFilter === "buyer" && (
          <Link
            href="/dashboard/buyers/fatigue"
            className="ml-auto flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground whitespace-nowrap"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Fatigue Monitor
          </Link>
        )}
      </div>

      {/* AI Priority Contacts Strip */}
      {(loadingInsights || contactInsights.length > 0) && (
        <section className="border rounded-lg p-4 bg-card">
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            AI Priority Contacts Today
            {loadingInsights && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </h2>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {contactInsights.map((insight) => {
              // Resolve display name from contacts list if available
              const matchedContact = contacts.find((c) => c.id === insight.contactId)
              const displayName = matchedContact
                ? `${matchedContact.first_name} ${matchedContact.last_name}`
                : insight.contactId.slice(0, 8)

              return (
                <div
                  key={insight.contactId}
                  className="min-w-[220px] rounded-lg border bg-background p-3 flex-shrink-0 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold truncate text-foreground">{displayName}</p>
                    <Badge
                      className={
                        insight.priority === "high"
                          ? "bg-red-100 text-red-700 text-xs shrink-0"
                          : insight.priority === "medium"
                          ? "bg-amber-100 text-amber-700 text-xs shrink-0"
                          : "bg-muted text-muted-foreground text-xs shrink-0"
                      }
                    >
                      {insight.priority}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{insight.reason}</p>
                  <p className="text-xs font-medium text-primary">{insight.suggestion}</p>
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7 flex-1"
                      onClick={() => handleSelectContact(insight.contactId)}
                    >
                      Open
                    </Button>
                    <Button
                      size="sm"
                      className="text-xs h-7 flex-1"
                      disabled={draftingFor === insight.contactId}
                      onClick={async () => {
                        if (!user?.id) return
                        setDraftingFor(insight.contactId)
                        try {
                          const body = await draftSmartEmail(insight.contactId, insight.reason)
                          if (!body) return
                          const supabase = createClient()
                          // Resolve brokerage_id from user metadata or users table
                          const { data: userData } = await supabase
                            .from("users")
                            .select("brokerage_id")
                            .eq("id", user.id)
                            .single()
                          await supabase.from("ai_message_drafts").insert({
                            agent_user_id: user.id,
                            brokerage_id: userData?.brokerage_id ?? null,
                            contact_id: insight.contactId,
                            channel: "email",
                            draft_body: body,
                            draft_subject: `Follow up — ${displayName}`,
                            status: "pending",
                            trigger_event: "ai_priority_insight",
                          })
                          toast.success(`Draft created for ${displayName} ��� review in Communications`)
                        } catch {
                          toast.error("Failed to create draft")
                        } finally {
                          setDraftingFor(null)
                        }
                      }}
                    >
                      {draftingFor === insight.contactId ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        "Draft Email"
                      )}
                    </Button>
                  </div>
                </div>
              )
            })}
            {contactInsights.length === 0 && !loadingInsights && (
              <p className="text-sm text-muted-foreground py-2">No priority contacts today</p>
            )}
          </div>
        </section>
      )}

      {/* Error state */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button
            onClick={loadContacts}
            className="ml-2 underline font-medium"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className="h-20 bg-gray-100 rounded-lg animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-16">
          <Users className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-1">
            {search ? "No contacts match your search" : "No contacts yet"}
          </h3>
          <p className="text-sm text-gray-500 mb-4">
            {search
              ? "Try adjusting your search terms"
              : "Add your first contact to get started"}
          </p>
          {!search && (
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={handleOpenAddDialog}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Contact
            </Button>
          )}
        </div>
      )}

      {/* Empty state for active type filter when underlying list is non-empty */}
      {!loading && filtered.length > 0 && displayedContacts.length === 0 && (
        <div className="text-center py-8 text-sm text-muted-foreground">
          No {typeFilter === "lifetime_customer" ? "lifetime customer" : typeFilter} contacts.{" "}
          <button className="underline text-primary" onClick={() => setTypeFilter("all")}>
            Show all
          </button>
        </div>
      )}

      {/* Bulk action bar */}
      {selectedContactIds.size > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-3 rounded-lg border bg-primary/5 px-4 py-2.5 text-sm">
          <span className="font-medium text-primary">{selectedContactIds.size} selected</span>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-7"
            onClick={async () => {
              if (availableSequences.length === 0 && brokerageId) {
                const res = await listCampaignSequences(brokerageId)
                if (res.sequences) setAvailableSequences(res.sequences.map((s: any) => ({ id: s.id, name: s.name, sequence_type: s.sequence_type })))
              }
              setEnrollDialogOpen(true)
            }}
          >
            <Workflow className="h-3.5 w-3.5" />
            Enroll in Campaign
          </Button>
          <button
            className="ml-auto text-xs text-muted-foreground underline"
            onClick={() => setSelectedContactIds(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Contact list */}
      {!loading && displayedContacts.length > 0 && (
        <div className={cn("space-y-2", searchLoading && "opacity-60 pointer-events-none")}>
          {displayedContacts.map((contact) => {
            const score = leadScores[contact.id]
            const initials = [contact.first_name?.[0], contact.last_name?.[0]]
              .filter(Boolean).join("").toUpperCase() || "?"
            const typeKey = (contact.contact_type ?? "other").toLowerCase()
            const avatarColors = TYPE_AVATAR_COLORS[typeKey] ?? TYPE_AVATAR_COLORS.other
            const isSelected = selectedContactIds.has(contact.id)

            let lastActivityLabel: string | null = null
            if (contact.last_contacted_at) {
              try {
                lastActivityLabel = "Last contact: " + formatDistanceToNow(
                  new Date(contact.last_contacted_at), { addSuffix: true }
                )
              } catch {}
            } else if (contact.created_at) {
              try {
                lastActivityLabel = "Added " + formatDistanceToNow(
                  new Date(contact.created_at), { addSuffix: true }
                )
              } catch {}
            }

            const scoreValue = score?.score
            const scoreLabel = score?.label
            const engScore = contact.engagement_score

            return (
              <div
                key={contact.id}
                className={cn(
                  "group relative flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 cursor-pointer",
                  "border-l-4 hover:shadow-md hover:border-primary/30 transition-all duration-150",
                  avatarColors.border,
                  isSelected && "border-primary ring-1 ring-primary bg-primary/5"
                )}
                onClick={() => handleSelectContact(contact.id)}
              >
                {/* Checkbox */}
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={(checked) => {
                    const next = new Set(selectedContactIds)
                    if (checked) next.add(contact.id)
                    else next.delete(contact.id)
                    setSelectedContactIds(next)
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0"
                />

                {/* Avatar */}
                <div
                  className={cn(
                    "shrink-0 h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold select-none",
                    avatarColors.bg, avatarColors.text
                  )}
                >
                  {initials}
                </div>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  {/* Name + badges */}
                  <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                    <span className="font-semibold text-sm truncate max-w-[170px]">
                      {contact.first_name} {contact.last_name}
                    </span>
                    {contact.contact_type && (
                      <Badge className={cn("text-[10px] px-1.5 py-0 h-[18px] leading-none", TYPE_COLORS[typeKey] ?? TYPE_COLORS.other)}>
                        {contact.contact_type === "lifetime_customer" ? "Lifetime" : contact.contact_type}
                      </Badge>
                    )}
                    {contact.status && (
                      <Badge className={cn("text-[10px] px-1.5 py-0 h-[18px] leading-none", STATUS_COLORS[contact.status] ?? "bg-gray-100 text-gray-600")}>
                        {contact.status.replace(/_/g, " ")}
                      </Badge>
                    )}
                    {(contact as any).ai_isa_enabled && (
                      <Badge className="text-[10px] px-1.5 py-0 h-[18px] leading-none bg-emerald-100 text-emerald-700">
                        AI
                      </Badge>
                    )}
                    {contact.dnc_status && (
                      <Badge className="text-[10px] px-1.5 py-0 h-[18px] leading-none bg-red-100 text-red-700">DNC</Badge>
                    )}
                  </div>

                  {/* Contact details */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0 text-xs text-muted-foreground">
                    {contact.email && (
                      <span className="flex items-center gap-0.5 truncate max-w-[150px]">
                        <Mail className="h-3 w-3 shrink-0" />
                        {contact.email}
                      </span>
                    )}
                    {contact.phone && (
                      <span className="flex items-center gap-0.5">
                        <Phone className="h-3 w-3 shrink-0" />
                        {contact.phone}
                      </span>
                    )}
                    {(contact.city || contact.state) && (
                      <span className="flex items-center gap-0.5">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {[contact.city, contact.state].filter(Boolean).join(", ")}
                      </span>
                    )}
                  </div>

                  {/* Last activity */}
                  {lastActivityLabel && (
                    <p className="mt-0.5 text-[10px] text-muted-foreground/70">{lastActivityLabel}</p>
                  )}
                </div>

                {/* Right rail: score + quick actions */}
                <div className="shrink-0 flex flex-col items-end gap-1.5">
                  {/* Score circle — AI lead score takes priority over engagement */}
                  {(scoreValue != null || engScore != null) && (
                    <div
                      className={cn(
                        "h-8 w-8 rounded-full flex items-center justify-center text-[10px] font-bold border-2 shrink-0",
                        scoreLabel === "High" || (engScore ?? 0) >= 70
                          ? "border-green-500 text-green-700 bg-green-50"
                          : scoreLabel === "Medium" || (engScore ?? 0) >= 40
                          ? "border-amber-400 text-amber-700 bg-amber-50"
                          : "border-gray-300 text-gray-500 bg-gray-50"
                      )}
                      title={
                        scoreValue != null
                          ? `Lead score: ${scoreValue}% conversion probability`
                          : `Engagement: ${engScore}`
                      }
                    >
                      {scoreValue ?? engScore}
                    </div>
                  )}

                  {/* Quick actions — fade in on hover */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {contact.phone && !contact.phone_opt_out && (
                      <button
                        type="button"
                        title="Call"
                        className="h-6 w-6 rounded-full border bg-background flex items-center justify-center text-muted-foreground hover:text-green-600 hover:border-green-400 transition-colors"
                        onClick={(e) => { e.stopPropagation(); window.location.href = `tel:${contact.phone}` }}
                      >
                        <Phone className="h-3 w-3" />
                      </button>
                    )}
                    {contact.email && !contact.email_opt_out && (
                      <button
                        type="button"
                        title="Email"
                        className="h-6 w-6 rounded-full border bg-background flex items-center justify-center text-muted-foreground hover:text-blue-600 hover:border-blue-400 transition-colors"
                        onClick={(e) => { e.stopPropagation(); handleSelectContact(contact.id) }}
                      >
                        <Mail className="h-3 w-3" />
                      </button>
                    )}
                    {contact.phone && !contact.sms_opt_out && (
                      <button
                        type="button"
                        title="SMS"
                        className="h-6 w-6 rounded-full border bg-background flex items-center justify-center text-muted-foreground hover:text-purple-600 hover:border-purple-400 transition-colors"
                        onClick={(e) => { e.stopPropagation(); handleSelectContact(contact.id) }}
                      >
                        <MessageCircle className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Enroll in Campaign Dialog ──────────────────────────────────────── */}
      <EnrollCampaignDialog
        open={enrollDialogOpen}
        onOpenChange={setEnrollDialogOpen}
        selectedCount={selectedContactIds.size}
        sequences={availableSequences}
        selectedSequenceId={selectedSequenceId}
        onSequenceChange={setSelectedSequenceId}
        enrolling={enrolling}
        onEnroll={async () => {
          if (!selectedSequenceId) return
          setEnrolling(true)
          let successCount = 0
          for (const contactId of Array.from(selectedContactIds)) {
            const result = await enrollContactInSequence({ contactId, sequenceId: selectedSequenceId })
            if (result.enrollment) successCount++
          }
          setEnrolling(false)
          setEnrollDialogOpen(false)
          setSelectedContactIds(new Set())
          setSelectedSequenceId("")
        }}
      />

      {/* ── Add Contact Dialog ──────────────────────────────────────────────── */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Contact</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="add-first-name">First Name *</Label>
                <Input
                  id="add-first-name"
                  value={addForm.first_name}
                  onChange={(e) => setAddForm((f) => ({ ...f, first_name: e.target.value }))}
                  placeholder="Jane"
                  disabled={addFormSubmitting}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-last-name">Last Name *</Label>
                <Input
                  id="add-last-name"
                  value={addForm.last_name}
                  onChange={(e) => setAddForm((f) => ({ ...f, last_name: e.target.value }))}
                  placeholder="Smith"
                  disabled={addFormSubmitting}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-email">Email</Label>
              <Input
                id="add-email"
                type="email"
                value={addForm.email}
                onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="jane@example.com"
                disabled={addFormSubmitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-phone">Phone</Label>
              <Input
                id="add-phone"
                type="tel"
                value={addForm.phone}
                onChange={(e) => setAddForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="(555) 000-0000"
                disabled={addFormSubmitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-address">Address</Label>
              <AddressAutocomplete
                id="add-address"
                value={(addForm as any).street_address ?? ""}
                onChange={v => setAddForm((f) => ({ ...f, street_address: v } as any))}
                onSelect={a => setAddForm((f) => ({
                  ...f,
                  street_address: a.street,
                  city: a.city || f.city,
                  state: a.state || f.state,
                  zip_code: a.zip || f.zip_code,
                } as any))}
                placeholder="123 Main St, Miami, FL"
                disabled={addFormSubmitting}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="add-city">City</Label>
                <Input
                  id="add-city"
                  value={addForm.city}
                  onChange={(e) => setAddForm((f) => ({ ...f, city: e.target.value }))}
                  placeholder="Miami"
                  disabled={addFormSubmitting}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-state">State</Label>
                <Input
                  id="add-state"
                  value={addForm.state}
                  onChange={(e) => setAddForm((f) => ({ ...f, state: e.target.value }))}
                  placeholder="FL"
                  maxLength={2}
                  disabled={addFormSubmitting}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-zip">ZIP</Label>
                <Input
                  id="add-zip"
                  value={addForm.zip_code}
                  onChange={(e) => setAddForm((f) => ({ ...f, zip_code: e.target.value }))}
                  placeholder="33101"
                  maxLength={10}
                  disabled={addFormSubmitting}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Contact Type</Label>
                <Select
                  value={addForm.contact_type}
                  onValueChange={(v) => setAddForm((f) => ({ ...f, contact_type: v as typeof f.contact_type }))}
                  disabled={addFormSubmitting}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buyer">Buyer</SelectItem>
                    <SelectItem value="seller">Seller</SelectItem>
                    <SelectItem value="both">Buyer &amp; Seller</SelectItem>
                    <SelectItem value="investor">Investor</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select
                  value={addForm.status}
                  onValueChange={(v) => setAddForm((f) => ({ ...f, status: v }))}
                  disabled={addFormSubmitting}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">New</SelectItem>
                    <SelectItem value="contacted">Contacted</SelectItem>
                    <SelectItem value="qualified">Qualified</SelectItem>
                    <SelectItem value="nurture">Nurture</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {addFormError && (
              <p className="text-sm text-red-600">{addFormError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)} disabled={addFormSubmitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmitAddContact} disabled={addFormSubmitting}>
              {addFormSubmitting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Saving...</> : "Add Contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selectedContact && brokerageId && (
        <FormWizard
          mode="offer"
          contact={selectedContact as any}
          brokerageId={brokerageId}
          agentUserId={(selectedContact as any).agent_id ?? agentId ?? ""}
          open={offerWizardOpen}
          onClose={() => setOfferWizardOpen(false)}
        />
      )}
    </div>
  )
}

// ─── Enroll in Campaign Dialog ───────────────────────────────────────────────

function EnrollCampaignDialog({
  open,
  onOpenChange,
  selectedCount,
  sequences,
  selectedSequenceId,
  onSequenceChange,
  enrolling,
  onEnroll,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  selectedCount: number
  sequences: { id: string; name: string; sequence_type: string }[]
  selectedSequenceId: string
  onSequenceChange: (id: string) => void
  enrolling: boolean
  onEnroll: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Enroll {selectedCount} Contact{selectedCount !== 1 ? "s" : ""} in Campaign</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {sequences.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sequences found. Create sequences in the Campaign Sequences library first.</p>
          ) : (
            <div className="space-y-1.5">
              <Label>Select Campaign Sequence</Label>
              <Select value={selectedSequenceId} onValueChange={onSequenceChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a sequence..." />
                </SelectTrigger>
                <SelectContent>
                  {sequences.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="font-medium">{s.name}</span>
                      {s.sequence_type && (
                        <span className="ml-2 text-xs text-muted-foreground capitalize">{s.sequence_type.replace(/_/g, " ")}</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enrolling}>Cancel</Button>
          <Button onClick={onEnroll} disabled={enrolling || !selectedSequenceId || sequences.length === 0}>
            {enrolling ? "Enrolling..." : `Enroll ${selectedCount} Contact${selectedCount !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Intelligence-tab helper components ──────────────────────────────────────

function ScoreCell({
  label,
  value,
  suffix,
  subText,
}: {
  label: string
  value: number | null
  suffix?: string
  subText?: string
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">
        {value != null ? `${value}${suffix ?? ""}` : <span className="text-muted-foreground/50 text-base">—</span>}
      </p>
      {subText && <p className="text-[10px] text-muted-foreground mt-0.5">{subText}</p>}
    </div>
  )
}

function KV({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b last:border-0 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-right truncate">
        {value ?? <span className="text-muted-foreground/50">—</span>}
      </span>
    </div>
  )
}

function Flag({
  label,
  ok,
  positiveLabel,
  negativeLabel,
  neutral,
}: {
  label: string
  ok: boolean
  positiveLabel?: string
  negativeLabel?: string
  neutral?: boolean
}) {
  const variantClass = neutral
    ? ok
      ? "bg-blue-50 text-blue-900 border-blue-200"
      : "bg-gray-50 text-gray-700 border-gray-200"
    : ok
    ? "bg-emerald-50 text-emerald-900 border-emerald-200"
    : "bg-amber-50 text-amber-900 border-amber-200"
  return (
    <div className={`rounded-md border p-2 text-xs ${variantClass}`}>
      <p className="text-[10px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="font-semibold mt-0.5">
        {ok ? positiveLabel ?? "OK" : negativeLabel ?? "Issue"}
      </p>
    </div>
  )
}
