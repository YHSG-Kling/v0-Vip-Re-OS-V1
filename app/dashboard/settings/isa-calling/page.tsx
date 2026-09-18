import { Suspense } from "react"
import { rawRoleVariantsFor } from "@/lib/security/types"
import { redirect } from "next/navigation"
import { Loader2 } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { ensureAgentBrokerage } from "@/app/actions/onboarding/ensure-agent-brokerage"
import { listIsaPhoneNumbers } from "@/app/actions/isa-phone-numbers"
import { getAIISASettings } from "@/app/actions/ai-isa-settings"
import {
  defaultEnabledCapabilities,
  ISA_CAPABILITY_CATALOG,
} from "@/lib/ai-isa/settings-types"
import { IsaCallingClient } from "./isa-calling-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

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


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Heal an incomplete account IN PLACE before reading the brokerage — don't bounce
  // the user off the ISA Calling settings they're configuring.
  await ensureAgentBrokerage()

  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  // Heal genuinely couldn't complete (pending invite / non-agent) — honest in-place
  // notice instead of a bounce.
  if (!profile?.brokerage_id) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md p-8">
          <h2 className="text-xl font-semibold text-foreground mb-2">Finishing setup</h2>
          <p className="text-muted-foreground">
            We&rsquo;re provisioning your brokerage — refresh in a moment to configure ISA calling.
          </p>
        </div>
      </div>
    )
  }

  const [phoneNumbers, isaSettings] = await Promise.all([
    listIsaPhoneNumbers(profile.brokerage_id),
    getAIISASettings(profile.brokerage_id),
  ])

  // Resolve duty agent — the brokerage's admin (first one).
  //
  // This used to filter `.eq("role", "Admin")`. users.role is a legacy column:
  // live it is NULL on 19 of 23 rows and holds mixed case ('Admin', 'agent',
  // 'Lender') where it is set at all, with no CHECK to keep it honest. So the
  // duty agent resolved by luck or not at all, and the read dropped its error
  // besides. user_type is the disciplined column (CHECK-constrained, lowercase,
  // populated), expanded through the same alias table the canonicalizer uses.
  const { data: dutyAgent, error: dutyAgentError } = await supabase
    .from("users")
    .select("id, first_name, last_name, email")
    .eq("brokerage_id", profile.brokerage_id)
    // RECIPIENT FILTER: 'superadmin' dropped — matches zero users.user_type rows;
    // broker_owner appended (storable owner seat; not a canonical role, so the
    // expansion cannot carry it).
    .in("user_type", [...rawRoleVariantsFor(["admin", "broker"]), "broker_owner"])
    .limit(1)
    .maybeSingle()
  if (dutyAgentError) {
    console.error("[isa-calling] duty-agent lookup failed:", dutyAgentError.message)
  }

  const enabledCapabilities = isaSettings.enabled_capabilities ?? defaultEnabledCapabilities()

  return (
    <IsaCallingClient
      brokerageId={profile.brokerage_id}
      phoneNumbers={phoneNumbers}
      dutyAgent={dutyAgent ?? null}
      currentUserRole={profile.user_type ?? null}
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
