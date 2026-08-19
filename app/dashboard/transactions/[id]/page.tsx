import { createClient } from "@/lib/supabase/server"
import { redirect, notFound } from "next/navigation"
import { TransactionDetailClient } from "./transaction-detail-client"
import { ClosingWatchtowerSection } from "./closing-watchtower-section"
import { MilestoneDeadlinesButton } from "./milestone-deadlines-button"
import { ClosingWarRoomSection } from "./closing-war-room-section"
import { FinancingPitStopSection } from "./financing-pit-stop-section"
import { BuyerMoveSection } from "./buyer-move-section"
import { HazardInsuranceSection } from "./hazard-insurance-section"
import { getTransactionHazardInsuranceAction } from "@/app/actions/transaction-hazard-insurance"
import { AiCoordinatorPanel } from "./ai-coordinator-panel"
import { getBuyerMoveCase } from "@/lib/transactions/buyer-move"
import { FEATURES } from "@/lib/constants"
import { TRANSACTION_STAGES, TransactionStage } from "@/lib/transactions/transaction-stages"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { trackTitleIssues } from "@/app/actions/multi-persona"

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


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
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
      financing_deadline,
      buyer_contact_id,
      loan_amount,
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

  // Auth: owning agent OR broker/admin/TC in same brokerage.
  //
  // IDENTITY CLASS — this comparison was `transaction.agent_id === user.id`,
  // which pits two DIFFERENT id spaces against each other and is therefore
  // always false. transactions.agent_id FKs agents(id) (pg_constraint:
  // transactions_agent_id_fkey -> agents.id) and agents.id is never equal to
  // users.id in this database (checked live: every agents row has a distinct
  // user_id). The consequence was total: an ordinary user_type='agent' failed
  // BOTH branches and was redirected away from their own deal — only
  // broker/admin/tc could ever open a transaction. Resolved through the
  // identity helper rather than papered over with `??`.
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const identity = await getAgentContext()
  const isOwningAgent = !!identity.agentId && transaction.agent_id === identity.agentId
  const hasAdminAccess = ["broker", "admin", "tc"].includes(userType)
  if (!isOwningAgent && !hasAdminAccess) {
    redirect("/dashboard")
  }

  // Fetch contact + esign provider + linked offer in parallel with main data
  const [{ data: contactRow }, { data: providerCred }, { data: linkedOfferRow }] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, first_name, last_name, email")
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
    ? ([contactRow.first_name, contactRow.last_name].filter(Boolean).join(" ") || null)
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
    // Placeholder to keep the destructure arity — lender is resolved below.
    supabase.from("transactions").select("id").eq("id", id).maybeSingle(),
    // Candidate lenders = LENDER VENDORS in this brokerage (lenders are vendors).
    supabase
      .from("vendors")
      .select("id, name, category")
      .eq("brokerage_id", brokerageId)
      .ilike("category", "%lender%")
      .order("name"),
  ])
  const currentCoordinatorId = txnCoordinatorRow?.coordinator_id ?? null
  // The lender vendor currently assigned to this transaction (vendor_assignments).
  const { resolveLenderVendorForTransaction } = await import("@/lib/kernel/lender-linkage")
  const currentLenderVendor = await resolveLenderVendorForTransaction(supabase, id)
  const currentLenderUserId = currentLenderVendor?.vendorId ?? null
  const availableLenderUsers = (availableLenders ?? []).map((v: any) => ({
    userId: v.id as string,
    label: (v.name as string) || "Lender",
  }))

  // Signature state for THIS transaction's documents.
  //
  // WAS: a brokerage-wide `contract_signatures` read with NO transaction scope at
  // all, keyed by contract_type "most recent wins". `contract_signatures` carries
  // brokerage_id / agent_id / contract_type and NO transaction_id (verified live),
  // so that map held OTHER open deals' signature rows: the "Signatures Pending"
  // card listed doc types this transaction does not even have, and the per-document
  // e-sign panel bound `existingSignatureId` from a different deal — so "Resend"
  // could resend another transaction's envelope.
  //
  // Both reads now come from app/actions/transaction-document-signatures.ts, which
  // resolves the link the row is missing the only way it can be: `transaction_documents`
  // IS transaction-scoped, so this transaction's own signable doc_types are the
  // bridge and signatures are narrowed to those. RESIDUAL LIMIT, stated not hidden:
  // two open deals in one brokerage that need the SAME doc_type still share these
  // rows — closing that needs a transaction_id column on contract_signatures and a
  // backfill, i.e. a migration, deliberately not invented here.
  const { getTransactionSignatureStatuses, getUnsignedDocumentBlockers } =
    await import("@/app/actions/transaction-document-signatures")
  const [contractSigsRows, unsignedDocBlockers] = await Promise.all([
    getTransactionSignatureStatuses(id),
    getUnsignedDocumentBlockers(id),
  ])

  // Key by contract_type (doc_type) — most recent wins
  const contractSignatures = contractSigsRows.reduce((acc, s) => {
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

  // Financing Pit Stop inputs — the buyer's pre-approval expiry (the stale-pre-approval
  // signal) keyed on the deal's buyer contact (buyer_contact_id, else contact_id).
  const financingBuyerContactId = (transaction as any).buyer_contact_id ?? transaction.contact_id ?? null
  const { data: buyerFinProfile } = financingBuyerContactId
    ? await supabase
        .from("buyer_financial_profiles")
        .select("pre_approval_expires_at, is_cash_buyer")
        .eq("contact_id", financingBuyerContactId)
        .maybeSingle()
    : { data: null }

  // Buyer Move Services — the post-contract move-in concierge (Deal Coordinator). The case is
  // auto-created when a buyer-side deal enters CLOSING_PREP; a buyer-side deal already at/after
  // CLOSING_PREP with no case yet can bootstrap one from the panel.
  const buyerMoveCase = await getBuyerMoveCase(supabase as any, { transactionId: id, brokerageId })
  const moveEligibleStage = ["CLOSING_PREP", "CLOSED"].includes((transaction as any).stage)
  const isBuyerSideDeal = (transaction as any).deal_type !== "listing" && !!(transaction as any).buyer_contact_id
  const canBootstrapMove = !buyerMoveCase && moveEligibleStage && isBuyerSideDeal

  // Closing-Day War Room — open orchestration actions (transaction_pending_actions)
  // feed the drive-to-done list alongside the deal's tasks + unmet conditions.
  const { data: warRoomPendingActions } = await supabase
    .from("transaction_pending_actions")
    .select("id, headline, severity, due_date, suggested_recipient, status")
    .eq("transaction_id", id)
    .eq("status", "open")

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

  // HAZARD INSURANCE (m385) — the tracked policy + the marketplace recommendations,
  // resolved together by the action so the panel and the closing-orchestration cron
  // read the same evaluator. Fetched here rather than in the client component so the
  // service-role reads and the vendor resolver never reach the browser bundle.
  const hazardInsuranceView = await getTransactionHazardInsuranceAction(
    id,
    (transaction as any).brokerage_id ?? undefined,
  )

  // TITLE ISSUE TRIAGE — transaction_title_escrow.title_issues is a TEXT column
  // the platform writes as a JSON array of { text, status, severity }. The Title
  // & Escrow card rendered that raw blob inside one destructive badge, so a
  // resolved issue and an open critical one looked identical and the
  // closing-blocking verdict was never computed. trackTitleIssues is the parser
  // that answers it (critical / moderate / canClose) and had no caller.
  const titleIssueSummary = titleEscrow
    ? await trackTitleIssues(id).catch(() => null)
    : null

  // Build stage stepper data
  const stages = Object.values(TRANSACTION_STAGES).filter(s => s !== "LOST") as TransactionStage[]
  const currentStageIndex = stages.indexOf(transaction.stage as TransactionStage)

  return (
    <>
      {/* Title & Closing Watchtower — server-rendered date-chain status with
          severity badges (pure core shared with the hourly watchtower cron). */}
      <ClosingWatchtowerSection milestones={(milestones ?? []) as any} />
      {/* THE DATES, ON A CALENDAR. createDeadlineEventsFromMilestones turns each
          pending milestone with a target_date into a system-generated deadline
          event. Its docblock said "called when a transaction is created or
          updated" and it was called from nowhere — so the very dates the
          Watchtower above builds its critical path from never reached anyone's
          calendar. */}
      <div className="px-4 sm:px-6">
        <MilestoneDeadlinesButton transactionId={id} />
      </div>
      {/* Closing-Day War Room — the final-mile cockpit; renders only inside the
          closing window (closing_date within N days). Clear-to-close conditions,
          the REUSED critical-path timeline, wire/EMD, and the open-items list. */}
      <ClosingWarRoomSection
        milestones={(milestones ?? []) as any}
        lender={
          lenderInfo
            ? {
                clear_to_close_date: (lenderInfo as any).clear_to_close_date ?? null,
                underwriting_status: (lenderInfo as any).underwriting_status ?? null,
              }
            : null
        }
        titleEscrow={
          titleEscrow
            ? {
                earnest_money_received_date: (titleEscrow as any).earnest_money_received_date ?? null,
                closing_scheduled_date: (titleEscrow as any).closing_scheduled_date ?? null,
              }
            : null
        }
        signatures={contractSigsRows.map((s) => ({ esign_status: s.esign_status }))}
        tasks={(tasks ?? []) as any}
        pendingActions={(warRoomPendingActions ?? []) as any}
        closeDate={(transaction as any).close_date ?? null}
      />
      {/* Financing Pit Stop — the RATE/lender side beside the watchtower's DATE side
          (pure core shared with the 6h financing-pit-stop cron). */}
      <FinancingPitStopSection
        financingDeadline={(transaction as any).financing_deadline ?? null}
        preApprovalExpiresAt={(buyerFinProfile as any)?.pre_approval_expires_at ?? null}
        isCashBuyer={(buyerFinProfile as any)?.is_cash_buyer ?? null}
        lenderQuotes={
          lenderInfo
            ? [{
                id: (lenderInfo as any).id,
                lenderName: (lenderInfo as any).lender_name ?? null,
                rate: (lenderInfo as any).interest_rate != null ? Number((lenderInfo as any).interest_rate) : null,
                loanAmount:
                  (lenderInfo as any).loan_amount != null
                    ? Number((lenderInfo as any).loan_amount)
                    : ((transaction as any).loan_amount != null ? Number((transaction as any).loan_amount) : null),
                source: "on_file" as const,
              }]
            : []
        }
      />
      {/* Hazard / homeowner's insurance — the tracked policy (or its stated absence,
          with the lender's lead-time deadline) plus insurance vendors from the
          brokerage marketplace, each linked to its existing portal spot. */}
      <HazardInsuranceSection
        transactionId={id}
        brokerageId={(transaction as any).brokerage_id}
        view={hazardInsuranceView}
      />
      {/* Buyer Move Services — post-contract move-in concierge (utilities, address, movers) with
          guided-DIY vs Utility Connect handoff (handoff execution feature-flagged until creds exist). */}
      <BuyerMoveSection
        transactionId={id}
        brokerageId={brokerageId}
        initialCase={buyerMoveCase}
        canBootstrap={canBootstrapMove}
        utilityConnectEnabled={FEATURES.BUYER_MOVE_UTILITY_CONNECT}
      />
      {/* AI Transaction Coordinator — the surface for the four coordinator
          capabilities that had no caller anywhere: smart tasks, deadline
          prediction, participant communication drafting (recorded, then read
          back), and the post-closing touchpoint plan. Every control reports the
          server's applied count, not an optimistic success. */}
      <AiCoordinatorPanel
        transactionId={id}
        stage={(transaction as any).stage ?? null}
        closeDate={(transaction as any).close_date ?? null}
      />
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
      titleIssueSummary={titleIssueSummary}
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
      unsignedDocBlockers={unsignedDocBlockers}
      currentCoordinatorId={currentCoordinatorId}
      availableTCs={availableTCs ?? []}
      currentLenderUserId={currentLenderUserId}
      availableLenderUsers={availableLenderUsers}
      vendorBookings={(vendorBookings ?? []) as any}
      />
    </>
  )
}
