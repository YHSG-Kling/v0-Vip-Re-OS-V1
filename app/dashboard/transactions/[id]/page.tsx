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
    .from("profiles")
    .select("id, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/onboarding")

  const brokerageId = profile.brokerage_id
  const userRole = profile.role ?? "agent"

  // Fetch transaction with ownership/brokerage check
  const { data: transaction, error: txnError } = await supabase
    .from("transactions")
    .select(`
      id,
      brokerage_id,
      agent_id,
      contact_id,
      property_address,
      purchase_price,
      status,
      stage,
      contract_date,
      close_date,
      compliance_passed_at,
      deal_type,
      offer_id,
      listing_id,
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

  // Fetch all related data in parallel
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
    { data: complianceAlerts },
    { data: commissionSplits },
  ] = await Promise.all([
    // All milestones ordered by date
    supabase
      .from("transaction_milestones")
      .select("*")
      .eq("transaction_id", id)
      .order("milestone_date", { ascending: true, nullsFirst: false }),

    // Next 3 pending deadlines
    supabase
      .from("transaction_deadlines")
      .select("*")
      .eq("transaction_id", id)
      .eq("status", "pending")
      .order("deadline_date", { ascending: true })
      .limit(3),

    // All participants
    supabase
      .from("transaction_participants")
      .select("*")
      .eq("transaction_id", id),

    // All documents
    supabase
      .from("transaction_documents")
      .select("*")
      .eq("transaction_id", id),

    // Latest deal health score
    supabase
      .from("deal_health_scores")
      .select("*")
      .eq("transaction_id", id)
      .order("calculated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Unresolved proactive interventions
    supabase
      .from("proactive_interventions")
      .select("id")
      .eq("transaction_id", id)
      .eq("resolved", false),

    // Active tasks
    supabase
      .from("transaction_tasks")
      .select("*")
      .eq("transaction_id", id)
      .in("status", ["pending", "in_progress"])
      .order("due_date", { ascending: true })
      .limit(10),

    // Recent timeline events
    supabase
      .from("transaction_timeline")
      .select("*")
      .eq("transaction_id", id)
      .order("occurred_at", { ascending: false })
      .limit(15),

    // Title & escrow info
    supabase
      .from("transaction_title_escrow")
      .select("*")
      .eq("transaction_id", id)
      .maybeSingle(),

    // Inspections
    supabase
      .from("transaction_inspections")
      .select("*")
      .eq("transaction_id", id)
      .order("created_at", { ascending: false }),

    // Pending quote approvals (activities)
    supabase
      .from("activities")
      .select("*")
      .eq("transaction_id", id)
      .eq("activity_type", "client_quote_approval_needed")
      .eq("status", "pending"),

    // Vendor services (insurance quotes, etc.)
    supabase
      .from("transaction_vendor_services")
      .select("*")
      .eq("transaction_id", id),

    // Repairs
    supabase
      .from("transaction_repairs")
      .select("*")
      .eq("transaction_id", id),

    // Lender info
    supabase
      .from("transaction_lender_info")
      .select("*")
      .eq("transaction_id", id)
      .maybeSingle(),

    // Compliance alerts
    supabase
      .from("compliance_alerts")
      .select("*")
      .eq("transaction_id", id)
      .order("created_at", { ascending: false }),

    // Commission splits
    supabase
      .from("commission_splits")
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
      complianceAlerts={complianceAlerts ?? []}
      commissionSplits={commissionSplits ?? []}
      stages={stages}
      currentStageIndex={currentStageIndex}
    />
  )
}
