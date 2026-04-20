import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { getOpenHouses } from "@/app/actions/open-house"
import { OpenHousesClient } from "./open-houses-client"

export const dynamic = "force-dynamic"

export default async function OpenHousesPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    redirect("/login")
  }

  const result = await getOpenHouses()
  const events = result.success ? (result.events ?? []) : []

  return <OpenHousesClient initialEvents={events} />
}
