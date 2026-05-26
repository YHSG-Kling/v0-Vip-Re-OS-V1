"use server"

// CRM connect + manual "Sync now" for the user-connected CRM sync-OUT providers
// (GoHighLevel, Lofty, Follow Up Boss). Connecting stores the API key in
// integration_credentials and marks the active CRM in brokerage_integrations so the
// canonical lib/crm/sync.ts dispatch resolves it. Sync-now pushes a contact OUT through
// that same single sync layer. Broker/admin gated.

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { syncContactToCRM } from "@/lib/crm/sync"

export type CrmProvider = "gohighlevel" | "lofty" | "followupboss"
const CRM_PROVIDERS: CrmProvider[] = ["gohighlevel", "lofty", "followupboss"]

async function requireBrokerAdmin(): Promise<
  { ok: true; userId: string; brokerageId: string } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!["superadmin", "admin", "broker", "broker_owner"].includes(data?.user_type ?? "")) {
    return { ok: false, error: "Broker/admin access required" }
  }
  if (!data?.brokerage_id) return { ok: false, error: "No brokerage" }
  return { ok: true, userId: user.id, brokerageId: data.brokerage_id }
}

/** Connect (or update) a CRM by API key, and make it the active CRM for the brokerage. */
export async function connectCrmAction(params: {
  provider: CrmProvider
  apiKey: string
  apiUrl?: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!CRM_PROVIDERS.includes(params.provider)) return { ok: false, error: "Unknown CRM provider" }
  if (!params.apiKey?.trim()) return { ok: false, error: "API key is required" }
  const gate = await requireBrokerAdmin()
  if (!gate.ok) return gate
  const supabase = await createClient()

  const { error: credErr } = await supabase
    .from("integration_credentials")
    .upsert(
      {
        brokerage_id: gate.brokerageId,
        provider_name: params.provider,
        api_key: params.apiKey.trim(),
        webhook_url: params.apiUrl?.trim() || null,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "brokerage_id,provider_name" },
    )
  if (credErr) return { ok: false, error: credErr.message }

  const { error: intErr } = await supabase
    .from("brokerage_integrations")
    .upsert(
      {
        brokerage_id: gate.brokerageId,
        provider_type: "crm",
        provider_name: params.provider,
        status: "active",
        metadata: { configured_by: gate.userId },
      },
      { onConflict: "brokerage_id,provider_name" },
    )
  if (intErr) return { ok: false, error: intErr.message }

  revalidatePath("/settings/crm")
  return { ok: true }
}

/** Disconnect a CRM (deactivate its credential). */
export async function disconnectCrmAction(provider: CrmProvider): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await requireBrokerAdmin()
  if (!gate.ok) return gate
  const supabase = await createClient()
  await supabase.from("integration_credentials").update({ is_active: false }).eq("brokerage_id", gate.brokerageId).eq("provider_name", provider)
  await supabase.from("brokerage_integrations").update({ status: "inactive" }).eq("brokerage_id", gate.brokerageId).eq("provider_name", provider)
  revalidatePath("/settings/crm")
  return { ok: true }
}

/** Manually sync a single contact OUT to the active CRM (the "Sync now" button). */
export async function syncContactNowAction(contactId: string): Promise<
  { ok: true; providerKey: string; action?: string; contactId?: string } | { ok: false; error: string }
> {
  const gate = await requireBrokerAdmin()
  if (!gate.ok) return gate
  const supabase = await createClient()
  const { data: contact, error } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, brokerage_id")
    .eq("id", contactId)
    .eq("brokerage_id", gate.brokerageId)
    .maybeSingle()
  if (error || !contact) return { ok: false, error: "Contact not found in your brokerage" }

  const result = await syncContactToCRM({
    firstName: contact.first_name ?? "",
    lastName: contact.last_name ?? "",
    email: contact.email ?? undefined,
    phone: contact.phone ?? undefined,
    source: "manual-sync",
    brokerageId: gate.brokerageId,
  })
  if (!result.success) {
    return { ok: false, error: result.requiresConfiguration ? `${result.providerKey} is not connected` : (result.error ?? "Sync failed") }
  }
  return { ok: true, providerKey: result.providerKey, action: result.action, contactId: result.contactId }
}

/** Which CRM is connected/active for the brokerage. */
export async function getCrmStatusAction(): Promise<
  { ok: true; active: string | null; connected: CrmProvider[] } | { ok: false; error: string }
> {
  const gate = await requireBrokerAdmin()
  if (!gate.ok) return gate
  const supabase = await createClient()
  const { data: creds } = await supabase
    .from("integration_credentials")
    .select("provider_name, is_active")
    .eq("brokerage_id", gate.brokerageId)
    .in("provider_name", CRM_PROVIDERS)
  const { data: active } = await supabase
    .from("brokerage_integrations")
    .select("provider_name, status")
    .eq("brokerage_id", gate.brokerageId)
    .eq("provider_type", "crm")
    .eq("status", "active")
    .maybeSingle()
  const connected = (creds ?? []).filter((c) => c.is_active).map((c) => c.provider_name as CrmProvider)
  return { ok: true, active: active?.provider_name ?? null, connected }
}
