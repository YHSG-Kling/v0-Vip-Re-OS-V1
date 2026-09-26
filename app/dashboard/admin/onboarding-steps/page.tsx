// app/dashboard/admin/onboarding-steps/page.tsx
// Server component. Only admin/broker/superadmin can access.
// Loads global + brokerage onboarding steps and tags each with their source.
// No any types. No default export.

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listOnboardingSteps } from "@/lib/kernel"
import type { OnboardingStepRow } from "@/lib/kernel"
import { OnboardingStepsClient } from "./OnboardingStepsClient"

// TRUE ADMIN GATE (operational: onboarding) — repointed to the ONE tenant
// roster, matching the repointed action gate in app/actions/admin/onboarding-steps.ts.
// 'superadmin' was dead: 0 live rows store that users.user_type.
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export default async function OnboardingStepsAdminPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) redirect("/login")

  // Load user_type to enforce admin gate
  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .single()

  if (userError || !userRow) redirect("/login")
  if (!isAdminOrBroker({ user_type: userRow.user_type })) {
    redirect("/dashboard")
  }

  // listOnboardingSteps already enforces admin gate + brokerage scoping internally
  let steps: OnboardingStepRow[] = []
  try {
    steps = await listOnboardingSteps({ userId: user.id })
  } catch {
    steps = []
  }

  // Tag each step with its source for the client component
  const taggedSteps = steps.map(step => ({
    ...step,
    source: step.brokerage_id === null ? ("GLOBAL" as const) : ("BROKERAGE" as const),
  }))

  const globalCount = taggedSteps.filter(s => s.source === "GLOBAL").length
  const brokerageCount = taggedSteps.filter(s => s.source === "BROKERAGE").length

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Onboarding Steps Management</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage brokerage-specific onboarding steps. Global steps are read-only and cannot be edited or deleted.
        </p>
      </div>

      <div className="flex gap-4">
        <div className="rounded border border-gray-200 bg-white px-4 py-3 text-center">
          <div className="text-2xl font-bold text-gray-900">{globalCount}</div>
          <div className="text-xs text-gray-500 mt-0.5">Global Steps</div>
        </div>
        <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-center">
          <div className="text-2xl font-bold text-blue-700">{brokerageCount}</div>
          <div className="text-xs text-blue-600 mt-0.5">Brokerage Steps</div>
        </div>
      </div>

      <OnboardingStepsClient initialSteps={taggedSteps} />
    </main>
  )
}
