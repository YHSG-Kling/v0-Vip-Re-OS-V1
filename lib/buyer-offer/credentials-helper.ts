"use server"

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
