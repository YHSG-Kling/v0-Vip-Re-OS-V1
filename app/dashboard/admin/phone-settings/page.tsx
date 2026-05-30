import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getBrokeragePhoneSettings } from "@/app/actions/phone-provisioning"
import { GENERIC_VOICES } from "@/lib/voice/voice-resolver"
import { PhoneSettingsClient } from "./phone-settings-client"

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

  return <PhoneSettingsClient initialSettings={settings} genericVoices={GENERIC_VOICES} />
}
