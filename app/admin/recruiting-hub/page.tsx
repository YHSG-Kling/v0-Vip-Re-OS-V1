import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { RecruitingPipelineClient } from "./recruiting-pipeline-client"
import type { Recruit } from "./recruiting-pipeline-client"
import { Users } from "lucide-react"

export const dynamic = "force-dynamic"

export default async function RecruitingHubPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const resolvedType = profile?.user_type ?? profile?.role ?? ""
  if (!["broker", "admin", "superadmin"].includes(resolvedType)) {
    redirect("/dashboard")
  }

  const { data: recruits } = await supabase
    .from("recruits")
    .select(`
      id, first_name, last_name, email, phone, status,
      license_state, current_brokerage, years_experience,
      annual_volume, contact_method, notes, created_at,
      recruiter_agent_id, last_contact_date, provisioned
    `)
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Users className="h-5 w-5 text-slate-600" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Recruiting Pipeline</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Manage prospects from first contact through provisioning as an agent
          </p>
        </div>
        <a
          href="/dashboard/recruiting-roi"
          className="text-sm text-blue-600 hover:underline"
        >
          View ROI Analytics
        </a>
      </div>

      <RecruitingPipelineClient
        recruits={(recruits ?? []) as Recruit[]}
        brokerageId={profile.brokerage_id}
      />
    </div>
  )
}
