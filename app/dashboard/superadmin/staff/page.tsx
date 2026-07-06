import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listPlatformStaffAction } from "@/app/actions/superadmin/platform-staff"
import { PlatformStaffManager } from "./platform-staff-manager"

export const dynamic = "force-dynamic"

// Superadmin: create/manage platform employees (support / superadmin) — the people
// who run the platform itself, above every tenant.
export default async function SuperadminStaffPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const isSuper = (data as any)?.user_type === "superadmin" || (data as any)?.platform_role === "superadmin"
  if (!isSuper) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const res = await listPlatformStaffAction()
  const staff = res.ok ? res.staff : []

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Platform staff</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Create employees who run the platform — support operators and super admins. They sit above
          every tenant (no brokerage). Every change is audited.
        </p>
      </div>
      {!res.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load staff: {res.error}</div>}
      <PlatformStaffManager initialStaff={staff} currentUserId={user.id} />
    </div>
  )
}
