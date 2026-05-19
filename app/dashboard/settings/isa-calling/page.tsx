import { Suspense } from "react"
import { redirect } from "next/navigation"
import { Loader2 } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { listIsaPhoneNumbers } from "@/app/actions/isa-phone-numbers"
import { getAIISASettings } from "@/app/actions/ai-isa-settings"
import {
  defaultEnabledCapabilities,
  ISA_CAPABILITY_CATALOG,
} from "@/lib/ai-isa/settings-types"
import { IsaCallingClient } from "./isa-calling-client"

export const metadata = {
  title: "ISA Calling | Settings",
  description:
    "Configure phone numbers, BYOC carriers, IVR menus, and the duty agent for inbound and outbound AI ISA calls.",
}

export const dynamic = "force-dynamic"

async function IsaCallingContent() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, role")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md p-8">
          <h2 className="text-xl font-semibold text-foreground mb-2">
            Brokerage required
          </h2>
          <p className="text-muted-foreground">
            ISA calling configuration is set per brokerage. Join or create a
            brokerage to continue.
          </p>
        </div>
      </div>
    )
  }

  const [phoneNumbers, isaSettings] = await Promise.all([
    listIsaPhoneNumbers(profile.brokerage_id),
    getAIISASettings(profile.brokerage_id),
  ])

  // Resolve duty agent — the brokerage Admin user (defaults to first Admin)
  const { data: dutyAgent } = await supabase
    .from("users")
    .select("id, first_name, last_name, email")
    .eq("brokerage_id", profile.brokerage_id)
    .eq("role", "Admin")
    .limit(1)
    .maybeSingle()

  const enabledCapabilities = isaSettings.enabled_capabilities ?? defaultEnabledCapabilities()

  return (
    <IsaCallingClient
      brokerageId={profile.brokerage_id}
      phoneNumbers={phoneNumbers}
      dutyAgent={dutyAgent ?? null}
      currentUserRole={profile.role ?? null}
      capabilityCatalog={ISA_CAPABILITY_CATALOG}
      enabledCapabilities={enabledCapabilities}
    />
  )
}

export default function IsaCallingSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <IsaCallingContent />
    </Suspense>
  )
}
