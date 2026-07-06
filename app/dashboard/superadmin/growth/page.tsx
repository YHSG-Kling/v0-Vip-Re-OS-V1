import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listPlatformProspectsAction } from "@/app/actions/superadmin/platform-growth"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"
import { PlatformGrowthBoard } from "./platform-growth-board"

export const dynamic = "force-dynamic"

// Platform self-marketing — market VIP Agents itself. Gated to platform marketing
// staff (or superadmin) via the capability map.
export default async function PlatformGrowthPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const role = (data as any)?.platform_role ?? ((data as any)?.user_type === "superadmin" ? "superadmin" : null)
  if (!platformStaffCan(role, "marketing")) return <div className="p-6 text-red-600">Forbidden: platform marketing access required</div>

  const res = await listPlatformProspectsAction()

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Growth — market the platform</h1>
        <p className="text-muted-foreground text-sm mt-1">
          The platform's own funnel: prospects who raised their hand for VIP Agents, from first touch to
          converted customer. Draft the product pitch, advance the funnel, and watch the conversion rate.
        </p>
      </div>
      {!res.ok ? (
        <div className="rounded border p-4 text-sm text-red-600">Failed: {res.error}</div>
      ) : (
        <PlatformGrowthBoard initialProspects={res.prospects} initialFunnel={res.funnel} />
      )}
    </div>
  )
}
