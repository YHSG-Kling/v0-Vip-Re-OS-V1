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

  const { data, error } = await supabase
    .from("platform_credentials")
    .select("credentials")
    .eq("user_id", agentId)
    .eq("provider", provider.toLowerCase())
    .eq("is_active", true)
    .single()

  if (error || !data) {
    console.error("[System 7.1B] Provider credentials not found:", error)
    throw new Error(`Provider credentials not found for ${provider}`)
  }

  const credentials = data.credentials as ProviderCredentials

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
