"use client"

import { useRouter }              from "next/navigation"
import { useState }                from "react"
import { OfferInitiationFlow }    from "../components/offer-initiation-flow"
import { FormWizard }              from "@/app/components/form-wizard/FormWizard"
import type { Contact }            from "@/lib/domain/types"

interface NewOfferPageClientProps {
  contactId:        string
  brokerageId:      string
  agentUserId:      string
  /** Resolved server-side via lib/kernel/resolve-user-team.ts (THE ONE answer
   *  for "which team is this agent on") — scopes FormWizard's e-sign
   *  template/provider resolution to the agent's team. */
  teamId:           string | null
  contactName:      string
  contactEmail:     string
  /** Full contacts row required by FormWizard. */
  contactFull:      Contact
  prefillListingId: string | null
  prefillAddress:   string | null
  prefillPhone:     string | null
  /** When set, mount FormWizard with the AI-staged packet preloaded
   *  (voice → intake → forms → email → review here). */
  documentId:       string | null
  /** offer_intents.id when this wizard was opened from the agent's Buyer
   *  offer requests queue ("Start Offer") — threaded to OfferInitiationFlow so
   *  createOffer can bridge the intent once the real offer is created. */
  prefillOfferIntentId?: string | null
}

export function NewOfferPageClient({
  contactId,
  brokerageId,
  agentUserId,
  teamId,
  contactName,
  contactEmail,
  contactFull,
  prefillListingId,
  prefillAddress,
  prefillPhone,
  documentId,
  prefillOfferIntentId = null,
}: NewOfferPageClientProps) {
  const router = useRouter()
  const [wizardOpen, setWizardOpen] = useState<boolean>(Boolean(documentId))

  function handleSuccess() {
    router.push(`/crm/contacts/${contactId}/offers`)
  }

  function handleCancel() {
    router.back()
  }

  // Voice-staged path: mount FormWizard directly with the documentId so the
  // agent lands on the filled forms. FormWizard pulls the packet from the
  // documents table (Commit U) and renders the prefilled fields with the
  // proactive-findings banner.
  if (documentId) {
    return (
      <main className="flex flex-col min-h-screen bg-background">
        <header className="sticky top-0 z-10 bg-background border-b border-border px-6 py-4 flex items-center gap-4">
          <button
            onClick={handleCancel}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Back"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          <div className="h-4 w-px bg-border" />
          <div>
            <p className="text-sm font-semibold">Review AI-staged offer</p>
            <p className="text-xs text-muted-foreground">{contactName}</p>
          </div>
        </header>
        <div className="flex-1 w-full max-w-5xl mx-auto px-4 py-6">
          <FormWizard
            mode="offer"
            contact={contactFull}
            brokerageId={brokerageId}
            agentUserId={agentUserId}
            teamId={teamId}
            agentName=""
            agentEmail=""
            open={wizardOpen}
            onClose={() => { setWizardOpen(false); router.back() }}
            documentId={documentId}
          />
        </div>
      </main>
    )
  }

  return (
    <main className="flex flex-col min-h-screen bg-background">
      {/* Page header */}
      <header className="sticky top-0 z-10 bg-background border-b border-border px-6 py-4 flex items-center gap-4">
        <button
          onClick={handleCancel}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Back to offers"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="h-4 w-px bg-border" />
        <div>
          <p className="text-sm font-semibold">New Offer</p>
          <p className="text-xs text-muted-foreground">{contactName}</p>
        </div>
      </header>

      {/* Full-page initiation flow */}
      <div className="flex-1 w-full max-w-3xl mx-auto px-4 py-6">
        <OfferInitiationFlow
          contactId={contactId}
          brokerageId={brokerageId}
          agentUserId={agentUserId}
          contactName={contactName}
          contactEmail={contactEmail}
          onSuccess={handleSuccess}
          onCancel={handleCancel}
          initialAddress={prefillAddress ?? undefined}
          initialBuyerPhone={prefillPhone ?? undefined}
          initialBuyerEmail={contactEmail || undefined}
          initialOfferIntentId={prefillOfferIntentId ?? undefined}
        />
      </div>
    </main>
  )
}
