"use client"

import { useEffect, useState, useCallback, useTransition } from "react"
import { useAuth } from "@/lib/auth/client"
import { useSearchParams, useRouter } from "next/navigation"
import { getContacts, getContactById, createContact, addContactNote } from "@/app/actions/contacts"
import { enableAIPilot, getActiveAutoPilotPlans, toggleAutoPilot, detectClientChurn, getConversationIntelligence, getPredictiveLeadScore } from "@/app/actions/ai-predictions"
import { generateContactInsights, draftSmartEmail } from "@/app/actions/ai-insights"
import type { ContactInsight } from "@/app/actions/ai-insights"
import { aiSuggestFollowUp } from "@/app/actions/ai-lead-nurturing"
import { aiOptimizeReferralAsk } from "@/app/actions/ai-sphere-management"
import { generateAIDraft } from "@/app/actions/portal-messages"
import { generateCopilotPlan } from "@/app/actions/workflows"
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
import { Textarea } from "@/components/ui/textarea"
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
  phone?: string
  contact_type?: string
  contact_persona?: string
  buyer_stage?: string
  status?: string
  city?: string
  state?: string
  lead_source?: string
  created_at?: string
  engagement_score?: number
  /** DB column: last_contacted_at */
  last_contacted_at?: string | null
  referral_potential?: "high" | "medium" | "low" | null
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
  const [suggestedActions, setSuggestedActions] = useState<any[]>([])
  const [conversations, setConversations] = useState<any[]>([])
  const [conversationIntelligence, setConversationIntelligence] = useState<any>(null)
  // Lead conversion probability — keyed by contact.id, High/Medium only per acceptance criteria
  const [leadScores, setLeadScores] = useState<Record<string, { label: "High" | "Medium"; score: number }>>({})
  const [buyerInsights, setBuyerInsights] = useState<any>(null)
  const [fatigueData, setFatigueData] = useState<any>(null)
  const [referralGenerating, setReferralGenerating] = useState(false)
  const [noteSaving, setNoteSaving] = useState(false)
  /** Lifted AI draft text — passed to CommunicationHealthPanel to pre-fill compose */
  const [pendingDraftText, setPendingDraftText] = useState<string | null>(null)

  // AI Priority Insights state
  const [contactInsights, setContactInsights] = useState<ContactInsight[]>([])
  const [loadingInsights, setLoadingInsights] = useState(false)
  const [draftingFor, setDraftingFor] = useState<string | null>(null)

  // Portal invite status for selected contact
  const [portalInviteStatus, setPortalInviteStatus] = useState<string | null>(null)

  // AI Copilot Plan state
  const [copilotPlan, setCopilotPlan] = useState<any>(null)
  const [loadingPlan, setLoadingPlan] = useState(false)
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
      .then(({ data }) => {
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
            .then(({ data: userData }) => {
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
        setFiltered(result.contacts)

        // Batch-fetch lead scores for first 20 contacts — silently, no blocking UI
        const slice = result.contacts.slice(0, 20)
        Promise.allSettled(slice.map((c: Contact) => getPredictiveLeadScore(c.id))).then((results) => {
          const scores: Record<string, { label: "High" | "Medium"; score: number }> = {}
          results.forEach((r, i) => {
            if (r.status === "fulfilled" && r.value && !r.value.error) {
              const val = r.value
              const pct: number = val.conversion_probability ?? val.score ?? 0
              if (pct >= 70) scores[slice[i].id] = { label: "High", score: pct }
              else if (pct >= 40) scores[slice[i].id] = { label: "Medium", score: pct }
              // Low is intentionally omitted per acceptance criteria
            }
          })
          setLeadScores(scores)
        })
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
        // Parallel data loads
        const [contactResult, churnResult, autopilotResult, followUpResult, convIntelResult] =
          await Promise.all([
            getContactById(contactId),
            detectClientChurn(contactId).catch(() => null),
            getActiveAutoPilotPlans(agentId).catch(() => []),
            aiSuggestFollowUp({ contactId, agentId }).catch(() => ({ suggestions: [] })),
            getConversationIntelligence(contactId).catch(() => null),
          ])

        if (contactResult?.success && contactResult.contact) {
          setSelectedContact(contactResult.contact)

          // Non-blocking buyer intelligence load — only for buyer/renter contacts
          const ct = contactResult.contact.contact_type?.toLowerCase() ?? ""
          if (ct === "buyer" || ct === "renter" || !!contactResult.contact.buyer_stage) {
            Promise.all([
              getBuyerInsights(contactId).catch(() => null),
              getBuyerFatigueScore(contactId).catch(() => null),
            ]).then(([insights, fatigue]) => {
              setBuyerInsights(insights ?? null)
              setFatigueData(fatigue ?? null)
            })
          }
        }

        // Fetch ISA qualification data — non-blocking
        const supabase = createClient()
        supabase
          .from("ai_isa_qualifications")
          .select("qualification_score, qualification_result, qualification_signals, assigned_at")
          .eq("contact_id", contactId)
          .order("qualified_at", { ascending: false })
          .limit(1)
          .maybeSingle()
          .then(({ data }) => {
            if (data) {
              setIsaHandoffContext({
                qualificationScore: data.qualification_score ?? undefined,
                qualificationResult: data.qualification_result ?? undefined,
                qualificationSignals: data.qualification_signals ?? undefined,
                assignedAt: data.assigned_at ?? undefined,
              })
            }
          })
          .catch(() => {/* non-blocking */})

        setChurnRisk(churnResult)
        setAutopilotPlans(autopilotResult || [])
        setSuggestedActions(followUpResult?.suggestions || [])
        setConversationIntelligence(convIntelResult && !convIntelResult.error ? convIntelResult : null)
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
      return
    }
    const supabase = createClient()
    supabase
      .from("portal_contact_invites")
      .select("status")
      .eq("contact_id", selectedContactId)
      .order("invited_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setPortalInviteStatus(data?.status ?? null))
      .catch(() => {/* non-blocking */})
  }, [selectedContactId])

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
      .then(({ data }) => {
        setCopilotPlan(data ?? null)
        setLoadingPlan(false)
      })
      .catch(() => setLoadingPlan(false))
  }, [selectedContactId])

  useEffect(() => {
    const q = search.toLowerCase()
    setFiltered(
      contacts.filter(
        (c) =>
          `${c.first_name} ${c.last_name}`.toLowerCase().includes(q) ||
          (c.email ?? "").toLowerCase().includes(q) ||
          (c.phone ?? "").includes(q) ||
          (c.city ?? "").toLowerCase().includes(q) ||
          (c.status ?? "").toLowerCase().includes(q) ||
          (c.contact_type ?? "").toLowerCase().includes(q)
      )
    )
  }, [search, contacts])

  // ── Add Contact dialog state ────────────────────────────────────────────────
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addForm, setAddForm] = useState({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    contact_type: "buyer" as "buyer" | "seller" | "both" | "investor",
    status: "new",
  })
  const [addFormError, setAddFormError] = useState<string | null>(null)
  const [addFormSubmitting, setAddFormSubmitting] = useState(false)

  const handleOpenAddDialog = () => {
    setAddForm({ first_name: "", last_name: "", email: "", phone: "", contact_type: "buyer", status: "new" })
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
      if (result.contact?.id) handleSelectContact(result.contact.id)
    } catch {
      setAddFormError("Unexpected error. Please try again.")
    } finally {
      setAddFormSubmitting(false)
    }
  }

  // Handlers for OS components
  const handleEnableAutopilot = async (level: "conservative" | "moderate" | "aggressive") => {
    if (!selectedContactId || !agentId) return
    startTransition(async () => {
      await enableAIPilot({ agentId, leadId: selectedContactId, autopilotLevel: level })
      const plans = await getActiveAutoPilotPlans(agentId)
      setAutopilotPlans(plans || [])
    })
  }

  const handleToggleAutopilot = async (planId: string, pause: boolean) => {
    startTransition(async () => {
      await toggleAutoPilot({ planId, pause })
      if (agentId) {
        const plans = await getActiveAutoPilotPlans(agentId)
        setAutopilotPlans(plans || [])
      }
    })
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
      await aiOptimizeReferralAsk({ contactId: selectedContactId, agentId })
    } finally {
      setReferralGenerating(false)
    }
  }

  const handleSaveNote = async (note: string) => {
    if (!selectedContactId) return
    setNoteSaving(true)
    try {
      const result = await addContactNote(selectedContactId, note)
      if (result.success) {
        toast.success("Note saved")
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
      <div className="p-6 space-y-6">
        {/* Back button */}
        <Button variant="ghost" size="sm" onClick={handleBackToList}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Contacts
        </Button>

        {detailLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
        ) : (
          <>
            {/* Contact Command Strip */}
            <ContactCommandStrip
              contact={selectedContact}
              churnRisk={churnRisk}
              autopilotPlans={autopilotPlans}
              agentId={agentId || ""}
              brokerageId={brokerageId || ""}
              onEnableAutopilot={handleEnableAutopilot}
              onToggleAutopilot={handleToggleAutopilot}
              loading={isPending}
            />

            {/* Contact OS Summary Strip */}
            <ContactOSSummary
              contact={selectedContact}
              copilotPlan={copilotPlan}
              portalStatus={portalInviteStatus}
              lastTouch={selectedContact.last_contacted_at ?? null}
              onMessageClick={() =>
                router.push(`/dashboard/inbox?contact=${selectedContactId}`)
              }
            />

            {/* Main content grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left column - Relationship data */}
              <div className="space-y-6">
                <RelationshipRadar
                  contactId={selectedContactId}
                  engagementScore={selectedContact.engagement_score}
                  daysSinceContact={daysSinceContact}
                  messageTemperature={null}
                  referralPotential={selectedContact.referral_potential}
                  openThreadCount={conversations.length}
                />

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

              {/* Center column - Communications & Actions */}
              <div className="space-y-6">
                <NextBestActionPanel
                  suggestedActions={suggestedActions}
                  contactId={selectedContactId}
                  contactPhone={selectedContact.phone}
                  contactEmail={selectedContact.email}
                  onSendMessage={(_channel) => {}}
                  onLogActivity={() => {}}
                  onOpenPortal={() => router.push(`/portal/${selectedContactId}`)}
                />

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
              </div>

              {/* Right column - AI Chat & Context */}
              <div className="space-y-6">
                {/* Conversation Intelligence — above AI Chat panel */}
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
                            <span className={`font-medium ${
                              conversationIntelligence.sentiment_score >= 0.6
                                ? "text-green-600"
                                : conversationIntelligence.sentiment_score >= 0.4
                                ? "text-amber-600"
                                : "text-red-600"
                            }`}>
                              {conversationIntelligence.sentiment_label ?? (
                                conversationIntelligence.sentiment_score >= 0.6 ? "Positive"
                                : conversationIntelligence.sentiment_score >= 0.4 ? "Neutral"
                                : "Negative"
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
                              <Badge key={i} variant="secondary" className="text-xs">
                                {t}
                              </Badge>
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

                {/* Buyer Intelligence — visible only for buyer/renter contacts */}
                {isBuyerContact && (buyerInsights || fatigueData) && (
                  <Card className="border-blue-200">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Buyer Intelligence</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {fatigueData && (
                        <div className={
                          fatigueData.risk_level === "critical" ? "rounded p-2 text-sm bg-red-50 text-red-800" :
                          fatigueData.risk_level === "high" ? "rounded p-2 text-sm bg-orange-50 text-orange-800" :
                          fatigueData.risk_level === "moderate" ? "rounded p-2 text-sm bg-amber-50 text-amber-800" :
                          "rounded p-2 text-sm bg-green-50 text-green-800"
                        }>
                          <p className="font-medium capitalize">{fatigueData.risk_level} Fatigue Risk</p>
                          <p className="text-xs mt-0.5">
                            Score: {fatigueData.fatigue_score}/100 &middot;{" "}
                            {fatigueData.days_searching} days searching &middot;{" "}
                            {fatigueData.total_showings} showings
                          </p>
                        </div>
                      )}

                      {buyerInsights?.prediction && (
                        <div className="space-y-1 text-xs">
                          {buyerInsights.prediction.predicted_ready_to_offer && (
                            <p className="text-green-700 font-medium">Ready to make an offer</p>
                          )}
                          {buyerInsights.prediction.predicted_next_action && (
                            <p className="text-blue-700">
                              Next predicted action: {buyerInsights.prediction.predicted_next_action}
                            </p>
                          )}
                          {buyerInsights.prediction.engagement_velocity && (
                            <p className="text-muted-foreground capitalize">
                              Engagement: {buyerInsights.prediction.engagement_velocity}
                            </p>
                          )}
                          {buyerInsights.prediction.confidence && (
                            <p className="text-muted-foreground">
                              Confidence: {Math.round(buyerInsights.prediction.confidence * 100)}%
                            </p>
                          )}
                        </div>
                      )}

                      <Button size="sm" variant="outline" className="w-full" asChild>
                        <Link href={`/dashboard/buyers/${selectedContactId}`}>
                          Full Buyer Profile
                        </Link>
                      </Button>
                    </CardContent>
                  </Card>
                )}

                <RelationshipAiChatPanel
                  contactId={selectedContactId}
                  agentId={agentId || ""}
                  contactName={`${selectedContact.first_name} ${selectedContact.last_name}`}
                  contactPersona={selectedContact.contact_persona}
                />

                <TimelineContextPanel
                  contactId={selectedContactId}
                  originalLeadSource={selectedContact.lead_source}
                  createdAt={selectedContact.created_at}
                  isaHandoffContext={isaHandoffContext}
                />

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
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={generatingPlan}
                            onClick={async () => {
                              const supabase = createClient()
                              await supabase
                                .from("copilot_plans")
                                .update({ status: "completed", updated_at: new Date().toISOString() })
                                .eq("id", copilotPlan.id)
                              toast.success("Action marked done — generating next plan...")
                              setGeneratingPlan(true)
                              const result = await generateCopilotPlan(selectedContactId, agentId ?? "")
                              if (result.success) { setCopilotPlan(result.plan ?? null) }
                              else { toast.error("Failed to generate next plan") }
                              setGeneratingPlan(false)
                            }}
                          >
                            Done
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              const supabase = createClient()
                              const newDate = new Date(copilotPlan.next_action_date || new Date())
                              newDate.setDate(newDate.getDate() + 3)
                              await supabase
                                .from("copilot_plans")
                                .update({ next_action_date: newDate.toISOString().split("T")[0] })
                                .eq("id", copilotPlan.id)
                              toast.success("Snoozed 3 days")
                              setCopilotPlan({ ...copilotPlan, next_action_date: newDate.toISOString().split("T")[0] })
                            }}
                          >
                            Snooze 3d
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={generatingPlan}
                            onClick={async () => {
                              setGeneratingPlan(true)
                              const result = await generateCopilotPlan(selectedContactId, agentId ?? "")
                              if (result.success) { setCopilotPlan(result.plan ?? null); toast.success("Plan updated") }
                              else { toast.error("Failed to generate plan") }
                              setGeneratingPlan(false)
                            }}
                          >
                            {generatingPlan ? <Loader2 className="h-3 w-3 animate-spin" /> : "Refresh"}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">No active plan for this contact</p>
                        <Button
                          size="sm"
                          disabled={generatingPlan}
                          onClick={async () => {
                            setGeneratingPlan(true)
                            const result = await generateCopilotPlan(selectedContactId, agentId ?? "")
                            if (result.success) {
                              setCopilotPlan(result.plan ?? null)
                              toast.success("7-day plan created")
                            } else {
                              toast.error("Failed to generate plan")
                            }
                            setGeneratingPlan(false)
                          }}
                        >
                          {generatingPlan ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-2" />Generating...</>
                          ) : (
                            <><Sparkles className="h-4 w-4 mr-2" />Generate 7-Day Plan</>
                          )}
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
                  const currentPlan = autopilotPlans.find((p: any) => p.contact_id === selectedContactId || p.lead_id === selectedContactId)
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
                              if (checked) {
                                handleEnableAutopilot("moderate")
                              } else if (currentPlan) {
                                handleToggleAutopilot(currentPlan.id, true)
                              }
                            }}
                          />
                        </div>
                        {currentPlan && (
                          <p className="text-xs text-orange-600">AI-ISA is active on this contact</p>
                        )}
                      </CardContent>
                    </Card>
                  )
                })()}

                {/* Buyer Match Panel - only for buyer contacts */}
                {isBuyerContact && (
                  <BuyerMatchPanel
                    contactId={selectedContactId}
                    agentId={agentId || ""}
                    isBuyerContact={isBuyerContact}
                    buyerStage={selectedContact.buyer_stage}
                    contactName={`${selectedContact.first_name} ${selectedContact.last_name}`}
                  />
                )}
              </div>
            </div>

            {/* Cross-link footer */}
            <div className="flex gap-4 pt-4 border-t text-sm">
              <Link href="/dashboard/reports" className="text-muted-foreground hover:text-foreground transition-colors">
                View Reports →
              </Link>
              <Link href="/dashboard/reputation" className="text-muted-foreground hover:text-foreground transition-colors">
                Full Reputation →
              </Link>
              <Link href="/dashboard/diagnosis" className="text-muted-foreground hover:text-foreground transition-colors">
                Run Diagnosis →
              </Link>
            </div>
          </>
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
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
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
                          toast.success(`Draft created for ${displayName} — review in Communications`)
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
        <div className="grid gap-3">
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
