import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { listCampaignSequences } from "@/app/actions/campaign-sequences"
import SequencesListClient from "./SequencesListClient"

export const metadata = {
  title: "Campaign Sequences | VIP Real Estate OS",
  description: "Build and manage multi-step outreach sequences across email, SMS, video, and direct mail.",
}

export default async function CampaignSequencesPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const { sequences } = await listCampaignSequences(profile.brokerage_id)
  const params = await searchParams
  const openCreate = params.action === "create"

  return (
    <SequencesListClient
      sequences={sequences}
      brokerageId={profile.brokerage_id}
      userId={user.id}
      openCreate={openCreate}
      pageType="marketing"
    />
  )
}
