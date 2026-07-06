import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listPlanTiersAction } from "@/app/actions/superadmin/plan-catalog"
import { PlanCatalogManager } from "./plan-catalog-manager"

export const dynamic = "force-dynamic"

// Superadmin plan-catalog management — create / update / remove tiers, sync price
// from Stripe. The single source of truth for all tier pricing + copy.
export default async function SuperadminPlansPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const isSuper = (data as any)?.user_type === "superadmin" || (data as any)?.platform_role === "superadmin"
  if (!isSuper) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const res = await listPlanTiersAction()
  const tiers = res.ok ? res.tiers : []

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Plans &amp; pricing</h1>
        <p className="text-muted-foreground text-sm mt-1">
          The single source of truth for every tier — price, setup fee, blurb, bullets, highlight, limits.
          Signup and billing read these; nothing is hardcoded. Sync a price from Stripe or edit inline.
        </p>
      </div>
      {!res.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load tiers: {res.error}</div>}
      <PlanCatalogManager initialTiers={tiers} />
    </div>
  )
}
