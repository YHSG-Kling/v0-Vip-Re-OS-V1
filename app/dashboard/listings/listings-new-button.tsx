"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"
import { FormWizard } from "@/app/components/form-wizard/FormWizard"

interface Props {
  brokerageId: string
  agentUserId: string
}

export function ListingsNewButton({ brokerageId, agentUserId }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [open, setOpen] = useState(false)
  // documentId comes from `?documentId=<uuid>` when the canonical voice
  // pipeline (voiceDraftListing) or AI Copilot stage_listing_packet tool has
  // staged a packet. URL convention matches what those helpers return.
  // Also accept `?action=new&documentId=<uuid>` from the dashboard "New Listing"
  // link. Legacy `?packet=` still recognized for backwards compat.
  const [documentId, setDocumentId] = useState<string | undefined>(undefined)

  useEffect(() => {
    const docId = searchParams?.get("documentId") ?? searchParams?.get("packet") ?? null
    const action = searchParams?.get("action") ?? null
    if (docId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(docId)) {
      setDocumentId(docId)
      setOpen(true)
    } else if (action === "new") {
      setOpen(true)
    }
  }, [searchParams])

  const handleClose = () => {
    setOpen(false)
    if (documentId) {
      // Clear the URL params so refreshing doesn't reopen the wizard.
      setDocumentId(undefined)
      router.replace("/dashboard/listings")
    }
  }

  return (
    <>
      <Button
        size="sm"
        className="gap-2 min-h-[44px] sm:min-h-0"
        onClick={() => {
          setDocumentId(undefined)
          setOpen(true)
        }}
      >
        <Plus className="h-4 w-4" />
        New Listing
      </Button>
      <FormWizard
        mode="listing"
        brokerageId={brokerageId}
        agentUserId={agentUserId}
        open={open}
        onClose={handleClose}
        documentId={documentId}
      />
    </>
  )
}
