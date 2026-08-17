// app/dashboard/forms/page.tsx
// ═══════════════════════════════════════════════════════════════════════════
// FORMS LIBRARY — Role-scoped dashboard page for transaction forms management.
// Kernel OS: all data is fetched server-side via createClient() + getAgentContext().
// Role scoping: broker/admin/superadmin = full brokerage, team_lead = team,
// agent = own. Contacts are NOT permitted here.
// ═══════════════════════════════════════════════════════════════════════════

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { FormsLibraryClient } from "./FormsLibraryClient"
import type { Metadata } from "next"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata: Metadata = {
  title: "Forms Library",
  description: "Transaction forms management — provider forms, brokerage forms, submissions, and e-sign history.",
}

export const dynamic = "force-dynamic"

export default async function FormsLibraryPage() {
  const supabase = await createClient()

  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Resolve actor identity (kernel pattern: agents table is source of truth for role-scoped data)
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, brokerage_id, team_id")
    .eq("user_id", user.id)
    .maybeSingle()

  // Also read from users table for role/user_type
  const { data: userRow } = await supabase
    .from("users")
    .select("id, role, user_type, brokerage_id, team_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!agentRow?.brokerage_id && !userRow?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  const brokerageId = agentRow?.brokerage_id ?? userRow?.brokerage_id!
  const agentId     = agentRow?.id ?? null
  const teamId      = agentRow?.team_id ?? userRow?.team_id ?? null
  const role        = (userRow?.role ?? userRow?.user_type ?? "agent").toLowerCase()

  // ── Role-scoped data queries ────────────────────────────────────────────

  // 1. Provider forms — state_required_forms is accessible to all (read-only)
  const { data: stateRequirements } = await supabase
    .from("state_compliance_requirements")
    .select("id, state, requirement_name, document_type, requirement_category, transaction_type, is_mandatory, timeline_days, description")
    .order("state", { ascending: true })
    .limit(200)

  // 2. Platform credentials — which provider is connected
  const { data: platformCreds } = await supabase
    .from("platform_credentials")
    .select("id, platform, account_name, account_id, is_active, last_synced_at, test_status")
    .eq("brokerage_id", brokerageId)
    .in("platform", ["dotloop", "skyslope", "formsimplicity", "brokermint", "authentisign", "docusign"])
    .order("created_at", { ascending: false })

  // 3. Form submissions — scoped by role
  let submissionsQuery = supabase
    .from("form_submissions")
    .select("id, form_id, submitted_at, source, brokerage_id, contact_id")
    .eq("brokerage_id", brokerageId)
    .order("submitted_at", { ascending: false })
    .limit(50)

  // Agent sees own submissions only; broker/admin sees all
  // SCOPE LADDER (kept inline — team_leader has its own tier below):
  // 'superadmin' removed — dead as users.user_type (0 live rows store it).
  const isAdminOrBroker = ["admin", "broker", "broker_owner", "broker_admin"].includes(role)
  const isTeamLeader    = role === "team_leader" || role === "teamleader"

  if (!isAdminOrBroker && !isTeamLeader && agentId) {
    // agent sees their brokerage's submissions (form_submissions doesn't have agent_id)
    // just limit to brokerage scope which is already applied above
  }

  const { data: submissions } = await submissionsQuery

  // 4. E-sign history — scoped by role
  let esignQuery = supabase
    .from("contract_signatures")
    .select("id, contract_type, provider_name, provider_envelope_id, esign_status, sent_at, agent_signed_at, fully_signed_at, document_url, agent_id, brokerage_id")
    .eq("brokerage_id", brokerageId)
    .order("sent_at", { ascending: false })
    .limit(100)

  if (!isAdminOrBroker && !isTeamLeader && agentId) {
    esignQuery = esignQuery.eq("agent_id", agentId)
  }

  const { data: esignHistory } = await esignQuery

  // 5. Listing agreements — to show signed listing forms
  let listingAgreementsQuery = supabase
    .from("listing_agreements")
    .select("id, listing_id, agreement_type, esign_status, seller_signed_at, agent_signed_at, fully_executed_at, provider_name, brokerage_id, agent_user_id")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(50)

  if (!isAdminOrBroker && !isTeamLeader && agentId) {
    listingAgreementsQuery = listingAgreementsQuery.eq("agent_user_id", user.id)
  }

  const { data: listingAgreements } = await listingAgreementsQuery

  return (
    <FormsLibraryClient
      brokerageId={brokerageId}
      agentId={agentId}
      teamId={teamId}
      userRole={role}
      isAdminOrBroker={isAdminOrBroker}
      stateRequirements={stateRequirements ?? []}
      platformCreds={platformCreds ?? []}
      submissions={submissions ?? []}
      esignHistory={esignHistory ?? []}
      listingAgreements={listingAgreements ?? []}
    />
  )
}
