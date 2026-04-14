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

  const { data: agentRecord } = data.listing.agent_id
    ? await supabase.from("agents").select("id").eq("user_id", data.listing.agent_id).maybeSingle()
    : { data: null }

  return (
    <OpenHouseClient
      listingId={id}
      initialData={data}
      agentId={agentRecord?.id ?? user?.id ?? ""}
      userId={user?.id ?? ""}
    />
  )
}
