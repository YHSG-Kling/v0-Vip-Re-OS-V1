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
  // documentId comes from `?packet=<uuid>` when the AI Copilot, voice agent,
  // or ⌘K verb has staged a packet via stageWizardPacket(). When present we
  // auto-open the wizard with the packet preloaded.
  const [documentId, setDocumentId] = useState<string | undefined>(undefined)

  useEffect(() => {
    const packet = searchParams?.get("packet") ?? null
    if (packet && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(packet)) {
      setDocumentId(packet)
      setOpen(true)
    }
  }, [searchParams])

  const handleClose = () => {
    setOpen(false)
    if (documentId) {
      // Clear the packet query param so refreshing doesn't reopen the wizard.
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
