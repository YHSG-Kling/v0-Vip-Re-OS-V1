import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getConnectionCenter } from "@/app/actions/connections/connection-center"
import { ConnectionCenterClient } from "@/app/settings/connections/connection-center-client"

export const dynamic = "force-dynamic"

export default async function ContactConnectionsPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // getConnectionCenter verifies (via requireContactAccess) that the caller IS this contact.
  const data = await getConnectionCenter({ scope: "contact", id: contactId })

  return (
    <div className="p-6 max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Connections</h1>
        <p className="text-sm text-muted-foreground">
          Connect your calendar, social accounts, and financial provider. Your agent never sees your
          credentials — only that a connection is active.
        </p>
      </div>
      <ConnectionCenterClient data={data} owner={{ scope: "contact", id: contactId }} />
    </div>
  )
}
