import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getConnectionCenter } from "@/app/actions/connections/connection-center"
import { ConnectionCenterClient } from "@/app/settings/connections/connection-center-client"

export const dynamic = "force-dynamic"

export default async function VendorConnectionsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Resolve this vendor's id (role assignment first, then direct vendors.user_id link).
  const { data: ra } = await supabase
    .from("user_role_assignments").select("vendor_id").eq("user_id", user.id).not("vendor_id", "is", null).maybeSingle()
  let vendorId = (ra?.vendor_id as string | null) ?? null
  if (!vendorId) {
    const { data: v } = await supabase.from("vendors").select("id").eq("user_id", user.id).maybeSingle()
    vendorId = (v?.id as string | null) ?? null
  }

  const data = vendorId
    ? await getConnectionCenter({ scope: "vendor", id: vendorId })
    : { ok: false as const, error: "No vendor profile found for your account.", scope: "vendor" as const, domains: [] }

  return (
    <div className="p-6 max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Connections</h1>
        <p className="text-sm text-muted-foreground">
          Connect your calendar, social accounts, and financial provider so the platform can
          schedule with you, publish on your behalf, and handle payouts.
        </p>
      </div>
      <ConnectionCenterClient data={data} owner={vendorId ? { scope: "vendor", id: vendorId } : undefined} />
    </div>
  )
}
