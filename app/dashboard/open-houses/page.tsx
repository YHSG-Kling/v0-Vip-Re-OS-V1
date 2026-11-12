import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { getOpenHouses } from "@/app/actions/open-house"
import { OpenHousesClient } from "./open-houses-client"
import { IntentAffordance } from "@/app/components/shared/intent-affordance"

export const dynamic = "force-dynamic"

export default async function OpenHousesPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    redirect("/login")
  }

  const result = await getOpenHouses()

  return (
    <>
      {/* C17 (wave 148D): "schedule a virtual open house for 12 Oak Street Saturday 1 to 3 pm". */}
      <div className="mx-auto w-full max-w-7xl px-4 pt-4">
        <IntentAffordance screen="open_houses" title="Tell me the open house you want" />
      </div>
      <OpenHousesClient
        initialEvents={result.events ?? []}
        fetchError={result.success ? undefined : (result.error ?? "Failed to load open houses")}
      />
    </>
  )
}
