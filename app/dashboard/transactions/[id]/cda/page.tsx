import { createClient } from "@/lib/supabase/server"
import { redirect, notFound } from "next/navigation"
import { TRANSACTION_STAGES } from "@/lib/transactions/transaction-stages"
import { CDAWorkflowClient } from "./cda-workflow-client"
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
  const hasAdminAccess = ["broker", "admin", "tc", "compliance_officer"].includes(userType)
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
  const todayIso = new Date().toISOString().slice(0, 10)
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

  // Fetch commission calculations if any
  const { data: commissionCalc } = await supabase
    .from("commission_calculations")
    .select("*")
    .eq("transaction_id", id)
    .order("calculated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

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
    <CDAWorkflowClient
      transaction={transaction}
      brokerageId={brokerageId}
      userType={userType}
      userId={user.id}
      cda={cda}
      offersCda={(brokerage as { offers_cda?: boolean | null } | null)?.offers_cda ?? true}
      agent={agent}
      agentCap={agentCap}
      capUnavailable={!!capError}
      commissionCalc={commissionCalc}
      complianceChecks={complianceChecks ?? []}
      cdaTimeline={cdaTimeline ?? []}
    />
  )
}
