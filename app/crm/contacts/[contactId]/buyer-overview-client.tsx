"use client"

import { useState, useCallback }             from "react"
import Link                                   from "next/link"
import { cn }                                 from "@/lib/utils"
import { BuyerStageProgress }                 from "./components/buyer-stage-progress"
import { FinancialVerificationPanel }         from "./components/financial-verification-panel"
import { BuyerCoachingCard }                  from "./components/buyer-coaching-card"
import { ConversationCoachingPanel }          from "./components/conversation-coaching-panel"
import BuyerInsightsPanel                     from "./components/buyer-insights-panel"
import { FatiguePanel }                       from "./components/fatigue-panel"
import { BuyerEngagementHealthCard }          from "./components/buyer-engagement-health-card"
import { BuyerLifecyclePanel }               from "./components/buyer-lifecycle-panel"
import { FatigueWidget }                      from "./components/fatigue-widget"
import { TourPipelineStepper }                from "@/app/components/shared/TourPipelineStepper"
import { createTourPlan }                     from "@/app/actions/tour-planner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button }                             from "@/components/ui/button"
import { Badge }                              from "@/components/ui/badge"
import { Users, Calendar, AlertTriangle, Zap, Loader2, FileText, Home } from "lucide-react"
import { enableAIPilot, getActiveAutoPilotPlans, toggleAutoPilot, aiPropertyMatchGenius } from "@/app/actions/ai-predictions"
import { upsertFinancialProfile }             from "@/app/actions/buyer-financial"
import { toast }                              from "sonner"
import { timelineLabel }                      from "@/constants/crm-standards"

// ─── GATE MODAL ───────────────────────────────────────────────────────────────

interface GateModalProps {
  title:   string
  body:    string
  primaryCta: string
  onPrimary: () => void
  onClose:   () => void
}

