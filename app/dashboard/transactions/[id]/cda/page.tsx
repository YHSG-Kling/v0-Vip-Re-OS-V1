import { createClient } from "@/lib/supabase/server"
import { redirect, notFound } from "next/navigation"
import { TRANSACTION_STAGES } from "@/lib/transactions/transaction-stages"
import { isBrokerageFinanceAdminGrantRole } from "@/lib/auth/resolve-user-role"
import { CDAWorkflowClient } from "./cda-workflow-client"
import { AgentConcessionsCard } from "./agent-concessions-card"
import { resolveCdaMode } from "@/lib/transactions/cda-closing-policy"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function CDAPage({ params }: PageProps) {
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
  // Get user profile with brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const brokerageId = profile.brokerage_id
  const userType = profile.user_type ?? "agent"

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
      commission_percentage,
      deal_type,
      created_at,
      updated_at
    `)
    .eq("id", id)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (txnError || !transaction) notFound()

  // IDENTITY CLASS. transactions.agent_id is an AGENTS id; user.id is a USERS id.
  // The two id spaces never overlap, so this comparison was false for everyone —
  // the agent whose CDA this is got redirected to /dashboard and only
  // broker/admin/tc/compliance could open the page. RESOLVE, never substitute.
  const { data: txnAgent } = await supabase
    .from("agents")
    .select("id, user_id, commission_split")
    .eq("id", transaction.agent_id)
    .maybeSingle()

  // Auth: owning agent OR broker/admin/TC in same brokerage
  const isOwningAgent = !!txnAgent?.user_id && txnAgent.user_id === user.id
  // Lane 89D: the ladder spelled `broker, admin` for the books seats — the
  // broker OWNER (and broker_admin) could not open a CDA in their own
  // brokerage. The books roster is BROKERAGE_FINANCE_ADMIN_USER_TYPES (§4);
  // the coordinator and the compliance officer keep their explicit seats
  // (m467 lets compliance READ the books).
  const hasAdminAccess =
    isBrokerageFinanceAdminGrantRole(userType) || ["tc", "compliance_officer"].includes(userType)
  if (!isOwningAgent && !hasAdminAccess) {
    redirect("/dashboard")
  }

  // CDA page is ONLY accessible in CLOSING_PREP stage
  if (transaction.stage !== TRANSACTION_STAGES.CLOSING_PREP) {
    redirect(`/dashboard/transactions/${id}`)
  }

  // Fetch CDA data
  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("*")
    .eq("transaction_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Agent info — already resolved above by agents.id (this looked the agents table
  // up by user_id using an agents.id, so it matched nothing and every split / cap
  // figure on this page rendered blank).
  const agent = txnAgent

  // Does this brokerage offer CDAs at all? When it does not, the agent records how the
  // brokerage should disburse to them after funds clear instead (the non-CDA path).
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("offers_cda")
    .eq("id", brokerageId)
    .maybeSingle()

  // ── CAP PROGRESS COMES FROM THE LEDGER, AND THE UNITS ARE THE FIX ─────────
  //
  // This page used to select `agents.cap_amount, agents.cap_progress` and render
  // BOTH through formatCurrency. `cap_progress` was never dollars: its only
  // writer (updateAgentYTDStats) computed `min(ytd_gci / cap_amount * 100, 100)`
  // — a PERCENTAGE. So a Commission Disbursement Authorization, the document an
  // agent reads at closing to see what they are owed, has been printing
  // "$43.00 / $100,000.00" for an agent 43% of the way to their cap.
  //
  // Both of those columns are also the copy the commission engine never reads
  // and they are being dropped, so this is a repoint and a units fix in one:
  // `agent_cap_tracking` is the ledger `lib/commission/waterfall/07-apply-cap.ts`
  // actually applies, `cap_paid_to_date` and `cap_amount` on it are both real
  // dollars, and formatCurrency is finally telling the truth about them.
  //
  // The window filter is stage 07's own (`anniversary_start <= today <=
  // anniversary_end`) so this page and the engine cannot disagree about which
  // year is being reported. `.limit(1)` rather than `.maybeSingle()`:
  // agent_cap_tracking carries no uniqueness on the window, and a CDA must not
  // 500 because two overlapping rows exist.
  // WAVE 144 (lane 144D, owner ruling 9): stage 07 now prices a deal in the cycle containing the DEAL's date (its close
  // date), not today's — so this page reads that same window.
  const todayIso = ((transaction as { close_date?: string | null }).close_date ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10)
  const { data: capRows, error: capError } = await supabase
    .from("agent_cap_tracking")
    .select("cap_amount, cap_paid_to_date, is_capped")
    .eq("brokerage_id", brokerageId)
    .eq("agent_id", transaction.agent_id)
    .lte("anniversary_start", todayIso)
    .gte("anniversary_end", todayIso)
    .order("anniversary_start", { ascending: false })
    .limit(1)

  // A refused read is not "no cap". supabase-js RESOLVES a failed query, so
  // without this the CDA would silently claim an uncapped agent. `null` means
  // "we could not establish it" and the client says so rather than printing $0.
  const capLedgerRow = capError ? null : ((capRows ?? [])[0] as
    | { cap_amount: unknown; cap_paid_to_date: unknown; is_capped: unknown }
    | undefined) ?? null

  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const agentCap = capLedgerRow
    ? {
        capAmount: num(capLedgerRow.cap_amount),
        capPaidToDate: num(capLedgerRow.cap_paid_to_date),
        isCapped: capLedgerRow.is_capped === true,
      }
    : null

  // Fetch the engine's frozen calculation (breakdown + the agreement it priced with) AND the posted ledger row.
  //
  // WAVE 143 (lane 143C): the client reads gross_commission / net_to_agent / net_to_brokerage off `commissionCalc`,
  // but commission_calculations carries `total_commission` and never had those columns — so the fallback beside the
  // CDA's own figures was permanently blank, and nothing in the engine wrote the row at all. The figures now come from
  // the POSTED agent_commissions row (the ledger the CDA is checked against); the breakdown and the agreement applied
  // (version, date, signed record) come from the snapshot stage 11 freezes. Both reads are tenant-pinned and both
  // errors are read — a refused read is shown as unavailable, never as "no calculation".
  const [calcRes, ledgerRes] = await Promise.all([
    supabase
      .from("commission_calculations")
      .select("id, total_commission, breakdown_json, engine_inputs, calculated_at, calculation_version, agent_id")
      .eq("transaction_id", id)
      .eq("brokerage_id", brokerageId)
      .order("calculated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("agent_commissions")
      .select("id, gross_commission, net_to_agent, net_to_brokerage, created_at")
      .eq("transaction_id", id)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  if (calcRes.error) console.error("[cda-page] commission calculation read refused:", calcRes.error.message)
  if (ledgerRes.error) console.error("[cda-page] posted commission read refused:", ledgerRes.error.message)
  const calcRow = calcRes.error ? null : (calcRes.data as { id: string; total_commission: number | string | null; breakdown_json: Record<string, unknown> | null; engine_inputs: Record<string, unknown> | null; calculated_at: string } | null)
  const ledgerRow = ledgerRes.error ? null : (ledgerRes.data as { id: string; gross_commission: number | string | null; net_to_agent: number | string | null; net_to_brokerage: number | string | null; created_at: string } | null)
  const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v))
  const commissionCalc = calcRow || ledgerRow
    ? {
        id: (calcRow?.id ?? ledgerRow?.id) as string,
        gross_commission: numOrNull(ledgerRow?.gross_commission) ?? numOrNull(calcRow?.total_commission),
        net_to_agent: numOrNull(ledgerRow?.net_to_agent),
        net_to_brokerage: numOrNull(ledgerRow?.net_to_brokerage),
        breakdown_json: calcRow?.breakdown_json ?? null,
        engine_inputs: calcRow?.engine_inputs ?? null,
        calculated_at: (calcRow?.calculated_at ?? ledgerRow?.created_at) as string,
      }
    : null

  // Fetch compliance checks for this transaction
  const { data: complianceChecks } = await supabase
    .from("transaction_compliance_log")
    .select("*")
    .eq("transaction_id", id)
    .eq("brokerage_id", brokerageId)
    .order("is_blocking", { ascending: false })
    .order("created_at", { ascending: true })

  // Fetch timeline entries related to CDA and compliance
  const { data: cdaTimeline } = await supabase
    .from("transaction_timeline")
    .select("*")
    .eq("transaction_id", id)
    .or("activity_type.ilike.%cda%,activity_type.ilike.%compliance%")
    .order("created_at", { ascending: false })
    .limit(15)

  return (
    <>
    <CDAWorkflowClient
      transaction={transaction}
      brokerageId={brokerageId}
      userType={userType}
      userId={user.id}
      canCorrectEntries={isBrokerageFinanceAdminGrantRole(userType)}
      cda={cda}
      // ONE answer (wave 142, lane 142C): resolveCdaMode — an undeclared setting never manufactures a
      // mandatory CDA (this page used to default it to TRUE while finalizeCommissionAtClose said FALSE).
      offersCda={resolveCdaMode({ offersCda: (brokerage as { offers_cda?: boolean | null } | null)?.offers_cda }).cdaRequired}
      agent={agent}
      agentCap={agentCap}
      capUnavailable={!!capError}
      commissionCalc={commissionCalc}
      complianceChecks={complianceChecks ?? []}
      cdaTimeline={cdaTimeline ?? []}
    />
    {/* WAVE 144 (lane 144D, owner ruling 4): the agent concession request / broker decision for this deal. */}
    <div className="mx-auto max-w-5xl px-4 pb-8">
      <AgentConcessionsCard transactionId={id} />
    </div>
    </>
  )
}
