"use server"

// Per-agent (all-tier) PHONE/SMS connect for Twilio/Telnyx/Bandwidth. Writes
// platform_credentials in the EXACT shape lib/providers/messaging/resolve-sms-provider.ts
// reads (api_key = Account SID, config.auth_token, config.from_number), scoped by
// agent_user_id for agents (their own line) or brokerage_id for broker/admin. A solo agent
// inside a brokerage can wire their own number; resolution prefers the user's row.
//
// No stub — what this writes is what dispatch (sendSMS/placeCall) actually uses.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"
import { writeScopeFor } from "@/lib/connections/scope"

export type PhonePlatform = "twilio" | "telnyx" | "bandwidth"
const PHONE_PLATFORMS: PhonePlatform[] = ["twilio", "telnyx", "bandwidth"]
const BROKERAGE_ROLES = ["superadmin", "admin", "broker", "broker_owner"]

interface Member { userId: string; brokerageId: string; agentScoped: boolean }

async function requireMember(): Promise<{ ok: true; member: Member } | { ok: false; error: string }> {
  const ctx = await getAgentContext().catch(() => null)
  if (!ctx?.isAuthenticated) return { ok: false, error: "Unauthenticated" }
  if (!ctx.brokerageId) return { ok: false, error: "No brokerage" }
  return { ok: true, member: { userId: ctx.userId, brokerageId: ctx.brokerageId, agentScoped: !BROKERAGE_ROLES.includes(ctx.userType) } }
}

export async function connectPhoneAction(params: {
  platform?: PhonePlatform
  accountSid: string
  authToken: string
  fromNumber: string
}): Promise<{ ok: true; scope: "agent" | "brokerage" } | { ok: false; error: string }> {
  const platform = params.platform ?? "twilio"
  if (!PHONE_PLATFORMS.includes(platform)) return { ok: false, error: "Unsupported phone provider" }
  if (!params.accountSid?.trim() || !params.authToken?.trim() || !params.fromNumber?.trim()) {
    return { ok: false, error: "Account SID, auth token, and from-number are all required" }
  }
  const gate = await requireMember()
  if (!gate.ok) return gate
  const { member } = gate
  const svc = createServiceClient()

  // Unified ownership scope (m102): agent line → agent owner, broker line → brokerage owner.
  const owner = writeScopeFor({
    agentUserId: member.agentScoped ? member.userId : null,
    brokerageId: member.brokerageId,
    isBrokerageManager: !member.agentScoped,
  })

  const row = {
    brokerage_id: member.brokerageId,
    agent_user_id: member.agentScoped ? member.userId : null,
    owner_type: owner?.ownerType ?? null,
    owner_id: owner?.ownerId ?? null,
    platform,
    scope: member.agentScoped ? "agent" : "brokerage",
    api_key: params.accountSid.trim(),
    config: { auth_token: params.authToken.trim(), from_number: params.fromNumber.trim() },
    is_active: true,
    updated_at: new Date().toISOString(),
  }

  if (member.agentScoped) {
    // Unique (brokerage_id, agent_user_id, platform) → clean upsert for the agent's own line.
    const { error } = await svc.from("platform_credentials").upsert(row, { onConflict: "brokerage_id,agent_user_id,platform" })
    if (error) return { ok: false, error: error.message }
  } else {
    // Brokerage scope (agent_user_id NULL) — NULLs are distinct in the unique index, so
    // update-or-insert manually to avoid duplicate brokerage rows.
    const { data: existing } = await svc
      .from("platform_credentials")
      .select("id")
      .eq("brokerage_id", member.brokerageId)
      .is("agent_user_id", null)
      .eq("platform", platform)
      .maybeSingle()
    const { error } = existing
      ? await svc.from("platform_credentials").update(row).eq("id", existing.id)
      : await svc.from("platform_credentials").insert(row)
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath("/settings/phone")
  return { ok: true, scope: member.agentScoped ? "agent" : "brokerage" }
}

export async function disconnectPhoneAction(platform: PhonePlatform = "twilio"): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await requireMember()
  if (!gate.ok) return gate
  const { member } = gate
  const svc = createServiceClient()
  let q = svc.from("platform_credentials").update({ is_active: false }).eq("brokerage_id", member.brokerageId).eq("platform", platform)
  q = member.agentScoped ? q.eq("agent_user_id", member.userId) : q.is("agent_user_id", null)
  const { error } = await q
  if (error) return { ok: false, error: error.message }
  revalidatePath("/settings/phone")
  return { ok: true }
}

export async function getPhoneStatusAction(): Promise<
  { ok: true; scope: "agent" | "brokerage"; connected: Array<{ platform: string; fromNumber: string | null }> } | { ok: false; error: string }
> {
  const gate = await requireMember()
  if (!gate.ok) return gate
  const { member } = gate
  const svc = createServiceClient()
  let q = svc
    .from("platform_credentials")
    .select("platform, config, is_active, agent_user_id")
    .eq("brokerage_id", member.brokerageId)
    .eq("is_active", true)
    .in("platform", PHONE_PLATFORMS)
  q = member.agentScoped ? q.eq("agent_user_id", member.userId) : q.is("agent_user_id", null)
  const { data, error } = await q
  if (error) return { ok: false, error: error.message }
  const connected = (data ?? []).map((r: any) => ({ platform: r.platform, fromNumber: (r.config?.from_number as string) ?? null }))
  return { ok: true, scope: member.agentScoped ? "agent" : "brokerage", connected }
}
