"use client"

import { useEffect, useState, useCallback, useTransition, useRef } from "react"
import { useAuth } from "@/lib/auth/client"
import { useSearchParams, useRouter } from "next/navigation"
import { getContacts, getContactById, createContact, addContactNote } from "@/app/actions/contacts"
import { enableAIPilot, getActiveAutoPilotPlans, toggleAutoPilot, detectClientChurn, getConversationIntelligence } from "@/app/actions/ai-predictions"
import { generateContactInsights, draftSmartEmail } from "@/app/actions/ai-insights"
import type { ContactInsight } from "@/app/actions/ai-insights"
import { aiSuggestFollowUp } from "@/app/actions/ai-lead-nurturing"
import { aiOptimizeReferralAsk } from "@/app/actions/ai-sphere-management"
import { generateAIDraft, shareSocialPostWithSeller } from "@/app/actions/portal-messages"
import { generateCopilotPlan } from "@/app/actions/workflows"
import { GratitudeGiftingPanel } from "@/app/dashboard/referrals/components/os/gratitude-gifting-panel"
import { getBuyerInsights } from "@/app/actions/buyer-insights"
import { getBuyerFatigueScore } from "@/app/actions/buyer-fatigue"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
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
} from "lucide-react"
import Link from "next/link"
import { format } from "date-fns"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

// Import all 10 Contact OS components
import {
  ContactCommandStrip,
  RelationshipRadar,
  CommunicationHealthPanel,
  NextBestActionPanel,
  ValueDeliveredPanel,
  ReferralLikelihoodPanel,
  TimelineContextPanel,
  RelationshipAiChatPanel,
  SmartNoteComposer,
  BuyerMatchPanel,
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
  other: "bg-gray-50 text-gray-600",
}

