import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getBrokeragePhoneSettings, getPhoneAllowanceStatusAction, getTenantPhoneMeterAction } from "@/app/actions/phone-provisioning"
import { getVoiceUsageAction, getTwilioByoStatusAction } from "@/app/actions/voice-tenancy"
import { TwilioByoCard } from "./twilio-byo-card"
import { AgentPortInCard, type PortInAgentOption } from "./agent-port-in-card"
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

  // INCLUDED-VS-OVERAGE METER (wave 26). The voice-usage strip above shows raw
  // spend; this shows it against what the plan BUNDLES — the difference between
  // "you made 340 minutes of calls" and "90 of those are billable". Nothing
  // rendered this before, so the bundle half of the phone bill was invisible to
  // the tenant paying it.
  const meterRes = await getTenantPhoneMeterAction().catch(() => null)
  const phoneMeter = meterRes?.success ? meterRes.meter : null

  // BYO Twilio (Multi-Location only) — the escape hatch had no UI at all, so
  // the one commercially-promised way off platform-managed telephony could not
  // be reached. The tier rule is enforced inside setTwilioByoCredsAction; this
  // only decides whether to RENDER the card. Tenants already carrying BYO creds
  // see it regardless of the tier read, so a plan change can never strand a
  // configured account with no way to look at or replace it.
  // Agent roster for the port-in card. getAgents() runs on the COOKIE client, so
  // RLS (agents_read_brokerage) scopes it to the caller's own brokerage — the
  // page never names a tenant. manuallyAddAgentPhone re-checks tenancy anyway.
  // getAgents now returns a DISCRIMINATED result: [] had to mean "no agents",
  // "you may not see the roster" and "the read was refused" all at once, and
  // supabase-js resolves a refused query so the caller could not tell them
  // apart. This page is admin-only, so the role gate it gained costs nothing
  // here; an unreadable roster simply yields no port-in options rather than a
  // silently empty picker that looks like a brokerage with no agents.
  const { getAgents } = await import("@/app/actions/agents")
  const rosterResult = await getAgents().catch(() => ({ ok: false as const, error: "roster unavailable" }))
  if (!rosterResult.ok) {
    console.error("[phone-settings] agent roster unavailable:", rosterResult.error)
  }
  const agentRows = rosterResult.ok ? rosterResult.agents : []
  const portInAgents: PortInAgentOption[] = (agentRows as any[])
    .map((a) => ({
      agentId: a?.id as string,
      // Identity lives on users (agents has no first_name/last_name/email).
      name: (a?.user?.name as string) || (a?.user?.email as string) || "Unnamed agent",
    }))
    .filter((a) => Boolean(a.agentId))

  const byoRes = await getTwilioByoStatusAction().catch(() => null)
  const byoConfigured = byoRes?.ok ? byoRes.configured : false
  const showByo = usageRes?.ok && (usageRes.planTier === "multi_location" || byoConfigured)

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
      {/* Included-vs-overage meter — what the bundle covers and what is billable */}
      {phoneMeter && meterRes?.success && (
        <div className="mx-6 rounded-lg border p-4">
          <div className="flex items-end justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm font-semibold">Plan allowance — {meterRes.month}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                What your {meterRes.tier.replace("_", " ")} plan includes, and what is billed on top.
              </p>
            </div>
            <div className="flex items-center gap-5 text-sm flex-wrap">
              <span>
                <span className="font-bold tabular-nums">{phoneMeter.voiceMinutes}</span>
                <span className="text-muted-foreground"> / {phoneMeter.includedVoiceMinutes} min</span>
              </span>
              <span>
                <span className="font-bold tabular-nums">{phoneMeter.smsSegments}</span>
                <span className="text-muted-foreground"> / {phoneMeter.includedSmsSegments} SMS</span>
              </span>
              <span>
                <span className="font-bold tabular-nums">{phoneMeter.activeNumbers}</span>
                <span className="text-muted-foreground"> / {phoneMeter.includedNumbers} numbers</span>
              </span>
              {/* Honest zero: inside the bundle reads as "included", never as a blank. */}
              {phoneMeter.overageTotalCents > 0 ? (
                <span className="font-bold tabular-nums text-amber-700">
                  +${(phoneMeter.overageTotalCents / 100).toFixed(2)}
                  <span className="text-xs font-normal text-muted-foreground"> overage</span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">All usage included</span>
              )}
            </div>
          </div>
        </div>
      )}
      {showByo && (
        <TwilioByoCard
          initialConfigured={byoConfigured}
          initialAccountSid={byoRes?.ok ? byoRes.accountSid : null}
        />
      )}
      <AgentPortInCard agents={portInAgents} />
      <PhoneSettingsClient initialSettings={settings} genericVoices={GENERIC_VOICES} allowanceStatus={allowanceStatus} />
    </div>
  )
}
