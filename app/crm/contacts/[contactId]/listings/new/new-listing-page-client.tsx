"use client"

import { useRouter } from "next/navigation"
import { useState }  from "react"
import { FormWizard } from "@/app/components/form-wizard/FormWizard"
import type { Contact } from "@/lib/domain/types"

interface NewListingPageClientProps {
  contactId:   string
  brokerageId: string
  agentUserId: string
  agentName:   string
  agentEmail:  string
  sellerName:  string
  contactFull: Contact
  /** When set, FormWizard mounts with this AI-staged listing-agreement
   *  document preloaded (voice → intake → forms → email → review here). */
  documentId:  string | null
}

export function NewListingPageClient({
  contactId,
  brokerageId,
  agentUserId,
  agentName,
  agentEmail,
  sellerName,
  contactFull,
  documentId,
}: NewListingPageClientProps) {
  const router = useRouter()
  const [wizardOpen, setWizardOpen] = useState<boolean>(true)

  function handleClose() {
    setWizardOpen(false)
    router.push(`/crm/contacts/${contactId}`)
  }

  return (
    <main className="flex flex-col min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-background border-b border-border px-6 py-4 flex items-center gap-4">
        <button
          onClick={() => router.back()}
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
          <p className="text-sm font-semibold">
            {documentId ? "Review AI-staged listing agreement" : "New listing"}
          </p>
          <p className="text-xs text-muted-foreground">{sellerName}</p>
        </div>
      </header>

      <div className="flex-1 w-full max-w-5xl mx-auto px-4 py-6">
        <FormWizard
          mode="listing"
          contact={contactFull}
          brokerageId={brokerageId}
          agentUserId={agentUserId}
          agentName={agentName}
          agentEmail={agentEmail}
          open={wizardOpen}
          onClose={handleClose}
          documentId={documentId ?? undefined}
        />
      </div>
    </main>
  )
}
