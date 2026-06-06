import { getLifecyclePromoPolicyForScope } from "@/app/actions/lifecycle-promo-policy"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { LifecyclePromoSettingsTabs } from "./tabs"

export const dynamic = "force-dynamic"

interface PageProps {
  searchParams: Promise<{ tab?: string; team?: string }>
}

export default async function LifecyclePromosSettingsPage({ searchParams }: PageProps) {
  const access = await resolvePolicyScopeAccess()
  const sp = await searchParams
  const tab = (sp.tab === "team" || sp.tab === "brokerage") ? sp.tab : "agent"
  const teamId = sp.team ?? (access.teamScopeIds[0] ?? null)

  if (!access.canEditAgent && !access.canEditTeam && !access.canEditBrokerage) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Lifecycle Promo Settings</h1>
        <p className="text-red-600">You don't have permission to manage these settings.</p>
      </div>
    )
  }

  const scopeType = (tab === "team" && access.canEditTeam) ? "team"
    : (tab === "brokerage" && access.canEditBrokerage) ? "brokerage"
    : "agent"
  const scopeId = scopeType === "team" ? (teamId ?? undefined) : undefined
  const result = await getLifecyclePromoPolicyForScope({ scopeType, scopeId })

  return (
    <LifecyclePromoSettingsTabs
      access={access}
      activeTab={scopeType}
      activeTeamId={teamId}
      events={result.events ?? []}
      error={result.error ?? null}
    />
  )
}
