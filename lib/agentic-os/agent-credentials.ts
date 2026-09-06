// lib/agentic-os/agent-credentials.ts
// Agentic-API agent tokens. An external AI agent authenticates with a bearer token;
// the token's sha256 is stored (raw shown once at mint). The credential carries the
// granted scopes (which AGIS actions it may invoke) and the brokerage it acts for.
//
// Pure helpers (hash, generate, bearer extraction) are unit-tested; resolveAgentToken
// is the server lookup.

import { createHash, randomBytes } from "node:crypto"

const TOKEN_PREFIX = "vos_" // VIP-RE-OS agent token

/** Pure: sha256 hex of a raw token — what we store + look up by. */
export function hashAgentToken(rawToken: string): string {
  return createHash("sha256").update(rawToken.trim()).digest("hex")
}

/** Generate a new opaque agent token (raw — returned to the operator exactly once). */
export function generateAgentToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url")
}

/** Pure: extract a bearer token from an Authorization header, or null. */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
  const tok = m?.[1]?.trim()
  return tok && tok.startsWith(TOKEN_PREFIX) ? tok : null
}

export interface ResolvedAgentToken {
  credentialId: string
  brokerageId: string | null
  scopes: string[]
}

/**
 * Resolve a raw agent bearer token to its credential. Returns null when the token is
 * unknown, inactive, or expired. Touches last_used_at (fire-and-forget). Never throws.
 */
export async function resolveAgentToken(rawToken: string): Promise<ResolvedAgentToken | null> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const tokenHash = hashAgentToken(rawToken)
    const { data, error } = await svc
      .from("agent_credentials")
      .select("id, brokerage_id, scopes, is_active, expires_at")
      .eq("token_hash", tokenHash)
      .maybeSingle()
    if (error || !data || !data.is_active) return null
    if (data.expires_at && new Date(data.expires_at) < new Date()) return null

    void svc.from("agent_credentials").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {}, () => {})
    return { credentialId: data.id, brokerageId: data.brokerage_id ?? null, scopes: data.scopes ?? [] }
  } catch {
    return null
  }
}

export interface AgenticCaller {
  brokerageId: string | null
  scopes: string[]
  via: "token" | "session" | "none"
}

/**
 * Resolve the agentic-API caller from a request: an `Authorization: Bearer vos_...`
 * agent token (scopes from the credential) OR the logged-in session (platform staff
 * implicitly hold all scopes "*"). Returns via:"none" when neither authenticates.
 */
export async function resolveAgenticCaller(req: Request): Promise<AgenticCaller> {
  const raw = extractBearerToken(req.headers.get("authorization"))
  if (raw) {
    const resolved = await resolveAgentToken(raw)
    if (resolved) return { brokerageId: resolved.brokerageId, scopes: resolved.scopes, via: "token" }
    return { brokerageId: null, scopes: [], via: "none" } // token present but invalid
  }
  const { createClient } = await import("@/lib/supabase/server")
  const { requireAuth } = await import("@/lib/kernel/api-auth")
  const { isPlatformStaffIdentity } = await import("@/lib/auth/resolve-user-role")
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { brokerageId: null, scopes: [], via: "none" }
  // Wildcard scopes are platform-staff only, and staff identity is dual-column. The
  // previous `isPlatformStaff(auth.userType)` handed "*" to any tenant user carrying
  // user_type='support' and withheld it from the platform's own superadmin, whose
  // row is (user_type='admin', platform_role='superadmin').
  return {
    brokerageId: auth.brokerageId,
    scopes: isPlatformStaffIdentity(auth.userType, auth.platformRole) ? ["*"] : [],
    via: "session",
  }
}
