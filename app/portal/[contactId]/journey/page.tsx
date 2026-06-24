import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { determinePortalView, getPortalJourneyMilestones } from "@/lib/kernel/portal"
import type { PortalJourneyMilestone } from "@/lib/kernel/portal"
import {
  BUYER_MILESTONE_LABELS,
  SELLER_MILESTONE_LABELS,
  MILESTONE_RESPONSIBLE_PARTY,
  MILESTONE_EXPLANATIONS,
  MILESTONE_LESSON_MAP,
} from "@/lib/portal/resolve-education-context"
import JourneyClient from "./journey-client"

// The client journey timeline shape is owned by the kernel (it decides visibility
// by canonical milestone_type). The page consumes the kernel's PortalJourneyMilestone.
export type TransactionMilestone = PortalJourneyMilestone

export interface TransactionData {
  id: string
  property_address: string | null
  status: string
  list_price: number | null
  offer_price: number | null
  purchase_price: number | null
  close_date: string | null
  contract_date: string | null
  deal_type: string | null
}

export default async function PortalJourneyPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Get contact basic info
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, contact_type, buyer_stage")
    .eq("id", contactId)
    .single()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // Determine portal view from kernel
  const portalView = await determinePortalView(supabase, { contactId })

  // Get active transaction for this contact
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, property_address, status, list_price:purchase_price, offer_price:purchase_price, purchase_price, close_date, contract_date, deal_type")
    .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    .not("status", "in", "(cancelled)")
    .order("created_at", { ascending: false })
    .limit(1)

  const transaction: TransactionData | null = transactions?.[0] ?? null

  // The KERNEL decides which milestones the client sees (by canonical milestone_type,
  // with the agent's per-contact overrides applied) — the page does not read or filter
  // transaction_milestones itself. Single source of truth: lib/kernel/portal.ts.
  const milestones: TransactionMilestone[] = transaction
    ? await getPortalJourneyMilestones(supabase, {
        contactId,
        transactionId: transaction.id,
      })
    : []

  // Get label map based on portal view
  const labelMap = portalView.view === "seller" ? SELLER_MILESTONE_LABELS : BUYER_MILESTONE_LABELS

  // Get contact display name
  const contactName = contact.first_name || "there"

  return (
    <JourneyClient
      contactId={contactId}
      contactName={contactName}
      portalView={portalView.view}
      transaction={transaction}
      milestones={milestones}
      labelMap={labelMap}
      responsiblePartyMap={MILESTONE_RESPONSIBLE_PARTY}
      explanationMap={MILESTONE_EXPLANATIONS}
      lessonMap={MILESTONE_LESSON_MAP}
    />
  )
}
