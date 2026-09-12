"use server"

// Superadmin cross-tenant subscription oversight — the "oversee every subscription" read.
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadSubscriptionOversight, type SubscriptionOversight } from "@/lib/platform/subscription-oversight"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"

async function requireSuperadmin(): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const isSuper = isPlatformSuperadminIdentity((data as any)?.user_type, (data as any)?.platform_role)
  return isSuper ? { ok: true } : { ok: false, error: "Forbidden — superadmin only" }
}

export async function getSubscriptionOversightAction(): Promise<
  | { ok: true; data: SubscriptionOversight }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  return { ok: true, data: await loadSubscriptionOversight(createServiceClient()) }
}
