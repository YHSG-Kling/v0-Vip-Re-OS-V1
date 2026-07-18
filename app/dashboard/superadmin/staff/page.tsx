import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { listPlatformStaffAction, getStaffProfilesAction, listCapabilityOverridesAction } from "@/app/actions/superadmin/platform-staff"
import { PlatformStaffManager } from "./platform-staff-manager"
import { CapabilityMatrix } from "./capability-matrix"

export const dynamic = "force-dynamic"

// Superadmin: platform employees — accounts + roles, per-staff HR RECORDS
// (platform_staff_profiles: title, start date, employment agreement +
// acknowledgment, notes), and the CAPABILITY MATRIX editor over the code-map
// defaults (platform_role_capability_overrides).
export default async function SuperadminStaffPage() {
  const gate = await requirePlatformCapability("staff")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const [res, profilesRes, overridesRes] = await Promise.all([
    listPlatformStaffAction(),
    getStaffProfilesAction(),
    listCapabilityOverridesAction(),
  ])
  const staff = res.ok ? res.staff : []
  const profiles = profilesRes.ok ? profilesRes.profiles : {}
  const overrides = overridesRes.ok ? overridesRes.overrides : []

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Platform staff</h1>
        <p className="text-muted-foreground text-sm mt-1">
          The people who run the platform — accounts, roles, HR records, and per-role capability
          overrides. They sit above every tenant (no brokerage). Every change is audited.
        </p>
      </div>
      {/* gate.access is SURFACED (not yet enforced at every write) — if an override
          granted this page read-only, say so honestly; the actions below still
          hard-require superadmin server-side. */}
      {gate.access === "read" && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          Your role has read-only access to this surface — edits are disabled server-side.
        </div>
      )}
      {!res.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load staff: {res.error}</div>}
      {!profilesRes.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load HR profiles: {profilesRes.error}</div>}
      <PlatformStaffManager initialStaff={staff} initialProfiles={profiles} currentUserId={gate.userId} />
      {!overridesRes.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load capability overrides: {overridesRes.error}</div>}
      <CapabilityMatrix initialOverrides={overrides} />
    </div>
  )
}
