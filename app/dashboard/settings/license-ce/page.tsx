import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { listCeCompletions } from "@/app/actions/admin/license-tracking"
import { LicenseCEClient } from "./license-ce-client"

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

  return (
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
  )
}
