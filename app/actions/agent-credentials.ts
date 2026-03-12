"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"

export type ServiceName = "idx_broker" | "ghl" | "meta" | "linkedin" | "twitter" | "tiktok"
export type ServiceType = "listing_provider" | "crm_sync" | "social_media"

interface AgentCredential {
  id: string
  agent_id: string
  service_name: ServiceName
  service_type: ServiceType
  api_key?: string
  api_secret?: string
  access_token?: string
  refresh_token?: string
  token_expires_at?: string
  config: Record<string, any>
  is_active: boolean
  is_verified: boolean
  last_verified_at?: string
  error_message?: string
}

// Get all credentials for current agent
export async function getAgentCredentials() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_api_credentials")
    .select("*")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .order("service_name")

  if (error) throw error
  return data as AgentCredential[]
}

// Get specific service credential
export async function getServiceCredential(serviceName: ServiceName) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_api_credentials")
    .select("*")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .eq("service_name", serviceName)
    .single()

  if (error && error.code !== "PGRST116") throw error // PGRST116 = not found
  return data as AgentCredential | null
}

// Save or update credentials
export async function saveServiceCredential(params: {
  serviceName: ServiceName
  serviceType: ServiceType
  apiKey?: string
  apiSecret?: string
  accessToken?: string
  refreshToken?: string
  tokenExpiresAt?: Date
  config?: Record<string, any>
}) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId) throw new Error("Not authenticated")

  const credential = {
    agent_id: agentId,
    brokerage_id: brokerageId,
    service_name: params.serviceName,
    service_type: params.serviceType,
    api_key: params.apiKey,
    api_secret: params.apiSecret,
    access_token: params.accessToken,
    refresh_token: params.refreshToken,
    token_expires_at: params.tokenExpiresAt?.toISOString(),
    config: params.config || {},
    is_active: true,
  }

  const { data, error } = await supabase
    .from("agent_api_credentials")
    .upsert(credential, { onConflict: "agent_id,service_name" })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/settings/integrations")
  return data
}

// Test/verify credential
export async function verifyServiceCredential(serviceName: ServiceName) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const credential = await getServiceCredential(serviceName)
  if (!credential) throw new Error("Credential not found")

  let isValid = false
  let errorMessage = ""

  try {
    // Test the credential based on service type
    switch (serviceName) {
      case "idx_broker":
        // Test IDX Broker API
        const idxResponse = await fetch(`https://api.idxbroker.com/clients/featured`, {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            accesskey: credential.api_key || "",
          },
        })
        isValid = idxResponse.ok
        if (!isValid) errorMessage = "IDX Broker API key invalid"
        break

      case "ghl":
        // Test GHL API
        const ghlResponse = await fetch(`https://rest.gohighlevel.com/v1/contacts/`, {
          headers: {
            Authorization: `Bearer ${credential.api_key}`,
            Version: "2021-07-28",
          },
        })
        isValid = ghlResponse.ok
        if (!isValid) errorMessage = "GHL API key invalid"
        break

      case "meta":
        // Test Meta Graph API
        const metaResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${credential.access_token}`)
        isValid = metaResponse.ok
        if (!isValid) errorMessage = "Meta access token invalid or expired"
        break

      case "linkedin":
      case "twitter":
      case "tiktok":
        // Will implement OAuth verification later
        isValid = true
        break
    }
  } catch (err: any) {
    errorMessage = err.message
  }

  // Update verification status
  const { error } = await supabase
    .from("agent_api_credentials")
    .update({
      is_verified: isValid,
      last_verified_at: new Date().toISOString(),
      error_message: isValid ? null : errorMessage,
    })
    .eq("id", credential.id)

  if (error) throw error

  revalidatePath("/settings/integrations")
  return { isValid, errorMessage }
}

// Delete credential
export async function deleteServiceCredential(serviceName: ServiceName) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { error } = await supabase
    .from("agent_api_credentials")
    .delete()
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .eq("service_name", serviceName)

  if (error) throw error

  revalidatePath("/settings/integrations")
  return { success: true }
}

// Get connection status summary
export async function getConnectionStatus() {
  const credentials = await getAgentCredentials()

  const services = {
    idx_broker: credentials.find((c) => c.service_name === "idx_broker"),
    ghl: credentials.find((c) => c.service_name === "ghl"),
    meta: credentials.find((c) => c.service_name === "meta"),
    linkedin: credentials.find((c) => c.service_name === "linkedin"),
    twitter: credentials.find((c) => c.service_name === "twitter"),
    tiktok: credentials.find((c) => c.service_name === "tiktok"),
  }

  return {
    listing_provider: {
      connected: !!services.idx_broker?.is_active,
      verified: !!services.idx_broker?.is_verified,
      service: "IDX Broker",
    },
    crm_sync: {
      connected: !!services.ghl?.is_active,
      verified: !!services.ghl?.is_verified,
      service: "GoHighLevel",
    },
    social_media: {
      facebook: !!services.meta?.is_active && !!services.meta?.config?.facebook_connected,
      instagram: !!services.meta?.is_active && !!services.meta?.config?.instagram_connected,
      linkedin: !!services.linkedin?.is_active,
      twitter: !!services.twitter?.is_active,
      tiktok: !!services.tiktok?.is_active,
    },
  }
}
