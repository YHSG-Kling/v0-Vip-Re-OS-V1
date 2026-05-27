import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getCrmStatusAction } from "@/app/actions/crm-connect"
import { CrmConnectForm } from "./crm-connect-form"

export const dynamic = "force-dynamic"

export default async function CrmSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const status = await getCrmStatusAction()

  return (
    <div className="p-6 max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">CRM Sync</h1>
        <p className="text-sm text-muted-foreground">
          Connect your CRM to sync contact updates OUT of VIP RE OS (one-way — nothing syncs back in).
          {status.ok && (status.scope === "agent"
            ? " You're setting up your personal CRM stack."
            : " You're managing the brokerage-wide CRM.")}
        </p>
      </div>
      {!status.ok ? (
        <div className="text-red-600 text-sm">{status.error}</div>
      ) : (
        <CrmConnectForm active={status.active} connected={status.connected} />
      )}
    </div>
  )
}
