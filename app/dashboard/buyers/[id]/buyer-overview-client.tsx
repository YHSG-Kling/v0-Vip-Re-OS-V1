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
import { isTourAllowed, isOfferAllowed }      from "@/lib/buyer-lifecycle/gating-helpers"

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

const TABS = ["Overview", "Search", "Alerts", "Tours", "Fatigue", "Offers"] as const
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
}

export function BuyerOverviewClient({
  buyerId, contact, journey, profile, partners, drafts,
  propertyInterests, brokerageId, agentUserId, agentName,
}: BuyerOverviewClientProps) {
  const [activeTab, setActiveTab]   = useState<Tab>("Overview")
  const [gateModal, setGateModal]   = useState<GateModalProps | null>(null)
  const [verified, setVerified]     = useState(profile?.verified === true)
  const [refreshKey, setRefreshKey] = useState(0)

  const currentStage = contact.buyer_stage ?? "BUYER_CONTACT_CREATED"
  const persona      = contact.contact_persona ?? null
  const buyerName    = `${contact.first_name} ${contact.last_name}`

  const blockers: string[] = []
  if (!verified) {
    blockers.push("Financial verification required before scheduling")
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
          <div>
            <h1 className="text-xl font-semibold">{buyerName}</h1>
            <div className="flex items-center gap-3 mt-1 flex-wrap text-sm text-muted-foreground">
              {contact.email && <span>{contact.email}</span>}
              {contact.phone && <span>{contact.phone}</span>}
              {contact.status && <span className="capitalize">{contact.status}</span>}
              {contact.timeline && <span>{contact.timeline}</span>}
            </div>
          </div>
          <Link
            href={`/dashboard/buyers/${buyerId}/search`}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors flex-shrink-0"
          >
            Search Properties
          </Link>
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
          {isOfferAllowed(currentStage as any) ? (
            <Link
              href={`/dashboard/buyers/${buyerId}/offers`}
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
      ) : activeTab !== "Overview" ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-center space-y-2">
            <p className="text-sm font-medium text-muted-foreground">{activeTab}</p>
            <p className="text-xs text-muted-foreground">Coming soon</p>
          </div>
        </div>
      ) : (
        /* Overview — 3-column layout */
        <div className="flex flex-1 min-h-0 overflow-auto">
          {/* LEFT — stage progress (280px) */}
          <aside className="w-[280px] flex-shrink-0 border-r border-border overflow-y-auto">
            <BuyerStageProgress currentStage={currentStage} blockers={blockers} />
          </aside>

          {/* CENTER — main content */}
          <main className="flex-1 min-w-0 overflow-y-auto px-6 py-5 space-y-5">
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

            {/* 3. AI Buyer Insights */}
            <BuyerInsightsPanel contactId={buyerId} />

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

            {/* 6. Key Info Strip */}
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold">Key Information</h3>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Source</p>
                  <p className="font-medium">{contact.source ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Timeline</p>
                  <p className="font-medium">{contact.timeline ?? "—"}</p>
                </div>
                {profile && (
                  <>
                    <div>
                      <p className="text-xs text-muted-foreground">Finance type</p>
                      <p className="font-medium capitalize">{profile.is_cash_buyer ? "Cash" : profile.finance_type ?? "—"}</p>
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

          {/* RIGHT — conversation coaching (320px) */}
          <aside className="w-[320px] flex-shrink-0 border-l border-border overflow-y-auto px-4 py-5">
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
