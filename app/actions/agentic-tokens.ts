"use server"

// Superadmin management of Agentic-API agent tokens (distinct from app/actions/
// agent-credentials.ts, which holds a real-estate agent's external-service keys).
// Minting returns the RAW token exactly once (only its sha256 is stored). Scopes
// follow the AGIS action model (e.g. "valuation:read", "lead:read", or "*"). Audit-logged.

import { createServiceClient } from "@/lib/supabase/service"
import { generateAgentToken, hashAgentToken } from "@/lib/agentic-os/agent-credentials"
import { requireSuperadmin } from "@/lib/auth/platform-guard"
import { requirePlatformCapability } from "@/lib/platform/require-capability"

// ─────────────────────────────────────────────────────────────────────────────
// THE GATE THIS FILE USED TO CARRY, AND WHY IT ADMITTED NOBODY
// ─────────────────────────────────────────────────────────────────────────────
//
// The local requireSuperadmin() tested exactly `users.user_type !==
// 'superadmin'`. Measured live: NO row in public.users has that user_type — the
// one platform superadmin is platform_role='superadmin' with user_type='admin',
// because 'admin' is also a TENANT user_type and the roster is therefore carried
// on platform_role (lib/platform/platform-staff-roster.ts). Every caller was
// refused, the owner included.
//
// The symptom was the SAME self-contradiction W37 found on the brokerage pages:
// /dashboard/superadmin/api-tokens gates on requirePlatformCapability("providers")
// and let staff in; listAgenticTokens() then refused them, so the page rendered
// an empty token table with a "Superadmin access required" loadError — for
// everybody, forever. agent_credentials holds 0 rows, which is consistent with a
// mint path that has never once executed.
//
// READ vs MINT — NOT the same authority, so not the same gate:
//   listAgenticTokens   → 'providers' capability ({superadmin, admin}), which is
//     exactly what the PAGE already gates on. Metadata only; the raw token is
//     never stored, let alone returned. Making the action agree with its page is
//     the fix; widening past the page would not be.
//   mintAgenticToken / revokeAgenticToken → requireSuperadmin(), the shared
//     lib/auth/platform-guard copy that reads BOTH identity columns. Minting a
//     Bearer credential — scope "*" is on the offered list — is minting platform
//     authority itself, and revoking one can black out a live integration. A
//     dead gate here failed CLOSED; it is restored to superadmin-only rather
//     than relaxed to the roster capability, so the fix is "the gate works",
//     not "the gate is wider".

function audit(svc: ReturnType<typeof createServiceClient>, actor: { userId: string; email: string }, action: string, details: Record<string, unknown>) {
  void svc.from("superadmin_audit_log").insert({
    actor_user_id: actor.userId, actor_email: actor.email, action, target_type: "agent_credentials", details,
  }).then(() => {}, () => {})
}

/** Mint a new agentic-API token. Returns the raw token ONCE. Superadmin only. */
export async function mintAgenticToken(params: {
  name: string
  scopes: string[]
  brokerageId?: string | null
  expiresAt?: string | null
}): Promise<{ ok: true; id: string; token: string } | { ok: false; error: string }> {
  const su = await requireSuperadmin()
  if (!su.ok) return su
  if (!params.name?.trim()) return { ok: false, error: "name is required" }
  if (!Array.isArray(params.scopes) || params.scopes.length === 0) return { ok: false, error: "at least one scope is required" }

  const rawToken = generateAgentToken()
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("agent_credentials")
    .insert({
      name: params.name.trim(),
      token_hash: hashAgentToken(rawToken),
      scopes: params.scopes,
      brokerage_id: params.brokerageId ?? null,
      created_by: su.userId,
      expires_at: params.expiresAt ?? null,
    })
    .select("id")
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" }

  audit(svc, su, "mint_agentic_token", { id: data.id, name: params.name, scopes: params.scopes, brokerageId: params.brokerageId ?? null })
  return { ok: true, id: data.id, token: rawToken } // raw token — shown once
}

/** Revoke (deactivate) an agentic-API token. Superadmin only. */
export async function revokeAgenticToken(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const su = await requireSuperadmin()
  if (!su.ok) return su
  const svc = createServiceClient()
  const { error } = await svc.from("agent_credentials").update({ is_active: false }).eq("id", id)
  if (error) return { ok: false, error: error.message }
  audit(svc, su, "revoke_agentic_token", { id })
  return { ok: true }
}

/** List agentic-API tokens (metadata only — never the raw token). Gated on the
 *  platform 'providers' capability, the SAME gate the api-tokens page uses. */
export async function listAgenticTokens(): Promise<
  { ok: true; rows: Array<{ id: string; name: string; scopes: string[]; brokerage_id: string | null; is_active: boolean; created_at: string; last_used_at: string | null }> }
  | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("providers")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("agent_credentials")
    .select("id, name, scopes, brokerage_id, is_active, created_at, last_used_at")
    .order("created_at", { ascending: false })
  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: data ?? [] }
}
