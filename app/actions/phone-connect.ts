"use server"

// Per-agent (all-tier) PHONE/SMS connect for Twilio/Telnyx/Bandwidth. Writes
// platform_credentials in the EXACT shape lib/providers/messaging/resolve-sms-provider.ts
// reads (api_key = Account SID, config.auth_token, config.from_number), scoped by
// agent_user_id for agents (their own line) or brokerage_id for broker/admin. A solo agent
// inside a brokerage can wire their own number; resolution prefers the user's row.
//
// No stub — what this writes is what dispatch (sendSMS/placeCall) actually uses.

import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"
import { writeScopeFor } from "@/lib/connections/scope"

export type PhonePlatform = "twilio" | "telnyx" | "bandwidth"
const PHONE_PLATFORMS: PhonePlatform[] = ["twilio", "telnyx", "bandwidth"]
// SCOPE LADDER (kept inline — this array decides WHERE credentials are scoped,
// agent vs brokerage): 'superadmin' removed — dead as users.user_type (0 live
// rows store it).
const BROKERAGE_ROLES = ["admin", "broker", "broker_owner"]

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

  // Owner-keyed update-or-insert. The unique key is (owner_type, owner_id,
  // platform) and it is REAL — VERIFIED LIVE, not assumed: m104 created it as
  // `platform_credentials_owner_uniq`, a PARTIAL UNIQUE INDEX
  // `WHERE owner_type IS NOT NULL`, and a duplicate insert is refused with 23505.
  // It is spelled out here because it lives in pg_index and NOT in pg_constraint:
  // a check that dumps pg_constraint for this table sees only the two FKs and the
  // three CHECKs, reads the key as absent, and reports this comment as a lie. It
  // is not. A concurrent OAuth callback racing this read-then-write cannot
  // duplicate the credential — the second writer gets 23505, not a second row.
  const ownerType = owner?.ownerType ?? (member.agentScoped ? "agent" : "brokerage")
  const ownerId = owner?.ownerId ?? (member.agentScoped ? member.userId : member.brokerageId)
  const { data: existing } = await svc
    .from("platform_credentials")
    .select("id")
    .eq("owner_type", ownerType).eq("owner_id", ownerId).eq("platform", platform)
    .maybeSingle()
  const { error } = existing
    ? await svc.from("platform_credentials").update(row).eq("id", existing.id)
    : await svc.from("platform_credentials").insert(row)
  if (error) return { ok: false, error: error.message }

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
