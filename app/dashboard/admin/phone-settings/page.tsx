import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getBrokeragePhoneSettings, getPhoneAllowanceStatusAction } from "@/app/actions/phone-provisioning"
import { getVoiceUsageAction } from "@/app/actions/voice-tenancy"
import { GENERIC_VOICES } from "@/lib/voice/voice-resolver"
import { PhoneSettingsClient } from "./phone-settings-client"

const CRED_TIER_LABEL: Record<string, string> = {
  byo: "Your own Twilio account (BYO)",
  subaccount: "Platform-managed (your dedicated subaccount)",
  master: "Platform-managed",
  unconfigured: "Not configured yet",
}

export const dynamic = "force-dynamic"
export const metadata = { title: "Phone & ISA Voice" }

export default async function PhoneSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const settings = await getBrokeragePhoneSettings()
  if (!settings) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Brokerage settings unavailable.
      </div>
    )
  }

  const usageRes = await getVoiceUsageAction().catch(() => null)
  const allowanceRes = await getPhoneAllowanceStatusAction().catch(() => null)
  const allowanceStatus = allowanceRes?.success ? allowanceRes.status : null

  return (
    <div className="space-y-4">
      {/* Voice usage — the meter behind the bill (metered platform telephony) */}
      {usageRes?.ok && (
        <div className="mx-6 mt-6 rounded-lg border p-4">
          <div className="flex items-end justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm font-semibold">Voice usage — {usageRes.usage.month}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Numbers: {CRED_TIER_LABEL[usageRes.credTier] ?? usageRes.credTier}. Every AI call is metered here.
              </p>
            </div>
            <div className="flex items-center gap-5 text-sm">
              <span><span className="font-bold tabular-nums">{usageRes.usage.callCount}</span> <span className="text-muted-foreground">calls</span></span>
              <span><span className="font-bold tabular-nums">{usageRes.usage.minutes}</span> <span className="text-muted-foreground">min</span></span>
              <span><span className="font-bold tabular-nums">{usageRes.usage.activeNumbers}</span> <span className="text-muted-foreground">numbers</span></span>
              <span className="font-bold tabular-nums">${(usageRes.usage.totalCostCents / 100).toFixed(2)}<span className="text-xs font-normal text-muted-foreground"> this month</span></span>
            </div>
          </div>
        </div>
      )}
      <PhoneSettingsClient initialSettings={settings} genericVoices={GENERIC_VOICES} allowanceStatus={allowanceStatus} />
    </div>
  )
}
