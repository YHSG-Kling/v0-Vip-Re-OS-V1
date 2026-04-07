import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { determinePortalView } from "@/lib/kernel/portal"
import { CLIENT_VISIBLE_MILESTONES } from "@/lib/transactions/transaction-stages"
import {
  MILESTONE_LABEL_MAP,
  BUYER_MILESTONE_LABELS,
  SELLER_MILESTONE_LABELS,
  MILESTONE_RESPONSIBLE_PARTY,
  MILESTONE_EXPLANATIONS,
  MILESTONE_LESSON_MAP,
} from "@/lib/portal/resolve-education-context"
import JourneyClient from "./journey-client"

export interface TransactionMilestone {
  id: string
  transaction_id: string
  milestone_name: string
  milestone_type?: string
  milestone_date: string | null
  completed_date: string | null
  status: string
  assigned_to: string | null
  notes: string | null
  is_client_visible?: boolean
}

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
    .select("id, first_name, last_name, name, contact_type, buyer_stage")
    .eq("id", contactId)
    .single()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // Determine portal view from kernel
  const portalView = await determinePortalView(supabase, contactId)

  // Get active transaction for this contact
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, property_address, status, list_price, offer_price, purchase_price, close_date, contract_date, deal_type")
    .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    .not("status", "in", "(cancelled)")
    .order("created_at", { ascending: false })
    .limit(1)

  const transaction: TransactionData | null = transactions?.[0] ?? null

  // Fetch milestones from transaction_milestones (canonical source)
  let milestones: TransactionMilestone[] = []
  
  if (transaction) {
    const { data: milestonesData } = await supabase
      .from("transaction_milestones")
      .select("id, transaction_id, milestone_name, milestone_type, milestone_date, completed_date, status, assigned_to, notes, is_client_visible")
      .eq("transaction_id", transaction.id)
      .eq("is_client_visible", true)
      .order("milestone_date", { ascending: true, nullsFirst: false })

    milestones = milestonesData ?? []
  }

  // Get label map based on portal view
  const labelMap = portalView === "seller" ? SELLER_MILESTONE_LABELS : BUYER_MILESTONE_LABELS

  // Get contact display name
  const contactName = contact.first_name || contact.name || "there"

  return (
    <JourneyClient
      contactId={contactId}
      contactName={contactName}
      portalView={portalView}
      transaction={transaction}
      milestones={milestones}
      labelMap={labelMap}
      responsiblePartyMap={MILESTONE_RESPONSIBLE_PARTY}
      explanationMap={MILESTONE_EXPLANATIONS}
      lessonMap={MILESTONE_LESSON_MAP}
    />
  )
}
