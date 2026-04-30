"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"
import { FormWizard } from "@/app/components/form-wizard/FormWizard"

interface Props {
  brokerageId: string
  agentUserId: string
}

export function ListingsNewButton({ brokerageId, agentUserId }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" className="gap-2 min-h-[44px] sm:min-h-0" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        New Listing
      </Button>
      <FormWizard
        mode="listing"
        brokerageId={brokerageId}
        agentUserId={agentUserId}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