function ContactOSSummary({
  contact,
  copilotPlan,
  portalStatus,
  lastTouch,
  onMessageClick,
}: {
  contact: Contact
  copilotPlan: any
  portalStatus?: string | null
  lastTouch?: string | null
  onMessageClick: () => void
}) {
  const daysSince =
    lastTouch != null
      ? Math.floor((Date.now() - new Date(lastTouch).getTime()) / 86400000)
      : null

  return (
    <div className="flex items-center gap-2 flex-wrap px-4 py-2 border-b bg-muted/30 rounded-t-md">
      {contact.contact_persona && (
        <Badge variant="outline" className="capitalize text-xs">
          {contact.contact_persona.replace(/_/g, " ")}
        </Badge>
      )}

      {contact.status && (
        <Badge
          className={cn(
            "text-xs border-0",
            contact.status === "active" || contact.status === "lifetime_customer"
              ? "bg-green-100 text-green-800"
              : contact.status === "nurture" || contact.status === "contacted"
              ? "bg-blue-100 text-blue-800"
              : "bg-gray-100 text-gray-700"
          )}
        >
          {contact.status.replace(/_/g, " ")}
        </Badge>
      )}

      {portalStatus && (
        <Badge variant="outline" className="text-xs">
          Portal: {portalStatus}
        </Badge>
      )}

      {daysSince !== null && (
        <span
          className={cn(
            "text-xs",
            daysSince > 30
              ? "text-red-600 font-medium"
              : daysSince > 14
              ? "text-amber-600"
              : "text-muted-foreground"
          )}
        >
          {daysSince === 0
            ? "Touched today"
            : daysSince === 1
            ? "Last touch: yesterday"
            : `Last touch: ${daysSince}d ago`}
        </span>
      )}

      {copilotPlan?.next_action && (
        <span className="text-xs text-indigo-700 truncate max-w-[220px]">
          AI Plan: {copilotPlan.next_action.slice(0, 60)}
          {copilotPlan.next_action.length > 60 ? "…" : ""}
        </span>
      )}

      <div className="ml-auto flex gap-1.5 shrink-0">
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" asChild>
          <Link href={`/portal/${contact.id}`} target="_blank">
            Portal
          </Link>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={onMessageClick}
        >
          Message
        </Button>
      </div>
    </div>
  )
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
  const [loading, setLoading] = useState(true)
  const [searchLoading, setSearchLoading] = useState(false)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchGenRef = useRef(0)
  const searchQueryRef = useRef("")
  const activitiesGenRef = useRef(0)
  const [error, setError] = useState<string | null>(null)

  // Selected contact detail state
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    searchParams.get("contact")
  )
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

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

  // Lead conversion scores — populated async after contacts load (best-effort, never blocks render)
  const [leadScores, setLeadScores] = useState<Record<string, { label: "High" | "Medium"; score: number }>>({})

  // Suggested follow-up actions for the selected contact
  const [suggestedActions, setSuggestedActions] = useState<any[]>([])

  // Conversation threads for the selected contact (loaded by CommunicationHealthPanel internally;
  // we hold a local copy here so RelationshipRadar can count open threads)
  const [conversations, setConversations] = useState<any[]>([])

  // AI Priority Insights state
  const [contactInsights, setContactInsights] = useState<ContactInsight[]>([])
  const [loadingInsights, setLoadingInsights] = useState(false)
  const [draftingFor, setDraftingFor] = useState<string | null>(null)

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
        // Core data loads — contact + churn + autopilot + followup + conv intel in parallel
        const [contactResult, churnResult, autopilotResult, followUpResult, convIntelResult] =
          await Promise.all([
            getContactById(contactId),
            detectClientChurn(contactId).catch(() => null),
            getActiveAutoPilotPlans(agentId ?? "").catch(() => []),
            aiSuggestFollowUp({ contactId, agentId: agentId ?? "" }).catch(() => ({ suggestions: [] })),
            getConversationIntelligence(contactId).catch(() => null),
          ])

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
    supabase
      .from("activities")
      .select("id, activity_type, title, description, notes, created_at, contact_id")
      .eq("contact_id", selectedContactId)
      .order("created_at", { ascending: false })
      .limit(20)
      .then(({ data }: { data: any[] | null }) => {
        if (gen !== activitiesGenRef.current) return  // stale
        setContactActivities(data || [])
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

    // For sellers, load their listing
    if (selectedContact.contact_persona === "Listing Seller") {
      supabase
        .from("listings")
        .select("id, address, city, state, zipcode, status, list_price")
        .eq("seller_contact_id", selectedContactId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(({ data }: { data: any | null }) => setRelatedListing(data ?? null))
        .catch(() => setRelatedListing(null))
    }

    // For all contacts, check for transactions
    supabase
      .from("transactions")
      .select("id, property_address, stage, total_value, expected_close_date")
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

  // Handlers for OS components
  const handleEnableAutopilot = async (level: "conservative" | "moderate" | "aggressive"): Promise<void> => {
    if (!selectedContactId || !agentId) return
    const result = await enableAIPilot({ agentId, leadId: selectedContactId, autopilotLevel: level })
    if (result?.success) {
      toast.success(result.message ?? "AI Autopilot enabled")
      const [plans] = await Promise.all([
        getActiveAutoPilotPlans(agentId).catch(() => []),
      ])
      setAutopilotPlans(Array.isArray(plans) ? plans : [])
      const supabase = createClient()
      const { data: updatedPlan } = await supabase
        .from("copilot_plans")
        .select("id, plan_name, status, next_action, next_action_date, updated_at")
        .eq("contact_id", selectedContactId)
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      setCopilotPlan(updatedPlan ?? null)
    } else {
      toast.error((result as any)?.error ?? "Failed to enable AI Autopilot")
    }
  }

  const handleToggleAutopilot = async (planId: string, pause: boolean) => {
    startTransition(async () => {
      const result = await toggleAutoPilot(planId, pause)
      if (!(result as any).success) {
        toast.error((result as any).error ?? "Failed to update autopilot")
        return
      }
      if (pause) {
        setAutopilotPlans(prev => prev.filter(p => p.id !== planId))
      }
      if (agentId) {
        const plans = await getActiveAutoPilotPlans(agentId)
        setAutopilotPlans(Array.isArray(plans) ? plans : [])
      }
      toast.success(pause ? "AI Autopilot paused" : "AI Autopilot resumed")
    })
  }

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

    const daysSinceContact = selectedContact.last_contacted_at
      ? Math.floor(
          (Date.now() - new Date(selectedContact.last_contacted_at).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : null

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
            {/* Contact Command Strip — full width */}
            <div className="shrink-0 px-4 pt-3">
              <ContactCommandStrip
                contact={selectedContact}
                churnRisk={churnRisk}
                autopilotPlans={autopilotPlans}
                agentId={agentId || ""}
                brokerageId={brokerageId || ""}
                onEnableAutopilot={handleEnableAutopilot}
                onToggleAutopilot={handleToggleAutopilot}
                onShareSocialPost={handleShareSocialPost}
                onChannelToggled={() => { if (selectedContactId) loadContactDetail(selectedContactId) }}
                onAddNote={() => setActiveTab("comms")}
                loading={isPending}
              />
            </div>

            {/* Two-panel body: sticky sidebar + scrollable tab area */}
            <div className="flex flex-1 min-h-0 overflow-hidden mt-4">

              {/* ── LEFT SIDEBAR — sticky identity panel ── */}
              <aside className="w-64 shrink-0 border-r bg-muted/20 flex flex-col overflow-y-auto px-4 py-4 gap-4">
                {/* Avatar + name */}
                <div className="flex flex-col items-center text-center gap-2">
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-2xl font-bold text-primary">
                    {selectedContact.first_name?.[0]?.toUpperCase()}
                    {selectedContact.last_name?.[0]?.toUpperCase()}
                  </div>
                  <div>
                    <p className="font-semibold text-sm leading-tight">
                      {selectedContact.first_name} {selectedContact.last_name}
                    </p>
                    {selectedContact.contact_persona && (
                      <p className="text-xs text-muted-foreground capitalize mt-0.5">
                        {selectedContact.contact_persona.replace(/_/g, " ")}
                      </p>
                    )}
                  </div>
                  {/* Status + type badges */}
                  <div className="flex flex-wrap justify-center gap-1">
                    {selectedContact.contact_type && (
                      <Badge className={cn("text-xs border-0", TYPE_COLORS[selectedContact.contact_type] ?? TYPE_COLORS.other)}>
                        {selectedContact.contact_type}
                      </Badge>
                    )}
                    {selectedContact.status && (
                      <Badge className={cn("text-xs border-0", STATUS_COLORS[selectedContact.status] ?? "bg-gray-100 text-gray-700")}>
                        {selectedContact.status.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </div>
                </div>

                <Separator />

                {/* Contact details */}
                <div className="space-y-2 text-xs">
                  {selectedContact.email && (
                    <a href={`mailto:${selectedContact.email}`} className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors truncate">
                      <Mail className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{selectedContact.email}</span>
                    </a>
                  )}
                  {selectedContact.phone && (
                    <a href={`tel:${selectedContact.phone}`} className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
                      <Phone className="h-3.5 w-3.5 shrink-0" />
                      <span>{selectedContact.phone}</span>
                    </a>
                  )}
                  {(selectedContact.city || selectedContact.state) && (
                    <p className="flex items-center gap-2 text-muted-foreground">
                      <MapPin className="h-3.5 w-3.5 shrink-0" />
                      <span>{[selectedContact.city, selectedContact.state].filter(Boolean).join(", ")}</span>
                    </p>
                  )}
                  {daysSinceContact !== null && (
                    <p className={cn("text-xs mt-1 font-medium",
                      daysSinceContact > 30 ? "text-red-600" :
                      daysSinceContact > 14 ? "text-amber-600" :
                      "text-muted-foreground"
                    )}>
                      {daysSinceContact === 0 ? "Touched today" :
                       daysSinceContact === 1 ? "Last touch: yesterday" :
                       `Last touch: ${daysSinceContact}d ago`}
                    </p>
                  )}
                </div>

                <Separator />

                {/* Portal shortcut — always visible */}
                <div className="space-y-1.5">
                  <Link href={`/portal/${selectedContactId}`} target="_blank">
                    <Button size="sm" variant="default" className="w-full gap-1.5 text-xs">
                      <Globe className="h-3.5 w-3.5" />
                      Open Client Portal
                    </Button>
                  </Link>
                  {portalInviteData?.status && (
                    <p className="text-xs text-center text-muted-foreground capitalize">
                      Portal: {portalInviteData.status}
                    </p>
                  )}
                </div>

                <Separator />

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
                  <Link href={
                    `/dashboard/buyers/${selectedContactId}/offers/new` +
                    `?firstName=${encodeURIComponent(selectedContact?.first_name ?? "")}` +
                    `&lastName=${encodeURIComponent(selectedContact?.last_name ?? "")}` +
                    `&email=${encodeURIComponent(selectedContact?.email ?? "")}` +
                    `&phone=${encodeURIComponent(selectedContact?.phone ?? "")}` +
                    (relatedListing?.address ? `&propertyAddress=${encodeURIComponent(relatedListing.address)}` : "")
                  }>
                    <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs justify-start">
                      <TrendingUp className="h-3.5 w-3.5" />
                      Create Offer
                    </Button>
                  </Link>
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
                      Open Inbox
                    </Button>
                  </Link>
                </div>

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
                  </TabsList>

                  {/* ── OVERVIEW TAB ── */}
                  <TabsContent value="overview" className="space-y-4 mt-0">
                    {/* ContactOSSummary strip */}
                    <ContactOSSummary
                      contact={selectedContact}
                      copilotPlan={copilotPlan}
                      portalStatus={portalInviteStatus}
                      lastTouch={selectedContact.last_contacted_at ?? null}
                      onMessageClick={() =>
                        router.push(`/dashboard/inbox?contact=${selectedContactId}`)
                      }
                    />

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <RelationshipRadar
                        contactId={selectedContactId}
                        engagementScore={selectedContact.engagement_score}
                        daysSinceContact={daysSinceContact}
                        messageTemperature={null}
                        referralPotential={selectedContact.referral_potential}
                        openThreadCount={conversations.length}
                      />
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
                      />
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <ValueDeliveredPanel
                        contactId={selectedContactId}
                        agentId={agentId || ""}
                        valueMetrics={null}
                      />
                      <ReferralLikelihoodPanel
                        contactId={selectedContactId}
                        agentId={agentId || ""}
                        referralPotential={selectedContact.referral_potential}
                        onGenerateAsk={handleGenerateReferralAsk}
                        generating={referralGenerating}
                      />
                    </div>

                    {/* Buyer Intelligence — merged from former "Full Buyer Profile" button */}
                    {isBuyerContact && (buyerInsights || fatigueData) && (
                      <Card className="border-blue-200">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <UserCircle className="h-4 w-4 text-blue-600" />
                            Buyer Intelligence
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {fatigueData && (
                            <div className={cn("rounded p-2 text-sm",
                              fatigueData.risk_level === "critical" ? "bg-red-50 text-red-800" :
                              fatigueData.risk_level === "high"     ? "bg-orange-50 text-orange-800" :
                              fatigueData.risk_level === "moderate" ? "bg-amber-50 text-amber-800" :
                                                                      "bg-green-50 text-green-800"
                            )}>
                              <p className="font-medium capitalize">{fatigueData.risk_level} Fatigue Risk</p>
                              <p className="text-xs mt-0.5">
                                Score: {fatigueData.fatigue_score}/100 &middot; {fatigueData.days_searching} days searching &middot; {fatigueData.total_showings} showings
                              </p>
                            </div>
                          )}
                          {buyerInsights?.prediction && (
                            <div className="space-y-1 text-xs">
                              {buyerInsights.prediction.predicted_ready_to_offer && (
                                <p className="text-green-700 font-medium">Ready to make an offer</p>
                              )}
                              {buyerInsights.prediction.predicted_next_action && (
                                <p className="text-blue-700">Next predicted action: {buyerInsights.prediction.predicted_next_action}</p>
                              )}
                              {buyerInsights.prediction.engagement_velocity && (
                                <p className="text-muted-foreground capitalize">Engagement: {buyerInsights.prediction.engagement_velocity}</p>
                              )}
                            </div>
                          )}
                          {isBuyerContact && (
                            <BuyerMatchPanel
                              contactId={selectedContactId}
                              agentId={agentId || ""}
                              isBuyerContact={isBuyerContact}
                              buyerStage={selectedContact.buyer_stage}
                              contactName={`${selectedContact.first_name} ${selectedContact.last_name}`}
                            />
                          )}
                        </CardContent>
                      </Card>
                    )}

                    <TimelineContextPanel
                      contactId={selectedContactId}
                      originalLeadSource={selectedContact.lead_source}
                      createdAt={selectedContact.created_at}
                      isaHandoffContext={isaHandoffContext}
                    />
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
                            if (selectedContactId) router.push(`/dashboard/transactions/new?contactId=${encodeURIComponent(selectedContactId)}`)
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
                                      campaign_type: "nurture", status: "active", brokerage_id: brokerageId,
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

                    {/* AI-ISA stale contact takeover */}
                    {(() => {
                      const daysSince = selectedContact.last_contacted_at
                        ? Math.floor((Date.now() - new Date(selectedContact.last_contacted_at).getTime()) / (1000 * 60 * 60 * 24))
                        : null
                      if (daysSince == null || daysSince <= 14) return null
                      const currentPlan = copilotPlan ?? autopilotPlans.find((p: any) => p.contact_id === selectedContactId)
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
                              <span className="text-sm font-medium text-orange-800">Enable AI-ISA Follow-up</span>
                              <Switch
                                checked={!!currentPlan}
                                disabled={isPending}
                                onCheckedChange={(checked) => {
                                  if (checked) { handleEnableAutopilot("moderate") }
                                  else if (currentPlan) { handleToggleAutopilot(currentPlan.id, true) }
                                }}
                              />
                            </div>
                            {currentPlan && <p className="text-xs text-orange-600">AI-ISA is active on this contact</p>}
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
                          {contactActivities.map((item: any) => (
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
                              </div>
                            </div>
                          ))}
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

                </Tabs>
              </main>

            </div>
          </div>
        )}
      </div>
    )
  }

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
              : `${filtered.length} contact${filtered.length !== 1 ? "s" : ""}`}
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

      {/* Contact list */}
      {!loading && filtered.length > 0 && (
        <div className={cn("grid gap-3", searchLoading && "opacity-60 pointer-events-none")}>
          {filtered.map((contact) => (
            <Card
              key={contact.id}
              className="hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => handleSelectContact(contact.id)}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="font-semibold text-gray-900 truncate">
                        {contact.first_name} {contact.last_name}
                      </h3>
                      {contact.contact_type && (
                        <Badge
                          className={`text-xs ${
                            TYPE_COLORS[contact.contact_type] ?? TYPE_COLORS.other
                          }`}
                        >
                          {contact.contact_type}
                        </Badge>
                      )}
                      {contact.status && (
                        <Badge
                          className={`text-xs ${
                            STATUS_COLORS[contact.status] ??
                            "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {contact.status.replace(/_/g, " ")}
                        </Badge>
                      )}
                      {leadScores[contact.id] && (
                        <Badge
                          className={`text-xs ${
                            leadScores[contact.id].label === "High"
                              ? "bg-green-100 text-green-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                          title={`Conversion probability: ${leadScores[contact.id].score}%`}
                        >
                          <TrendingUp className="h-3 w-3 mr-1" />
                          {leadScores[contact.id].label} Conversion
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500">
                      {contact.email && (
                        <span className="flex items-center gap-1">
                          <Mail className="h-3.5 w-3.5" />
                          {contact.email}
                        </span>
                      )}
                      {contact.phone && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-3.5 w-3.5" />
                          {contact.phone}
                        </span>
                      )}
                      {(contact.city || contact.state) && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3.5 w-3.5" />
                          {[contact.city, contact.state]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

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
    </div>
  )
}
