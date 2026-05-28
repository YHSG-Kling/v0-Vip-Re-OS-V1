"use server"

// Superadmin management of Agentic-API agent tokens (distinct from app/actions/
// agent-credentials.ts, which holds a real-estate agent's external-service keys).
// Minting returns the RAW token exactly once (only its sha256 is stored). Scopes
// follow the AGIS action model (e.g. "valuation:read", "lead:read", or "*"). Audit-logged.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateAgentToken, hashAgentToken } from "@/lib/agentic-os/agent-credentials"

async function requireSuperadmin(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, email").eq("id", user.id).maybeSingle()
  if (data?.user_type !== "superadmin") return { ok: false, error: "Superadmin access required" }
  return { ok: true, userId: user.id, email: data.email ?? user.email ?? "" }
}

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

/** List agentic-API tokens (metadata only — never the raw token). Superadmin only. */
export async function listAgenticTokens(): Promise<
  { ok: true; rows: Array<{ id: string; name: string; scopes: string[]; brokerage_id: string | null; is_active: boolean; created_at: string; last_used_at: string | null }> }
  | { ok: false; error: string }
> {
  const su = await requireSuperadmin()
  if (!su.ok) return su
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("agent_credentials")
    .select("id, name, scopes, brokerage_id, is_active, created_at, last_used_at")
    .order("created_at", { ascending: false })
  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: data ?? [] }
}
