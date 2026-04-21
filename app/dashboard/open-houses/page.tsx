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

  return (
    <OpenHousesClient
      initialEvents={result.events ?? []}
      fetchError={result.success ? undefined : (result.error ?? "Failed to load open houses")}
    />
  )
}
