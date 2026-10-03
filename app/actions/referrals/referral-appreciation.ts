"use server"

// app/actions/referrals/referral-appreciation.ts
// ─────────────────────────────────────────────────────────────────────────────
// The referrer love loop's write surface:
//   · setReferralAppreciationSettingAction — the appreciation DECIDED BY the
//     agent / team / brokerage (cascade stored in brokerage_settings.settings.
//     referral_appreciation; agent writes byAgent[self], team_lead byTeam[team],
//     broker/admin the brokerage default). Value clamped to the hard cap.
//   · linkReferrerContactAction — attach the referrer AS A CONTACT to a referral
//     (fixes the free-text referred_by gap so the loop knows who to thank).
//   · recordReferralGiftSentAction — a human records the gift actually went out;
//     only then does gift_sent flip (the loop never auto-sends anything).

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { mergeBrokerageSettings } from "@/lib/settings/brokerage-settings-merge"
import { revalidatePath } from "next/cache"
import {
  resolveAppreciationSetting, APPRECIATION_HARD_CAP_CENTS,
  type AppreciationSetting,
} from "@/lib/kernel/referral-appreciation"

// SCOPE LADDER (kept inline — team_lead deliberately gets only the team clause
// below): 'superadmin' removed — dead as users.user_type (0 live rows);
// broker_owner added — storable seat that owns the brokerage.
const BROKERAGE_SCOPE_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

async function requireCaller() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase.from("users").select("user_type, brokerage_id, team_id").eq("id", user.id).maybeSingle()
  if (!data?.brokerage_id) return null
  return { userId: user.id, userType: (data as any).user_type ?? "agent", brokerageId: (data as any).brokerage_id, teamId: (data as any).team_id ?? null }
}

export async function setReferralAppreciationSettingAction(input: {
  scope: "brokerage" | "team" | "agent"
  teamId?: string
  agentId?: string
  enabled: boolean
  maxValueCents: number
  kind: string
  note?: string
}): Promise<{ ok: boolean; error?: string; resolved?: AppreciationSetting }> {
  const caller = await requireCaller()
  if (!caller) return { ok: false, error: "Unauthenticated or no brokerage" }

  if (input.scope === "brokerage" && !BROKERAGE_SCOPE_ROLES.has(caller.userType)) {
    return { ok: false, error: "Only a broker/admin sets the brokerage default" }
  }
  if (input.scope === "team" && !BROKERAGE_SCOPE_ROLES.has(caller.userType) && caller.userType !== "team_lead") {
    return { ok: false, error: "Only a team lead or broker/admin sets a team's appreciation" }
  }

  const entry = {
    enabled: !!input.enabled,
    maxValueCents: Math.max(0, Math.min(Math.round(input.maxValueCents) || 0, APPRECIATION_HARD_CAP_CENTS)),
    kind: (input.kind ?? "").trim().slice(0, 120) || "handwritten card + small gift",
    note: (input.note ?? "").trim() || null,
  }

  const svc = createServiceClient()
  // Resolve WHERE the entry goes first (async lookups), then merge it BY KEY onto the settings the
  // database holds at write time (86C, version-checked): the old read ignored its refusal and
  // rewrote the whole object, so a concurrent save of any other key was lost.
  let teamId: string | null = null
  let targetAgent: string | null = null
  if (input.scope === "team") {
    teamId = input.teamId ?? caller.teamId
    if (!teamId) return { ok: false, error: "teamId required for team scope" }
  } else if (input.scope !== "brokerage") {
    // agent scope — an agent may only set their own; broker/admin may set anyone's.
    const agentId = BROKERAGE_SCOPE_ROLES.has(caller.userType) ? (input.agentId ?? null) : null
    targetAgent = agentId ?? (await resolveOwnAgentId(svc, caller.userId))
    if (!targetAgent) return { ok: false, error: "No agent record to scope the setting to" }
  }

  const write = await mergeBrokerageSettings(svc, caller.brokerageId, (settings) => {
    const root = { ...((settings.referral_appreciation as Record<string, any> | undefined) ?? {}) }
    if (input.scope === "brokerage") Object.assign(root, entry)
    else if (teamId) root.byTeam = { ...(root.byTeam ?? {}), [teamId]: entry }
    else if (targetAgent) root.byAgent = { ...(root.byAgent ?? {}), [targetAgent]: entry }
    return { referral_appreciation: root }
  })
  if (!write.ok) return { ok: false, error: write.error }

  revalidatePath("/referrals/pipeline")
  return { ok: true, resolved: resolveAppreciationSetting({ [input.scope]: entry } as any) }
}

async function resolveOwnAgentId(svc: any, userId: string): Promise<string | null> {
  const { data } = await svc.from("agents").select("id").eq("user_id", userId).maybeSingle()
  return (data as any)?.id ?? null
}

/** Attach the referrer as a CONTACT to a referral (must be in the caller's brokerage). */
export async function linkReferrerContactAction(input: { referralId: string; referrerContactId: string }): Promise<{ ok: boolean; error?: string }> {
  const caller = await requireCaller()
  if (!caller) return { ok: false, error: "Unauthenticated or no brokerage" }
  const svc = createServiceClient()

  const [{ data: ref }, { data: contact }] = await Promise.all([
    svc.from("referrals").select("id, brokerage_id").eq("id", input.referralId).maybeSingle(),
    svc.from("contacts").select("id, brokerage_id, first_name, last_name").eq("id", input.referrerContactId).maybeSingle(),
  ])
  if (!ref || (ref as any).brokerage_id !== caller.brokerageId) return { ok: false, error: "Referral not found in your brokerage" }
  if (!contact || (contact as any).brokerage_id !== caller.brokerageId) return { ok: false, error: "Referrer contact not found in your brokerage" }

  const name = [(contact as any).first_name, (contact as any).last_name].filter(Boolean).join(" ")
  const { error } = await svc.from("referrals")
    .update({ referrer_contact_id: input.referrerContactId, referred_by: name || undefined, updated_at: new Date().toISOString() })
    .eq("id", input.referralId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/referrals/pipeline")
  return { ok: true }
}

/** A human records the appreciation actually went out — only then gift_sent flips. */
export async function recordReferralGiftSentAction(referralId: string): Promise<{ ok: boolean; error?: string }> {
  const caller = await requireCaller()
  if (!caller) return { ok: false, error: "Unauthenticated or no brokerage" }
  const svc = createServiceClient()
  const { error } = await svc.from("referrals")
    .update({ gift_sent: true, gift_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", referralId).eq("brokerage_id", caller.brokerageId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/referrals/pipeline")
  return { ok: true }
}
