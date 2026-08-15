import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createClient } from "@/lib/supabase/server"
import { FeatureGovernanceClient } from "./feature-governance-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Feature Governance",
  description: "Manage feature flags, trial access grants, and usage analytics",
}

export default async function FeatureGovernancePage() {
  const context = await getAgentContext()

  if (!context?.brokerageId) redirect("/login")
  if (!["admin", "superadmin", "broker"].includes(context.userType ?? "")) {
    redirect("/dashboard")
  }

  const supabase = await createClient()
  const brokerageId = context.brokerageId

  // "Is superadmin" needs BOTH identity columns and AgentContext carries only
  // user_type, so platform_role is read here. `context.userType === "superadmin"`
  // was FALSE for the platform's only superadmin (user_type='admin',
  // platform_role='superadmin'), which made this page's entire write half dead
  // for the one account that owns it: every flag toggle and tier checkbox
  // rendered `disabled`, and the client showed the read-only "flags are managed
  // by the platform team" notice TO the platform team. Same shape as
  // public.is_platform_admin() in RLS; see app/actions/vendor-budget.ts:136-147.
  const { data: identity } = await supabase
    .from("users")
    .select("platform_role")
    .eq("id", context.userId)
    .maybeSingle()
  const isSuperadmin =
    context.userType === "superadmin" ||
    (identity as { platform_role?: string | null } | null)?.platform_role === "superadmin"

  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10)

  const [flags, overrides, usage] = await Promise.all([
    supabase
      .from("feature_flags")
      .select(
        "id, feature_key, display_name, description, category, enabled, beta, deprecated, superadmin_only, solo_agent_access, team_access, brokerage_access, multi_location_access, updated_at"
      )
      .order("category")
      .order("display_name"),

    // feature_access_overrides → users carries TWO FKs
    // (feature_access_overrides_user_id_fkey = the person the override GOVERNS,
    // feature_access_overrides_created_by_fkey = the admin who GRANTED it), so the
    // bare `users(email)` was ambiguous and PostgREST refused the whole read
    // (PGRST201). supabase-js resolves that, so `overrides.data` was null and the
    // Overrides tab rendered its empty state — this governance surface reported "no
    // overrides" while overrides were live.
    // A governance list wants BOTH parties, so each gets its own aliased hint: the
    // grantee is the row's subject, and the granter is the audit trail the client
    // deliberately started recording (see the created_by comment in the client).
    supabase
      .from("feature_access_overrides")
      .select(
        "id, user_id, brokerage_id, team_id, feature_key, override_type, trial_ends_at, notes, created_at, created_by, grantee:users!feature_access_overrides_user_id_fkey(id, email), granted_by:users!feature_access_overrides_created_by_fkey(id, email)"
      )
      .eq("brokerage_id", brokerageId),

    supabase
      .from("feature_usage_tracking")
      .select("feature_key, user_id")
      .eq("brokerage_id", brokerageId)
      .gte("period_start", startOfMonth),
  ])

  // Check the error on every read. supabase-js RESOLVES a failed query, so an
  // unchecked read renders a refusal as an empty governance surface — indistinguishable
  // from "nothing is configured", and precisely how the ambiguous embed above hid.
  for (const [label, res] of [
    ["feature_flags", flags],
    ["feature_access_overrides", overrides],
    ["feature_usage_tracking", usage],
  ] as const) {
    if (res.error) {
      console.error(`[FeatureGovernance] ${label} read failed:`, res.error)
    }
  }

  // Build usageMap: feature_key -> count of distinct users this month
  const usageMap = (usage.data ?? []).reduce<Record<string, number>>((acc, u) => {
    acc[u.feature_key] = (acc[u.feature_key] ?? 0) + 1
    return acc
  }, {})

  return (
    <FeatureGovernanceClient
      flags={flags.data ?? []}
      overrides={(overrides.data ?? []) as any}
      usageMap={usageMap}
      brokerageId={brokerageId}
      isSuperadmin={isSuperadmin}
    />
  )
}
