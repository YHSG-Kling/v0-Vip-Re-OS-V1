import { notFound } from "next/navigation"
import { getOpenHouseDashboard } from "@/app/actions/seller-open-house"
import { createClient } from "@/lib/supabase/server"
import { OpenHouseClient } from "./open-house-client"

interface Props {
  params: Promise<{ id: string }>
}

export default async function OpenHousePage({ params }: Props) {
  const { id } = await params
  const data = await getOpenHouseDashboard(id)
  if (!data || !data.listing) notFound()

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // IDENTITY CLASS (m353). listings.agent_id ALREADY IS the agents id — it FKs
  // agents(id). This looked the agents row up by `user_id` using that value, so
  // it matched nothing on every listing and agentId was always "" — after which
  // the old `?? user?.id` quietly supplied a users id in its place. Two wrongs
  // that between them looked like a working page. No lookup is needed at all.
  const listingAgentId = (data.listing.agent_id as string | null) ?? ""

  return (
    <OpenHouseClient
      listingId={id}
      initialData={data}
      agentId={listingAgentId}
      userId={user?.id ?? ""}
    />
  )
}
