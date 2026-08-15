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

  // Get user profile with brokerage. Canonical: users.user_type (kernel
  // identity layer never reads .role outside the kernel).
  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const brokerageId = profile.brokerage_id
  const userType = profile.user_type ?? "agent"

  const { data: brokerageInfo } = await supabase
    .from("brokerages")
    .select("name, logo_url")
    .eq("id", brokerageId)
    .maybeSingle()

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
  const hasAdminAccess = ["broker", "admin", "tc"].includes(userType)
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
    ? (contactRow.name ?? ([contactRow.first_name, contactRow.last_name].filter(Boolean).join(" ") || null))
    : null
  const connectedEsignProvider = providerCred
    ? { platform: providerCred.platform, accountName: providerCred.account_name ?? null }
    : null

  // Fetch transaction coordinator, available TCs, lender info, and available lenders
  const [
    { data: txnCoordinatorRow },
    { data: availableTCs },
    { data: txnLenderRow },
    { data: availableLenders },
  ] = await Promise.all([
    supabase
      .from("transactions")
      .select("coordinator_id")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("transaction_coordinators")
      .select("id, display_name, max_active_deals")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("display_name"),
    supabase
      .from("transactions")
      .select("lender_id")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("lender_portal_users")
      .select("id, lender_company")
      .order("lender_company"),
  ])
  const currentCoordinatorId = txnCoordinatorRow?.coordinator_id ?? null
  const currentLenderId = txnLenderRow?.lender_id ?? null

  // Fetch contract_signatures for this brokerage — used to show send/resend per transaction doc
  const { data: contractSigsRows } = await supabase
    .from("contract_signatures")
    .select("id, contract_type, esign_status, provider_name, sent_at, agent_signed_at, fully_signed_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  // Key by contract_type (doc_type) — most recent wins
  const contractSignatures = (contractSigsRows ?? []).reduce((acc, s) => {
    if (!acc[s.contract_type]) {
      acc[s.contract_type] = {
        id: s.id,
        esign_status: s.esign_status,
        provider_name: s.provider_name,
        sent_at: s.sent_at,
        agent_signed_at: s.agent_signed_at,
        fully_signed_at: s.fully_signed_at,
      }
    }
    return acc
  }, {} as Record<string, { id: string; esign_status: string; provider_name: string | null; sent_at: string | null; agent_signed_at: string | null; fully_signed_at: string | null }>)

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
      .order("target_date", { ascending: true, nullsFirst: false }),

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

    // proactive_interventions — load full rows so the detail page can
    // surface the actual recommendations inline (not just the count).
    supabase
      .from("proactive_interventions")
      .select("id, issue_detected, severity, ai_recommendation, client_impacted, created_at")
      .eq("transaction_id", id)
      .eq("resolved", false)
      .order("created_at", { ascending: false })
      .limit(10),

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

  // 7-point score history for the inline trend sparkline. Separate query so
  // the destructure above stays positional. Cheap (<= 7 rows).
  const { data: healthScoreHistory } = await supabase
    .from("deal_health_scores")
    .select("overall_score, risk_level, scored_at")
    .eq("transaction_id", id)
    .order("scored_at", { ascending: false })
    .limit(7)

  // vendor_bookings with joined vendor name — includes contact_id and listing_id
  const { data: vendorBookings } = await supabase
    .from("vendor_bookings")
    .select("id, service_type, status, scheduled_date, notes, contact_id, listing_id, vendors(name)")
    .eq("transaction_id", id)
    .not("status", "in", "(cancelled,no_show)")
    .order("scheduled_date", { ascending: true })

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
      brokerageName={brokerageInfo?.name ?? undefined}
      brokerageLogoUrl={brokerageInfo?.logo_url ?? undefined}
      userType={userType}
      userId={user.id}
      milestones={milestones ?? []}
      deadlines={deadlines ?? []}
      participants={participants ?? []}
      participantCountsByRole={participantCountsByRole}
      documents={documents ?? []}
      documentCountsByStatus={documentCountsByStatus}
      healthScore={healthScore}
      unresolvedInterventions={interventions ?? []}
      healthScoreHistory={healthScoreHistory ?? []}
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
      contractSignatures={contractSignatures}
      currentCoordinatorId={currentCoordinatorId}
      availableTCs={availableTCs ?? []}
      currentLenderId={currentLenderId}
      availableLenders={availableLenders ?? []}
      vendorBookings={(vendorBookings ?? []) as any}
    />
  )
}
