import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { listCeCompletions } from "@/app/actions/admin/license-tracking"
import { getCeCenter } from "@/app/actions/ce-provider"
import { LicenseCEClient } from "./license-ce-client"
import { CeCenterPanel } from "./ce-center-panel"

export const dynamic = "force-dynamic"
export const metadata = { title: "License & CE" }

export default async function LicenseCEPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const svc = createServiceClient()
  const { data: agent } = await svc
    .from("agents")
    .select(
      "id, license_number, license_state, license_expiry, ethics_completed_at, ethics_due_date, ce_hours_required, ce_hours_completed, ce_cycle_end_date"
    )
    .eq("user_id", user.id)
    .maybeSingle()

  if (!agent) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Agent profile not found.
      </div>
    )
  }

  const completions = await listCeCompletions(agent.id)
  const ceCenter = await getCeCenter().catch(() => null)

  // Whether to RENDER the provider-setup form. `connectCeProvider` re-checks this
  // same allowlist server-side, so this is presentation only, never the gate.
  // Vocabulary is the live `users_user_type_check` (broker_owner is storable;
  // `broker_admin` is not, and `users.role` is retired).
  const { data: viewer } = await svc
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()
  const canManageProvider = ["broker", "broker_owner", "admin", "superadmin"].includes(
    String((viewer as { user_type?: string | null } | null)?.user_type ?? ""),
  )

  return (
    <div className="space-y-6">
    {ceCenter && <CeCenterPanel center={ceCenter} canManageProvider={canManageProvider} />}
    <LicenseCEClient
      agentId={agent.id}
      profile={{
        licenseNumber: agent.license_number ?? null,
        licenseState: agent.license_state ?? null,
        licenseExpiry: agent.license_expiry ?? null,
        ethicsCompletedAt: agent.ethics_completed_at ?? null,
        ethicsDueDate: agent.ethics_due_date ?? null,
        ceHoursRequired: Number(agent.ce_hours_required ?? 0),
        ceHoursCompleted: Number(agent.ce_hours_completed ?? 0),
        ceCycleEndDate: agent.ce_cycle_end_date ?? null,
      }}
      initialCompletions={completions}
    />
    </div>
  )
}
