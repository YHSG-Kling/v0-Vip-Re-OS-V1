import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getPhoneStatusAction } from "@/app/actions/phone-connect"
import { PhoneConnectForm } from "./phone-connect-form"

export const dynamic = "force-dynamic"

export default async function PhoneSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const status = await getPhoneStatusAction()

  return (
    <div className="p-6 max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Phone / SMS</h1>
        <p className="text-sm text-muted-foreground">
          Connect your own calling/SMS line.
          {status.ok && (status.scope === "agent" ? " This is your personal line." : " This is the brokerage line.")}
        </p>
      </div>
      {!status.ok ? (
        <div className="text-red-600 text-sm">{status.error}</div>
      ) : (
        <PhoneConnectForm connected={status.connected} />
      )}
    </div>
  )
}
