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
    .select("id, user_id, commission_split, cap_amount, cap_progress")
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
      agent={agent}
      commissionCalc={commissionCalc}
      complianceChecks={complianceChecks ?? []}
      cdaTimeline={cdaTimeline ?? []}
    />
  )
}
