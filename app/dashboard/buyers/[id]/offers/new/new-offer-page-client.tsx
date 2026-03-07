"use client"

import { useRouter }              from "next/navigation"
import { OfferInitiationFlow }    from "../components/offer-initiation-flow"

interface NewOfferPageClientProps {
  contactId:        string
  brokerageId:      string
  agentUserId:      string
  contactName:      string
  contactEmail:     string
  prefillListingId: string | null
}

export function NewOfferPageClient({
  contactId,
  brokerageId,
  agentUserId,
  contactName,
  contactEmail,
  prefillListingId,
}: NewOfferPageClientProps) {
  const router = useRouter()

  function handleSuccess() {
    router.push(`/dashboard/buyers/${contactId}/offers`)
  }

  function handleCancel() {
    router.back()
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
        />
      </div>
    </main>
  )
}
