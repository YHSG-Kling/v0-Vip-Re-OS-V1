"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

export type PlatformCredential = {
  id: string
  brokerage_id: string
  agent_user_id: string | null
  platform: string
  scope: string
  access_token: string | null
  api_key: string | null
  api_url: string | null
  token_expires_at: string | null
  account_id: string | null
  account_name: string | null
  is_active: boolean
  last_synced_at: string | null
  sync_error: string | null
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type ProviderOverride = {
  id: string
  scope_type: string
  scope_id: string | null
  provider_type: string
  provider_key: string
  config: Record<string, unknown>
  enabled: boolean
  created_at: string
  updated_at: string
}

async function getBrokerageId(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")
  return { userId: user.id, brokerageId: profile.brokerage_id }
}

export async function getPlatformCredentials(): Promise<PlatformCredential[]> {
  const supabase = await createClient()
  const { brokerageId } = await getBrokerageId(supabase)

  const { data, error } = await supabase
    .from("platform_credentials")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("platform")

  if (error) throw new Error(error.message)
  return (data ?? []) as PlatformCredential[]
}

export async function getProviderOverrides(): Promise<ProviderOverride[]> {
  const supabase = await createClient()
  const { brokerageId } = await getBrokerageId(supabase)

  const { data, error } = await supabase
    .from("provider_overrides")
    .select("*")
    .eq("scope_type", "brokerage")
    .eq("scope_id", brokerageId)
    .order("provider_type")

  if (error) throw new Error(error.message)
  return (data ?? []) as ProviderOverride[]
}

export async function upsertProviderOverride(params: {
  provider_type: string
  provider_key: string
  config?: Record<string, unknown>
  enabled?: boolean
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { brokerageId } = await getBrokerageId(supabase)

  const { error } = await supabase
    .from("provider_overrides")
    .upsert(
      {
        scope_type:   "brokerage",
        scope_id:     brokerageId,
        provider_type: params.provider_type,
        provider_key:  params.provider_key,
        config:        params.config ?? {},
        enabled:       params.enabled ?? true,
        updated_at:    new Date().toISOString(),
      },
      { onConflict: "scope_type,scope_id,provider_type" }
    )

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/integrations")
  return { success: true }
}

export async function upsertPlatformCredential(params: {
  platform: string
  scope?: string
  api_key?: string
  api_url?: string
  account_id?: string
  account_name?: string
  config?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { brokerageId } = await getBrokerageId(supabase)

  const { error } = await supabase
    .from("platform_credentials")
    .upsert(
      {
        brokerage_id:  brokerageId,
        owner_type:    "brokerage",
        owner_id:      brokerageId,
        platform:      params.platform,
        scope:         params.scope ?? "brokerage",
        api_key:       params.api_key ?? null,
        api_url:       params.api_url ?? null,
        account_id:    params.account_id ?? null,
        account_name:  params.account_name ?? null,
        config:        params.config ?? {},
        is_active:     true,
        updated_at:    new Date().toISOString(),
      },
      { onConflict: "brokerage_id,platform,scope" }
    )

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/integrations")
  return { success: true }
}

export async function togglePlatformCredential(
  id: string,
  isActive: boolean
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { brokerageId } = await getBrokerageId(supabase)

  const { error } = await supabase
    .from("platform_credentials")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("brokerage_id", brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/integrations")
  return { success: true }
}
