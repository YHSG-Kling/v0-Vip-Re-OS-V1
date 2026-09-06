import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getConnectionCenter } from "@/app/actions/connections/connection-center"
import { ConnectionCenterClient } from "@/app/settings/connections/connection-center-client"
import { readRoleGrants, selectVendorId } from "@/lib/auth/role-grants"

export const dynamic = "force-dynamic"

export default async function VendorConnectionsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Resolve this vendor's id from the caller's role grants.
  //
  // WAS: `.not("vendor_id","is",null).maybeSingle()` with no limit and no error
  // check — the same shape as the four sites in app/actions, found by sweeping the
  // whole tree rather than the reported list. user_role_assignments is UNIQUE on
  // (user_id, role), NOT on user_id, so two vendor-bearing grants under different
  // roles are permitted and `.maybeSingle()` over them is an ERROR that supabase-js
  // RESOLVES. This page would then render "No vendor profile found for your
  // account." to a vendor who has one.
  const grantsResult = await readRoleGrants(supabase, user.id)
  const { vendorId, ambiguous } = grantsResult.ok
    ? selectVendorId(grantsResult.grants)
    : { vendorId: null, ambiguous: false }

  // Three distinct outcomes that used to share one message. A reader who is told
  // "no vendor profile" when the real answer is "the read was refused" goes looking
  // in the wrong place.
  const noVendorReason = !grantsResult.ok
    ? "We could not verify your vendor account just now — please refresh."
    : ambiguous
      ? "Your account is linked to more than one vendor — ask the brokerage to correct it."
      : "No vendor profile found for your account."
  if (!grantsResult.ok) {
    console.error("[vendor/connections] role grant read failed:", grantsResult.error)
  }

  const data = vendorId
    ? await getConnectionCenter({ scope: "vendor", id: vendorId })
    : { ok: false as const, error: noVendorReason, scope: "vendor" as const, domains: [] }

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
