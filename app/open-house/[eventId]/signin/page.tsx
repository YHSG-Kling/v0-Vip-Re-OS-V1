import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { SignInKiosk } from "./sign-in-kiosk"

interface Props {
  params: Promise<{ eventId: string }>
}

export default async function OpenHouseSignInPage({ params }: Props) {
  const { eventId } = await params
  const supabase = createServiceClient()

  const { data: event } = await supabase
    .from("open_house_events")
    .select(`
      id,
      event_date,
      start_time,
      end_time,
      status,
      listing_id,
      agent_id,
      listings (
        address,
        city,
        state,
        zip,
        list_price,
        agent_id,
        brokerage_id
      )
    `)
    .eq("id", eventId)
    .maybeSingle()

  if (!event || event.status === "cancelled") notFound()

  // Load agent info — users table has first_name, last_name (no full_name)
  const { data: agentUser } = await supabase
    .from("users")
    .select("id, first_name, last_name, email")
    .eq("id", event.agent_id)
    .maybeSingle()

  const agent = agentUser
    ? {
        id: agentUser.id,
        full_name: [agentUser.first_name, agentUser.last_name].filter(Boolean).join(" ") || null,
        avatar_url: null as string | null,
        email: agentUser.email,
      }
    : null

  // Load brokerage branding from global_settings
  const listing = event.listings as any
  const { data: settings } = listing?.brokerage_id
    ? await supabase
        .from("global_settings")
        .select("app_name, app_logo_url, primary_color, from_name")
        .eq("brokerage_id", listing.brokerage_id)
        .maybeSingle()
    : { data: null }

  return (
    <SignInKiosk
      event={{
        id: event.id,
        eventDate: event.event_date,
        startTime: event.start_time,
        endTime: event.end_time,
        listing: listing ?? null,
      }}
      agent={agent ?? null}
      branding={settings ?? null}
    />
  )
}
