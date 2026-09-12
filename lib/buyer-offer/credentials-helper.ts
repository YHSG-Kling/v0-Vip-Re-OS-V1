// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published getAgentProviderCredentials({ agentId, provider })
// and hasProviderCredentials({ agentId, provider }) as public HTTP doors with no
// gate: a service client RETURNING platform_credentials (an API key, an access
// token, a refresh token) for any caller-supplied agentId — section 4's named
// IDOR shape, on the one table whose rows are secrets. Every caller is
// in-process server code (re-verified 2026-09-03):
//   · lib/buyer-offer/index.ts:10-14 (the barrel), whose value importers are
//     app/actions/buyer-offer/{submit-for-signature,respond-to-counter,
//     convert-to-transaction}.ts — all "use server" — and NONE of which
//     imports these two names; no other module in the tree calls them
// so the directive published nothing anyone needed. `server-only` makes a future
// client import fail at build time instead of bundling the service credential.
// agentId is now an IN-PROCESS CONTRACT: with the door closed, the server
// caller that supplies it is the gate.
import "server-only"

/**
 * System 7.1B - Provider Credentials Helper
 * 
 * Retrieves agent-scoped provider credentials from platform_credentials table.
 * 
 * NEVER uses process.env.DOTLOOP_API_KEY directly.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"

export interface ProviderCredentials {
  apiKey: string
  profileId?: string
  accessToken?: string
  refreshToken?: string
}

/**
 * Get agent provider credentials from database
 */
export async function getAgentProviderCredentials(params: {
  agentId: string
  provider: string
}): Promise<ProviderCredentials> {
  const { agentId, provider } = params

  if (!isValidUUID(agentId)) {
    throw new Error("Invalid agent ID")
  }

  const supabase = createServiceClient()

  // platform_credentials stores discrete columns (no `credentials` jsonb); scope is
  // agent_user_id, provider key is `platform`.
  const { data, error } = await supabase
    .from("platform_credentials")
    .select("api_key, access_token, refresh_token, config")
    .eq("agent_user_id", agentId)
    .eq("platform", provider.toLowerCase())
    .eq("is_active", true)
    .single()

  if (error || !data) {
    console.error("[System 7.1B] Provider credentials not found:", error)
    throw new Error(`Provider credentials not found for ${provider}`)
  }

  const credentials: ProviderCredentials = {
    apiKey: data.api_key,
    accessToken: data.access_token ?? undefined,
    refreshToken: data.refresh_token ?? undefined,
    profileId: (data.config as { profileId?: string } | null)?.profileId,
  }

  if (!credentials.apiKey) {
    throw new Error("Invalid provider credentials: missing apiKey")
  }

  return credentials
}

/**
 * Check if agent has provider credentials
 */
export async function hasProviderCredentials(params: {
  agentId: string
  provider: string
}): Promise<boolean> {
  try {
    await getAgentProviderCredentials(params)
    return true
  } catch {
    return false
  }
}
