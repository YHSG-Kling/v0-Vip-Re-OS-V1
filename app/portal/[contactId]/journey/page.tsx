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
  target_date: string | null
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

  // Fetch milestones + portal preferences in parallel
  let milestones: TransactionMilestone[] = []

  const [milestonesResult, portalPrefsResult] = await Promise.all([
    transaction
      ? supabase
          .from("transaction_milestones")
          .select("id, transaction_id, milestone_name, milestone_type, target_date, completed_date, status, assigned_to, notes, is_client_visible")
          .eq("transaction_id", transaction.id)
          .eq("is_client_visible", true)
          .order("target_date", { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: null }),
    supabase
      .from("contact_portal_preferences")
      .select("milestone_overrides")
      .eq("contact_id", contactId)
      .maybeSingle(),
  ])

  if (milestonesResult.data) {
    // Apply agent-configured milestone visibility overrides.
    // milestone_overrides = { "milestone_name": false } hides a milestone.
    const overrides: Record<string, boolean> =
      (portalPrefsResult.data?.milestone_overrides as Record<string, boolean>) ?? {}

    milestones = (milestonesResult.data as TransactionMilestone[]).filter(
      (m) => overrides[m.milestone_name] !== false
    )
  }

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
