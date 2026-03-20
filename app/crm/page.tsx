"use client"

import { useEffect, useState, useCallback, useTransition } from "react"
import { useAuth } from "@/lib/auth/client"
import { useSearchParams, useRouter } from "next/navigation"
import { getContacts, getContactById } from "@/app/actions/contacts"
import { enableAIPilot, getActiveAutoPilotPlans, toggleAutoPilot, detectClientChurn } from "@/app/actions/ai-predictions"
import { aiSuggestFollowUp } from "@/app/actions/ai-lead-nurturing"
import { aiOptimizeReferralAsk } from "@/app/actions/ai-sphere-management"
import { generateAIDraft } from "@/app/actions/portal-messages"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
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
} from "lucide-react"
import Link from "next/link"

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
  last_contact_date?: string
  referral_potential?: "high" | "medium" | "low"
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

export default function CRMPage() {
  const { user, loading: authLoading } = useAuth()
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

  // Agent context (resolved from user)
  const [agentId, setAgentId] = useState<string | null>(null)

  // Contact OS data
  const [churnRisk, setChurnRisk] = useState<any>(null)
  const [autopilotPlans, setAutopilotPlans] = useState<any[]>([])
  const [suggestedActions, setSuggestedActions] = useState<any[]>([])
  const [conversations, setConversations] = useState<any[]>([])
  const [referralGenerating, setReferralGenerating] = useState(false)
  const [noteSaving, setNoteSaving] = useState(false)

  // Resolve agentId from user context
  useEffect(() => {
    if (user?.id) {
      // The agentId is typically available from user metadata or needs to be resolved
      // For now, we'll use the user.id as a fallback - real implementation would query agents table
      setAgentId(user.id)
    }
  }, [user])

  const loadContacts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getContacts({ limit: 100 })
      if (result.success) {
        setContacts(result.contacts)
        setFiltered(result.contacts)
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
      if (!agentId) return

      setDetailLoading(true)
      try {
        // Parallel data loads
        const [contactResult, churnResult, autopilotResult, followUpResult] =
          await Promise.all([
            getContactById(contactId),
            detectClientChurn(contactId).catch(() => null),
            getActiveAutoPilotPlans(agentId).catch(() => []),
            aiSuggestFollowUp({ contactId, agentId }).catch(() => ({ suggestions: [] })),
          ])

        if (contactResult?.success && contactResult.contact) {
          setSelectedContact(contactResult.contact)
        }

        setChurnRisk(churnResult)
        setAutopilotPlans(autopilotResult || [])
        setSuggestedActions(followUpResult?.suggestions || [])
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
    if (selectedContactId && agentId) {
      loadContactDetail(selectedContactId)
    }
  }, [selectedContactId, agentId, loadContactDetail])

  useEffect(() => {
    const q = search.toLowerCase()
    setFiltered(
      contacts.filter(
        (c) =>
          `${c.first_name} ${c.last_name}`.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          c.phone?.includes(q) ||
          c.city?.toLowerCase().includes(q)
      )
    )
  }, [search, contacts])

  // Handlers for OS components
  const handleEnableAutopilot = async (level: "conservative" | "moderate" | "aggressive") => {
    if (!selectedContactId || !agentId) return
    startTransition(async () => {
      await enableAIPilot({ contactId: selectedContactId, agentId, level })
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

  const handleLoadDraft = async (conversationId: string) => {
    if (!selectedContactId || !agentId) return
    await generateAIDraft({
      contactId: selectedContactId,
      agentId,
      conversationId,
    })
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
    if (!selectedContactId || !agentId) return
    setNoteSaving(true)
    try {
      // Save note via API - would connect to real note saving action
      console.log("[v0] Saving note for contact:", selectedContactId, note)
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

  // Contact Detail View
  if (selectedContactId && selectedContact) {
    const isBuyerContact =
      selectedContact.contact_type?.toLowerCase().includes("buyer") ||
      !!selectedContact.buyer_stage

    const daysSinceContact = selectedContact.last_contact_date
      ? Math.floor(
          (Date.now() - new Date(selectedContact.last_contact_date).getTime()) /
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
              onEnableAutopilot={handleEnableAutopilot}
              onToggleAutopilot={handleToggleAutopilot}
              loading={isPending}
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
                  onSendMessage={(channel) => console.log("[v0] Send message via:", channel)}
                  onLogActivity={() => console.log("[v0] Log activity")}
                  onOpenPortal={() => router.push(`/portal/${selectedContactId}`)}
                />

                <CommunicationHealthPanel
                  conversations={conversations}
                  agentId={agentId || ""}
                  contactId={selectedContactId}
                  onLoadDraft={handleLoadDraft}
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
                />

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
            asChild
          >
            <Link href="/crm?action=new">
              <Plus className="h-4 w-4 mr-2" />
              Add Contact
            </Link>
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
              asChild
            >
              <Link href="/crm?action=new">
                <Plus className="h-4 w-4 mr-2" />
                Add Contact
              </Link>
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
                    <div className="flex items-center gap-2 mb-1">
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
    </div>
  )
}
