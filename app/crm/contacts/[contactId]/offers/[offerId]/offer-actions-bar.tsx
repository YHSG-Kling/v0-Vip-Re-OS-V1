"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { OfferAgentActions, type OfferAgentActionsState } from "@/app/components/offer/offer-agent-actions"

/**
 * Thin client wrapper around <OfferAgentActions> that:
 *   - holds the current state (so we can optimistically update after the
 *     action returns success)
 *   - calls router.refresh() so the OfferWorkspace below re-renders with the
 *     latest server-side data
 *   - toasts every result so the agent gets immediate feedback
 */
export function OfferActionsBar(props: {
  offerId:      string
  agentUserId:  string
  initialState: OfferAgentActionsState
}) {
  const router = useRouter()
  const [state, setState] = useState<OfferAgentActionsState>(props.initialState)

  return (
    <OfferAgentActions
      offerId={props.offerId}
      agentUserId={props.agentUserId}
      state={state}
      onResult={(r) => {
        if (r.ok) toast.success(r.message)
        else      toast.error(r.message)
        // Pre-roll optimistic state so the buttons unlock immediately. The
        // router.refresh() below pulls the canonical state on the next render.
        if (r.ok) {
          if (r.kind === "accepted") {
            setState(s => ({ ...s, seller_response_type: "accepted", fully_signed_contract_on_file: true }))
          } else if (r.kind === "submit") {
            setState(s => ({ ...s, compliance_passed: true, transaction_id: extractTxId(r.message) ?? "pending" }))
          } else if (r.kind === "counter") {
            setState(s => ({ ...s, seller_response_type: "countered" }))
          } else if (r.kind === "commission") {
            setState(s => ({ ...s, commission_acknowledged: true }))
          }
        }
        // Always pull canonical data so workspace below re-renders
        router.refresh()
      }}
    />
  )
}

function extractTxId(msg: string): string | null {
  const m = msg.match(/Transaction created:\s*([0-9a-f-]{36})/i)
  return m ? m[1] : null
}
