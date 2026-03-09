import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAdminOnboardingOverview } from "@/app/actions/onboarding/progress"
import { AdminOnboardingClient } from "./admin-onboarding-client"

export const metadata = {
  title: "Agent Onboarding Overview | Admin",
  description: "View and manage agent onboarding progress across your brokerage",
}

export default async function AdminOnboardingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!userData?.brokerage_id) {
    redirect("/dashboard")
  }

  // Only admins and brokers can access this page
  if (!["admin", "broker"].includes(userData.user_type || "")) {
    redirect("/dashboard")
  }

  // Fetch initial data
  const overviewResult = await getAdminOnboardingOverview()

  return (
    <AdminOnboardingClient
      initialData={overviewResult.data || null}
    />
  )
}
