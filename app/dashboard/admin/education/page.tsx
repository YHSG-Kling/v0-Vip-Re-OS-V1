import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getEducationModules } from "@/app/actions/admin/license-tracking"
import { EducationContentClient } from "./education-client"

export const metadata = {
  title: "Education Content | Admin | VIP Real Estate OS",
}

export default async function AdminEducationPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")
  if (!["broker", "broker_owner", "admin", "team_lead", "superadmin"].includes(profile.user_type ?? "")) {
    redirect("/dashboard")
  }

  const { modules } = await getEducationModules(profile.brokerage_id)

  return (
    <div className="container max-w-4xl py-6">
      <EducationContentClient
        brokerageId={profile.brokerage_id}
        initialModules={modules}
      />
    </div>
  )
}