function GateModal({ title, body, primaryCta, onPrimary, onClose }: GateModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-card shadow-xl p-6 space-y-4">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
        <div className="flex gap-3 pt-1">
          <button
            onClick={onPrimary}
            className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {primaryCta}
          </button>
          <button
            onClick={onClose}
            className="flex-1 rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            Remind Me Later
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── PERSONA-AWARE GATE COPY ─────────────────────────────────────────────────

function getTourGateCopy(persona: string | null) {
  switch (persona) {
    case "analytical":
      return {
        title: "Financial Verification Required",
        body:  "Verifying your purchasing capacity protects your position in competitive offer situations.",
      }
    case "emotional":
      return {
        title: "One Quick Step Before Scheduling",
        body:  "Let's make sure you're fully prepared — it creates a much stronger impression with the seller.",
      }
    case "direct":
      return {
        title: "Complete Verification First",
        body:  "Upload your pre-approval or proof of funds. Takes 2 minutes.",
      }
    default:
      return {
        title: "Before We Schedule",
        body:  "We need to verify financing before scheduling showings.",
      }
  }
}

function getOfferGateCopy() {
  return {
    title:    "Tour Phase Required",
    body:     "Schedule and complete at least one showing before submitting an offer.",
    cta:      "Schedule a Showing",
  }
}

// ─── TABS ────────────────────────────────────────────────────────────────────

const TABS = ["Overview", "Search", "Alerts", "Tours", "Fatigue", "Offers", "Lifecycle"] as const
type Tab = typeof TABS[number]

// ─── MAIN CLIENT SHELL ───────────────────────────────────────────────────────

interface BuyerOverviewClientProps {
  buyerId:       string
  contact:       any
  journey:       any
  profile:       any | null
  partners:      any[]
  drafts:        any[]
  propertyInterests: any | null
  brokerageId:   string
  agentUserId:   string
  agentName:     string
  collaborativeSearches: any[]
  activeSearch:  any | null
  consensus:     any | null
  tours:         any[]
  nextTour:      any | null
  dualAgencyListings: Array<{ listing_id: string; address: string }> | null
  enabledGates?: string[]
  /** Decided on the SERVER by lib/buyer-lifecycle/gating-helpers:isOfferAllowed.
   *  Never re-derive it here: the gate reads lifecycle state and financial verification
   *  with the service-role client, which must never reach a client bundle. */
  offerAllowed?: boolean
}

export function BuyerOverviewClient({
  buyerId, contact, journey, profile, partners, drafts,
  propertyInterests, brokerageId, agentUserId, agentName,
  collaborativeSearches, activeSearch, consensus, tours, nextTour,
  dualAgencyListings, enabledGates = [], offerAllowed = false,
}: BuyerOverviewClientProps) {
  const [activeTab, setActiveTab]   = useState<Tab>("Overview")
  const [gateModal, setGateModal]   = useState<GateModalProps | null>(null)
  const [verified, setVerified]     = useState(profile?.verified === true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [autopilotPlans, setAutopilotPlans] = useState<any[]>([])
  const [isLoadingAI, setIsLoadingAI] = useState(false)
  const [financeType, setFinanceType] = useState<string>(
    profile?.is_cash_buyer ? "cash" : (profile?.finance_type ?? "")
  )
  const [savingFinance, setSavingFinance] = useState(false)
  const [aiMatchResult, setAiMatchResult] = useState<any>(null)
  const [isLoadingMatch, setIsLoadingMatch] = useState(false)

  const currentStage = contact.buyer_stage ?? "BUYER_CONTACT_CREATED"
  const persona      = contact.contact_persona ?? null
  const buyerName    = `${contact.first_name} ${contact.last_name}`

  const blockers: string[] = []
  if (!verified) {
    blockers.push("Financial verification required before scheduling")
  }

  // Load autopilot plans
  const loadAutopilotPlans = useCallback(async () => {
    try {
      const result = await getActiveAutoPilotPlans(agentUserId)
      if (Array.isArray(result) && result.length > 0) {
        setAutopilotPlans(result)
      }
    } catch (err) {
      console.error("[v0] Failed to load autopilot plans:", err)
    }
  }, [agentUserId])

  useState(() => {
    loadAutopilotPlans()
  })

  const activePlan = autopilotPlans.find((p: any) => p.contact_id === buyerId || p.lead_id === buyerId)

  async function handleEnableAI() {
    setIsLoadingAI(true)
    try {
      const result = await enableAIPilot({ agentId: agentUserId, leadId: buyerId, autopilotLevel: "moderate" })
      if (result.success) {
        toast.success("AI-ISA enabled for " + buyerName)
        await loadAutopilotPlans()
      } else {
        toast.error(result.error || "Failed to enable AI-ISA")
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to enable AI-ISA")
    } finally {
      setIsLoadingAI(false)
    }
  }

  async function handleToggleAI() {
    if (!activePlan) return
    setIsLoadingAI(true)
    try {
      const result = await toggleAutoPilot(activePlan.id, !activePlan.is_paused)
      if (result.success) {
        toast.success(activePlan.is_paused ? "AI-ISA resumed" : "AI-ISA paused")
        await loadAutopilotPlans()
      } else {
        toast.error((result as any).error || "Failed to toggle AI-ISA")
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to toggle AI-ISA")
    } finally {
      setIsLoadingAI(false)
    }
  }

  async function handleFinanceTypeChange(newType: string) {
    if (!profile || !newType) return
    setSavingFinance(true)
    try {
      const result = await upsertFinancialProfile({
        contactId:   buyerId,
        brokerageId,
        agentUserId,
        financeType:  newType as "conventional" | "fha" | "va" | "cash" | "other",
        isCashBuyer: newType === "cash",
      })
      if (result.success) {
        setFinanceType(newType)
        toast.success("Finance type updated")
      } else {
        toast.error(result.error ?? "Failed to update finance type")
      }
    } catch (err: any) {
      toast.error(err.message ?? "Failed to update finance type")
    } finally {
      setSavingFinance(false)
    }
  }

  function handleVerified() {
  setVerified(true)
  setRefreshKey(k => k + 1)
  }

  function scrollToVerification() {
    document.getElementById("financial-verification-panel")?.scrollIntoView({ behavior: "smooth" })
    setGateModal(null)
  }

  function openTourGate() {
    const copy = getTourGateCopy(persona)
    setGateModal({
      title:      copy.title,
      body:       copy.body,
      primaryCta: "Complete Verification",
      onPrimary:  scrollToVerification,
      onClose:    () => setGateModal(null),
    })
  }

  function openOfferGate() {
    const copy = getOfferGateCopy()
    setGateModal({
      title:      copy.title,
      body:       copy.body,
      primaryCta: copy.cta,
      onPrimary:  () => { setActiveTab("Search"); setGateModal(null) },
      onClose:    () => setGateModal(null),
    })
  }

  // Next steps from journey
  const nextSteps: string[] = journey?.message
    ? []
    : (journey?.nextSteps ?? [])

  return (
    <>
      {/* Gate modal */}
      {gateModal && <GateModal {...gateModal} />}

      {/* Page header */}
      <div className="border-b border-border bg-card px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold">{buyerName}</h1>
              {activePlan && (
                <Badge className="text-xs bg-indigo-100 text-indigo-700 border-0">
                  <Zap className="h-3 w-3 mr-1" />
                  AI-ISA Active
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap text-sm text-muted-foreground">
              {contact.email && <span>{contact.email}</span>}
              {contact.phone && <span>{contact.phone}</span>}
              {contact.status && <span className="capitalize">{contact.status}</span>}
              {contact.timeline && <span>{timelineLabel(contact.timeline)}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {!activePlan ? (
              <Button
                size="sm"
                variant="outline"
                disabled={isLoadingAI}
                onClick={handleEnableAI}
              >
                {isLoadingAI ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Zap className="h-3 w-3 mr-1" />}
                Enable AI-ISA
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={isLoadingAI}
                onClick={handleToggleAI}
              >
                {activePlan.is_paused ? "Resume AI-ISA" : "Pause AI-ISA"}
              </Button>
            )}
            <Link
              href={`/crm/contacts/${buyerId}/offers/new`}
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors"
            >
              <FileText className="h-3 w-3" />
              Create Offer
            </Link>
            <Link
              href={`/crm/contacts/${buyerId}/listings/new`}
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors"
            >
              <Home className="h-3 w-3" />
              Create Listing
            </Link>
            <Link
              href={`/crm/contacts/${buyerId}/search`}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Search Properties
            </Link>
          </div>
        </div>
      </div>

      {/* Sticky tab bar */}
      <div className="sticky top-0 z-10 border-b border-border bg-background">
        <nav className="flex px-6 overflow-x-auto">
          {TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                activeTab === tab
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === "Fatigue" ? (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <FatiguePanel contactId={buyerId} brokerageId={brokerageId} />
        </div>
      ) : activeTab === "Offers" ? (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Decided on the server (see page.tsx). This used to call the async
              isOfferAllowed here and branch on the returned PROMISE, which is always
              truthy — so this path rendered open for every buyer, whatever their
              lifecycle state or financial verification said. */}
          {offerAllowed ? (
            <Link
              href={`/crm/contacts/${buyerId}/offers`}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Open Offer Builder
            </Link>
          ) : (
            <div className="rounded-lg border border-border bg-card p-5 space-y-2">
              <p className="text-sm font-medium">Offer phase not yet unlocked</p>
              <p className="text-xs text-muted-foreground">
                Complete at least one tour before creating an offer.
              </p>
              <button
                onClick={openOfferGate}
                className="mt-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted/50 transition-colors"
              >
                What&apos;s required?
              </button>
            </div>
          )}
        </div>
      ) : activeTab === "Lifecycle" ? (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <BuyerLifecyclePanel
            contactId={buyerId}
            agentId={agentUserId}
            brokerageId={brokerageId}
            userRole="agent"
          />
        </div>
      ) : activeTab === "Search" ? (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-semibold">Property Search</h2>
                <p className="text-sm text-muted-foreground">Search and save properties for {buyerName}</p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isLoadingMatch}
                  onClick={async () => {
                    setIsLoadingMatch(true)
                    try {
                      const result = await aiPropertyMatchGenius(buyerId)
                      setAiMatchResult(result)
                    } catch {
                      setAiMatchResult(null)
                    } finally {
                      setIsLoadingMatch(false)
                    }
                  }}
                >
                  {isLoadingMatch ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Zap className="h-4 w-4 mr-1" />}
                  AI Match
                </Button>
                <Link href={`/crm/contacts/${buyerId}/search`}>
                  <Button>Advanced Search</Button>
                </Link>
              </div>
            </div>

            {aiMatchResult && (
              <Card className="border-violet-200 bg-violet-50/50 dark:bg-violet-950/10">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Zap className="h-4 w-4 text-violet-600" />
                    AI Property Match Results
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {aiMatchResult.success === false ? (
                    <p className="text-sm text-muted-foreground">{aiMatchResult.error ?? "No matches found."}</p>
                  ) : (
                    <div className="space-y-2">
                      {Array.isArray(aiMatchResult.topMatches) && aiMatchResult.topMatches.length > 0 ? (
                        aiMatchResult.topMatches.slice(0, 5).map((m: any, i: number) => (
                          <div key={i} className="flex items-center justify-between py-1.5 border-b last:border-0">
                            <div>
                              <p className="text-sm font-medium">{m.address ?? m.property_address ?? `Property ${i + 1}`}</p>
                              {m.listPrice && <p className="text-xs text-muted-foreground">${Number(m.listPrice).toLocaleString()}</p>}
                            </div>
                            {m.aiMatchScore != null && (
                              <Badge variant="secondary" className="text-xs">{Math.round(m.aiMatchScore)}% match</Badge>
                            )}
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {aiMatchResult.message ?? "AI match analysis complete. Run Advanced Search to see full results."}
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
            
            {/* Saved Properties */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Saved Properties</CardTitle>
              </CardHeader>
              <CardContent>
                {propertyInterests ? (
                  <div className="space-y-3">
                    <p className="text-sm">
                      {buyerName} has saved properties matching their criteria.
                    </p>
                    <Link href={`/crm/contacts/${buyerId}/search`}>
                      <Button variant="outline" className="w-full">View All Saved Properties</Button>
                    </Link>
                  </div>
                ) : (
                  <div className="text-center py-8 space-y-3">
                    <p className="text-sm text-muted-foreground">No saved properties yet</p>
                    <Link href={`/crm/contacts/${buyerId}/search`}>
                      <Button>Start Property Search</Button>
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Active Alerts */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Property Alerts</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Set up automated property alerts to notify {buyerName} of new listings
                  </p>
                  <div className="flex gap-2">
                    <Link href={`/crm/contacts/${buyerId}/search`} className="flex-1">
                      <Button variant="outline" className="w-full">Manage Alerts</Button>
                    </Link>
                    <Button onClick={() => setActiveTab("Alerts")}>Create Alert</Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : activeTab === "Tours" ? (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Tour Planning</h2>
                <p className="text-sm text-muted-foreground">Schedule and manage property tours for {buyerName}</p>
              </div>
              <Link href={`/crm/contacts/${buyerId}/tours`}>
                <Button>Open Tour Planner</Button>
              </Link>
            </div>

            {/* Tour Stats */}
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-center">
                    <p className="text-2xl font-bold">{tours.length}</p>
                    <p className="text-xs text-muted-foreground mt-1">Total Tours</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-center">
                    <p className="text-2xl font-bold">{propertyInterests ? 1 : 0}</p>
                    <p className="text-xs text-muted-foreground mt-1">Saved Properties</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-center">
                    <p className="text-2xl font-bold">{nextTour ? '1' : '0'}</p>
                    <p className="text-xs text-muted-foreground mt-1">Upcoming Tours</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Next Scheduled Tour */}
            {nextTour ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Next Scheduled Tour</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">
                        {new Date(nextTour.tour_date).toLocaleDateString('en-US', {
                          weekday: 'long',
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric'
                        })}
                      </p>
                      <p className="text-sm text-muted-foreground mt-1">
                        View full tour details in the Tour Planner
                      </p>
                    </div>
                    <Link href={`/crm/contacts/${buyerId}/tours`}>
                      <Button variant="outline">View Details</Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="py-8 text-center space-y-3">
                  <Calendar className="h-12 w-12 mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No upcoming tours scheduled</p>
                  <Link href={`/crm/contacts/${buyerId}/tours`}>
                    <Button>Schedule a Tour</Button>
                  </Link>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      ) : activeTab === "Alerts" ? (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Property Alerts</h2>
                <p className="text-sm text-muted-foreground">Automated notifications for {buyerName}</p>
              </div>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Alert Management</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Property alerts automatically notify buyers when new listings match their criteria. Set up price drops, new listings, and open house alerts.
                </p>
                
                <div className="space-y-3">
                  <div className="flex items-start gap-3 p-3 border rounded-lg">
                    <AlertTriangle className="h-5 w-5 text-blue-600 mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">New Listing Alerts</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Get notified when properties matching saved criteria hit the market
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 p-3 border rounded-lg">
                    <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">Price Drop Alerts</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Be the first to know when saved properties reduce their price
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 p-3 border rounded-lg">
                    <Calendar className="h-5 w-5 text-green-600 mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">Open House Alerts</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Receive notifications about upcoming open houses
                      </p>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t">
                  <Link href={`/crm/contacts/${buyerId}/search`}>
                    <Button className="w-full">Configure Alerts in Search</Button>
                  </Link>
                  <p className="text-xs text-muted-foreground text-center mt-2">
                    Alerts are managed within the property search interface
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        /* Overview — 3-column layout */
        <div className="flex flex-1 min-h-0 overflow-auto">
          {/* LEFT — stage progress (280px) */}
          <aside className="w-[280px] flex-shrink-0 border-r border-border overflow-y-auto">
            <BuyerStageProgress
              currentStage={currentStage}
              blockers={blockers}
              contactId={buyerId}
              agentId={agentUserId}
            />
          </aside>

          {/* CENTER — main content */}
          <main className="flex-1 min-w-0 overflow-y-auto px-6 py-5 space-y-5">
            {/* 0. Buyer Operations Panel */}
            <div className="space-y-4 mb-6">

              {/* Tour Pipeline Stepper */}
              <TourPipelineStepper
                contactId={buyerId}
                savedCount={propertyInterests ? 1 : 0}
                tourCount={tours.length}
                buyerStage={contact.buyer_stage}
              />

              {/* Dual Agency Opportunity Alert */}
              {dualAgencyListings && dualAgencyListings.length > 0 && (
                <Card className="border-amber-200 bg-amber-50">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-semibold text-amber-900">
                          Dual Agency Opportunity — Disclosure Required
                        </p>
                        <p className="text-sm text-amber-700 mt-1">
                          This buyer has saved {dualAgencyListings.length} of your listing{dualAgencyListings.length > 1 ? "s" : ""}.
                          If they make an offer, you represent both buyer and seller.
                          Verify your state&apos;s dual agency disclosure requirements.
                        </p>
                        <div className="mt-2 space-y-1">
                          {dualAgencyListings.map(sp => (
                            <Link
                              key={sp.listing_id}
                              href={`/dashboard/listings/${sp.listing_id}`}
                              className="text-xs text-amber-600 hover:underline block"
                            >
                              {sp.address}
                            </Link>
                          ))}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Collaborative Search Intelligence */}
              {activeSearch && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Users className="h-4 w-4 text-purple-600" />
                      Family Search Consensus
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {activeSearch.collaborative_search_members?.length || 0} decision-makers in this search
                    </p>
                    {consensus?.topProperty && (
                      <div className="p-2 bg-green-50 border border-green-200 rounded text-xs">
                        <span className="font-medium">Top pick: </span>
                        {consensus.topProperty.address || 'Property consensus available'}
                      </div>
                    )}
                    {consensus?.disagreements?.length > 0 && (
                      <div className="p-2 bg-amber-50 border border-amber-200 rounded text-xs">
                        <span className="font-medium">Friction point: </span>
                        {consensus.disagreements[0]}
                      </div>
                    )}
                    <Link href={`/crm/contacts/${buyerId}/search`}>
                      <Button size="sm" variant="outline" className="text-xs w-full">View Full Family Search</Button>
                    </Link>
                  </CardContent>
                </Card>
              )}

              {/* Tour Operations */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-blue-600" />
                    Tour Operations
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex gap-4 text-sm">
                    <span><span className="font-medium">{propertyInterests ? 1 : 0}</span> saved homes</span>
                    <span><span className="font-medium">{tours.length}</span> tours on file</span>
                  </div>
                  {nextTour && (
                    <p className="text-xs text-muted-foreground">
                      Next tour: {new Date(nextTour.tour_date).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}
                    </p>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    <Link href={`/crm/contacts/${buyerId}/tours`}>
                      <Button size="sm" className="text-xs">Open Tour Planner</Button>
                    </Link>
                    <Link href={`/crm/contacts/${buyerId}/search`}>
                      <Button size="sm" variant="outline" className="text-xs">Property Search</Button>
                    </Link>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      onClick={async () => {
                        await createTourPlan({ contactId: buyerId } as any)
                      }}
                    >
                      Quick Create Tour Plan
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Use the Quick Create action only if the page already supports inline success/error handling. Otherwise keep Open Tour Planner as the primary CTA.
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Buyer Engagement Health — System 5.8 fatigue signal surfaced in Overview */}
            <BuyerEngagementHealthCard buyerId={buyerId} brokerageId={brokerageId} />

            {/* 1. Financial Verification Panel */}
            <div id="financial-verification-panel">
              <FinancialVerificationPanel
                key={refreshKey}
                contactId={buyerId}
                brokerageId={brokerageId}
                agentUserId={agentUserId}
                agentName={agentName}
                buyerName={buyerName}
                buyerStage={currentStage}
                profile={verified ? { ...profile, verified: true } : profile}
                partners={partners}
                onVerified={handleVerified}
              />
            </div>

            {/* 2. Buyer Coaching Card */}
            <BuyerCoachingCard contactId={buyerId} brokerageId={brokerageId} />

            {/* 3. AI Buyer Insights (also rendered in right column above fatigue) */}

            {/* 5. Next Steps Panel */}
            <div className="rounded-lg border border-border bg-card p-5">
              <h3 className="text-sm font-semibold mb-3">Next Steps</h3>
              {nextSteps.length === 0 ? (
                <p className="text-sm text-muted-foreground">Buyer is on track — no blockers</p>
              ) : (
                <ul className="space-y-2">
                  {nextSteps.map((step: string, i: number) => (
                    <li key={i} className="flex items-start gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full border-2 border-muted-foreground/30 mt-0.5" />
                      <span className="text-sm">{step}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 6. Buyer Readiness — gate status panel */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Buyer Readiness</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-3">
                  {/* Search gate */}
                  <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border p-3">
                    <span className="text-xs text-muted-foreground font-medium">Search</span>
                    {enabledGates.includes("search") || enabledGates.includes("property_search") ? (
                      <Badge className="bg-green-100 text-green-800 border-green-200 text-xs font-normal">Enabled</Badge>
                    ) : (
                      <Badge className="bg-muted text-muted-foreground border-border text-xs font-normal">Locked</Badge>
                    )}
                  </div>
                  {/* Tours gate */}
                  <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border p-3">
                    <span className="text-xs text-muted-foreground font-medium">Tours</span>
                    {enabledGates.includes("tour_scheduling") || enabledGates.includes("tour_eligibility") ? (
                      <Badge className="bg-green-100 text-green-800 border-green-200 text-xs font-normal">Enabled</Badge>
                    ) : (
                      <Badge className="bg-muted text-muted-foreground border-border text-xs font-normal">Locked</Badge>
                    )}
                  </div>
                  {/* Offers gate */}
                  <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border p-3">
                    <span className="text-xs text-muted-foreground font-medium">Offers</span>
                    {enabledGates.includes("offer_creation") || enabledGates.includes("offer_eligibility") ? (
                      <Badge className="bg-green-100 text-green-800 border-green-200 text-xs font-normal">Enabled</Badge>
                    ) : (
                      <Badge className="bg-muted text-muted-foreground border-border text-xs font-normal">Locked</Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 7. Key Info Strip */}
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold">Key Information</h3>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Source</p>
                  <p className="font-medium">{contact.source ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Timeline</p>
                  <p className="font-medium">{timelineLabel(contact.timeline) ?? "—"}</p>
                </div>
                {profile && (
                  <>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Finance type</p>
                      <select
                        value={financeType}
                        disabled={savingFinance}
                        onChange={(e) => handleFinanceTypeChange(e.target.value)}
                        className="text-sm font-medium border border-border rounded px-2 py-1 bg-background text-foreground w-full disabled:opacity-50"
                      >
                        <option value="">— select —</option>
                        <option value="conventional">Conventional</option>
                        <option value="cash">Cash</option>
                        <option value="fha">FHA</option>
                        <option value="va">VA</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Pre-approval</p>
                      <p className="font-medium">
                        {profile.pre_approval_amount
                          ? `$${Number(profile.pre_approval_amount).toLocaleString()}`
                          : "—"}
                      </p>
                    </div>
                  </>
                )}
                {propertyInterests && (
                  <>
                    <div>
                      <p className="text-xs text-muted-foreground">Price range</p>
                      <p className="font-medium">
                        {propertyInterests.min_price || propertyInterests.max_price
                          ? `$${(propertyInterests.min_price ?? 0).toLocaleString()} – $${(propertyInterests.max_price ?? 0).toLocaleString()}`
                          : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Beds / Baths</p>
                      <p className="font-medium">
                        {propertyInterests.bedrooms ?? "—"} bd / {propertyInterests.bathrooms ?? "—"} ba
                      </p>
                    </div>
                    {(propertyInterests.preferred_locations?.length > 0 || propertyInterests.zip_codes?.length > 0) && (
                      <div className="col-span-2">
                        <p className="text-xs text-muted-foreground">Locations</p>
                        <p className="font-medium text-sm">
                          {[
                            ...(propertyInterests.preferred_locations ?? []),
                            ...(propertyInterests.zip_codes ?? []),
                          ].join(", ")}
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </main>

          {/* RIGHT — AI Buyer Insights + conversation coaching (320px) */}
          <aside className="w-[320px] flex-shrink-0 border-l border-border overflow-y-auto px-4 py-5 space-y-5">
            {/* AI Buyer Insights — top of right column */}
            <BuyerInsightsPanel contactId={buyerId} brokerageId={brokerageId} />

            {/* Fatigue Widget — below insights, above coaching */}
            <FatigueWidget
              contactId={buyerId}
              brokerageId={brokerageId}
              agentUserId={agentUserId}
            />

            <ConversationCoachingPanel
              contactId={buyerId}
              brokerageId={brokerageId}
              agentUserId={agentUserId}
              initialDrafts={drafts}
            />
          </aside>
        </div>
      )}
    </>
  )
}
