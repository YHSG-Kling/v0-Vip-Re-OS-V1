import { createClient } from "@/lib/supabase/server"
import { redirect, notFound } from "next/navigation"
import { TransactionDetailClient } from "./transaction-detail-client"
import { TRANSACTION_STAGES, TransactionStage } from "@/lib/transactions/transaction-stages"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function TransactionDetailPage({ params }: PageProps) {
  const { id } = await params
  const supabase = await createClient()

  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Get user profile with brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("id, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/onboarding")

  const brokerageId = profile.brokerage_id
  const userRole = profile.role ?? "agent"

  // Fetch transaction with ownership/brokerage check
  // Uses actual Supabase transactions table columns
  const { data: transaction, error: txnError } = await supabase
    .from("transactions")
    .select(`
      id,
      brokerage_id,
      agent_id,
      contact_id,
      property_address,
      property_city,
      property_state,
      property_zip,
      purchase_price,
      status,
      stage,
      contract_date,
      close_date,
      compliance_passed_at,
      deal_type,
      deal_name,
      client_name,
      listing_id,
      health_score,
      commission_percentage,
      estimated_commission,
      created_at,
      updated_at
    `)
    .eq("id", id)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (txnError || !transaction) notFound()

  // Auth: owning agent OR broker/admin/TC in same brokerage
  const isOwningAgent = transaction.agent_id === user.id
  const hasAdminAccess = ["broker", "admin", "tc"].includes(userRole)
  if (!isOwningAgent && !hasAdminAccess) {
    redirect("/dashboard")
  }

  // Fetch contact + esign provider + linked offer in parallel with main data
  const [{ data: contactRow }, { data: providerCred }, { data: linkedOfferRow }] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, first_name, last_name, name, email")
      .eq("id", transaction.contact_id)
      .maybeSingle(),
    supabase
      .from("platform_credentials")
      .select("platform, account_name")
      .eq("brokerage_id", brokerageId)
      .in("platform", ["dotloop", "docusign", "skyslope", "authentisign"])
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("offers")
      .select("id, esign_status, esign_provider, esign_sent_at, esign_completed_at, buyer_signed_at")
      .eq("contact_id", transaction.contact_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const contactEmail = contactRow?.email ?? null
  const contactName = contactRow
    ? (contactRow.name ?? [contactRow.first_name, contactRow.last_name].filter(Boolean).join(" ") || null)
    : null
  const connectedEsignProvider = providerCred
    ? { platform: providerCred.platform, accountName: providerCred.account_name ?? null }
    : null

  // Fetch all related data in parallel — using actual Supabase tables
  const [
    { data: milestones },
    { data: deadlines },
    { data: participants },
    { data: documents },
    { data: healthScore },
    { data: interventions },
    { data: tasks },
    { data: timeline },
    { data: titleEscrow },
    { data: inspections },
    { data: pendingQuoteApprovals },
    { data: vendorServices },
    { data: repairs },
    { data: lenderInfo },
    { data: complianceLogs },
    { data: commissions },
  ] = await Promise.all([
    // transaction_milestones
    supabase
      .from("transaction_milestones")
      .select("*")
      .eq("transaction_id", id)
      .order("milestone_date", { ascending: true, nullsFirst: false }),

    // transaction_deadlines
    supabase
      .from("transaction_deadlines")
      .select("*")
      .eq("transaction_id", id)
      .eq("status", "pending")
      .order("deadline_date", { ascending: true })
      .limit(3),

    // transaction_participants
    supabase
      .from("transaction_participants")
      .select("*")
      .eq("transaction_id", id),

    // transaction_documents
    supabase
      .from("transaction_documents")
      .select("*")
      .eq("transaction_id", id),

    // deal_health_scores
    supabase
      .from("deal_health_scores")
      .select("*")
      .eq("transaction_id", id)
      .order("scored_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // proactive_interventions
    supabase
      .from("proactive_interventions")
      .select("id")
      .eq("transaction_id", id)
      .eq("resolved", false),

    // transaction_tasks
    supabase
      .from("transaction_tasks")
      .select("*")
      .eq("transaction_id", id)
      .in("status", ["pending", "in_progress"])
      .order("due_date", { ascending: true })
      .limit(10),

    // transaction_timeline
    supabase
      .from("transaction_timeline")
      .select("*")
      .eq("transaction_id", id)
      .order("created_at", { ascending: false })
      .limit(15),

    // transaction_title_escrow
    supabase
      .from("transaction_title_escrow")
      .select("*")
      .eq("transaction_id", id)
      .maybeSingle(),

    // transaction_inspections
    supabase
      .from("transaction_inspections")
      .select("*")
      .eq("transaction_id", id)
      .order("created_at", { ascending: false }),

    // activities (pending quote approvals)
    supabase
      .from("activities")
      .select("*")
      .eq("transaction_id", id)
      .eq("activity_type", "client_quote_approval_needed")
      .eq("status", "pending"),

    // transaction_vendor_services
    supabase
      .from("transaction_vendor_services")
      .select("*")
      .eq("transaction_id", id),

    // transaction_repair_negotiations (actual Supabase table)
    supabase
      .from("transaction_repair_negotiations")
      .select("*")
      .eq("transaction_id", id),

    // transaction_lenders (actual Supabase table)
    supabase
      .from("transaction_lenders")
      .select("*")
      .eq("transaction_id", id)
      .maybeSingle(),

    // transaction_compliance_log (actual Supabase table)
    supabase
      .from("transaction_compliance_log")
      .select("*")
      .eq("transaction_id", id)
      .order("created_at", { ascending: false }),

    // transaction_commissions (actual Supabase table)
    supabase
      .from("transaction_commissions")
      .select("*")
      .eq("transaction_id", id),
  ])

  // Compute participant counts by role
  const participantCountsByRole = (participants ?? []).reduce((acc, p) => {
    acc[p.role] = (acc[p.role] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  // Compute document counts by status
  const documentCountsByStatus = (documents ?? []).reduce((acc, d) => {
    acc[d.status] = (acc[d.status] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  // Get insurance quotes from vendor services
  const insuranceQuotes = (vendorServices ?? []).filter(v => v.service_type === "insurance_quote")

  // Build stage stepper data
  const stages = Object.values(TRANSACTION_STAGES).filter(s => s !== "LOST") as TransactionStage[]
  const currentStageIndex = stages.indexOf(transaction.stage as TransactionStage)

  return (
    <TransactionDetailClient
      transaction={transaction}
      brokerageId={brokerageId}
      userRole={userRole}
      userId={user.id}
      milestones={milestones ?? []}
      deadlines={deadlines ?? []}
      participants={participants ?? []}
      participantCountsByRole={participantCountsByRole}
      documents={documents ?? []}
      documentCountsByStatus={documentCountsByStatus}
      healthScore={healthScore}
      unresolvedInterventionsCount={(interventions ?? []).length}
      tasks={tasks ?? []}
      timeline={timeline ?? []}
      titleEscrow={titleEscrow}
      inspections={inspections ?? []}
      pendingQuoteApprovals={pendingQuoteApprovals ?? []}
      vendorServices={vendorServices ?? []}
      insuranceQuotes={insuranceQuotes}
      repairs={repairs ?? []}
      lenderInfo={lenderInfo}
      complianceLogs={complianceLogs ?? []}
      commissions={commissions ?? []}
      stages={stages}
      currentStageIndex={currentStageIndex}
      contactEmail={contactEmail}
      contactName={contactName}
      connectedEsignProvider={connectedEsignProvider}
      linkedOffer={linkedOfferRow ?? null}
    />
  )
}
