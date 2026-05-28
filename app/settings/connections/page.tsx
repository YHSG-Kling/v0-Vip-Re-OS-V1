import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getConnectionCenter } from "@/app/actions/connections/connection-center"
import { ConnectionCenterClient } from "./connection-center-client"

export const dynamic = "force-dynamic"

export default async function ConnectionsSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const data = await getConnectionCenter()

  return (
    <div className="p-6 max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Connections</h1>
        <p className="text-sm text-muted-foreground">
          Connect the outside services this command center works through — email &amp; calendar,
          phone, CRM, transaction &amp; e-sign, financial, IDX, and social. You only see what your
          tier is allowed to own.
        </p>
      </div>
      <ConnectionCenterClient data={data} />
    </div>
  )
}
